import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import { sandbox } from './support/cloud-sandbox.mjs';
import { CloudModel } from '../cms/supabase/model.mjs';

test('Supabase CMS: real isolated Postgres migration, API lifecycle and authorization',async t=>{
    const app=await sandbox(),origin='http://localhost:4283',base=origin+'/functions/v1/dabao-cms';
    let token;
    async function call(route,method='GET',body,options={}){
        const headers={Origin:origin,...(token?{Authorization:'Bearer '+token}:{}),...options.headers};
        const form=body instanceof FormData;
        if(body&&!form)headers['Content-Type']='application/json';
        const response=await app.handler(new Request(base+route,{method,headers,...(body?{body:form?body:JSON.stringify(body)}:{})}));
        const data=response.status===304?null:response.headers.get('Content-Type')?.includes('json')?await response.json():new Uint8Array(await response.arrayBuffer());
        return {status:response.status,data,headers:response.headers};
    }
    const login=async()=>{const result=await call('/api/admin/login','POST',{username:'admin',password:app.password});assert.equal(result.status,200,JSON.stringify(result.data));token=result.data.token;return result;};
    const state=async()=>{const result=await call('/api/admin/state');assert.equal(result.status,200,JSON.stringify(result.data));return result.data;};
    const publish=async()=>{const result=await call('/api/admin/publish','POST',{confirm:'publish'});assert.equal(result.status,200,JSON.stringify(result.data));return result.data.version;};
    try{
        await t.test('migration is idempotent and touches no existing public tables',async()=>{
            const sql=await fs.readFile(new URL('../supabase/migrations/202610240001_dabao_cms.sql',import.meta.url),'utf8');await app.pg.exec(sql);
            assert.equal((await app.pg.query("select count(*)::int n from pg_tables where schemaname='public'")).rows[0].n,0);
        });
        await t.test('anon and authenticated cannot read private schema or invoke service RPC',async()=>{
            for(const role of ['anon','authenticated']){
                await app.pg.exec('set role '+role);
                await assert.rejects(()=>app.pg.query('select * from dabao_cms.content'),/permission denied/);
                await assert.rejects(()=>app.pg.query("select public.dabao_cms_backend('read')"),/permission denied/);
                await app.pg.exec('reset role');
            }
            assert.equal((await app.pg.query("select public from storage.buckets where id='dabao-cms-media'")).rows[0].public,false);
        });
        await t.test('all protected APIs reject missing/forged sessions',async()=>{
            for(const route of ['/api/admin/state','/api/admin/preview','/api/admin/history','/api/admin/media/unknown/full'])assert.equal((await call(route)).status,401);
            token='a'.repeat(64);assert.equal((await call('/api/admin/state')).status,401);token='';
            assert.equal((await call('/api/admin/session')).data.authenticated,false);
        });
        await t.test('CORS is explicit and rejects unwanted origins',async()=>{
            assert.equal((await call('/api/public/content','GET',null,{headers:{Origin:'https://attacker.example'}})).status,403);
            assert.equal((await call('/api/public/content')).headers.get('Access-Control-Allow-Origin'),origin);
        });
        await t.test('login uses Auth plus CMS allowlist; never returns provider tokens',async()=>{
            const result=await login();assert.match(token,/^[a-f0-9]{64}$/);assert.equal(result.data.access_token,undefined);
            const stored=(await app.pg.query('select token_hash from dabao_cms.sessions')).rows[0];assert.notEqual(stored.token_hash,token);
        });
        await t.test('draft/publish/preview and ETag remain consistent',async()=>{
            const before=await state(),cohort=before.cohorts[0];
            const change=await call('/api/admin/cohorts/'+cohort.id,'PUT',{data:{...cohort,regularPrice:26000},revision:cohort.revision});assert.equal(change.status,200);
            const pub=await call('/api/public/content'),draft=await call('/api/admin/preview');
            assert.equal(pub.data.cohorts[0].price,25000);assert.equal(draft.data.cohorts[0].price,26000);
            assert.equal((await call('/api/public/content','GET',null,{headers:{'If-None-Match':pub.headers.get('ETag')}})).status,304);
            await publish();assert.equal((await call('/api/public/content')).data.cohorts[0].price,26000);
            assert.equal((await call('/api/admin/cohorts/'+cohort.id,'PUT',{data:cohort,revision:cohort.revision})).status,409);
        });
        await t.test('Postgres compare-and-swap rejects lost updates',async()=>{
            const record=await app.rpc('read');const a=new CloudModel(record),b=new CloudModel(record);
            const hash=(await app.pg.query('select token_hash from dabao_cms.sessions limit 1')).rows[0].token_hash;
            await app.rpc('commit',a.commit(hash));await assert.rejects(()=>app.rpc('commit',b.commit(hash)),e=>e.status===409);
        });
        let item,oldVersion,originalMedia;
        await t.test('upload validates actual image bytes, strips metadata and stays private',async()=>{
            const invalid=new FormData();invalid.set('file',new Blob(['<svg/>'],{type:'image/png'}),'bad.png');assert.equal((await call('/api/admin/upload','POST',invalid)).status,422);
            const image=await sharp({create:{width:900,height:1200,channels:3,background:'#45b399'}}).jpeg().withMetadata({exif:{IFD0:{Artist:'PRIVATE TEST'}}}).toBuffer();
            const form=new FormData();form.set('file',new Blob([image],{type:'image/jpeg'}),'test.jpg');
            const result=await call('/api/admin/upload','POST',form);assert.equal(result.status,201,JSON.stringify(result.data));item=result.data.item;originalMedia=item.mediaId;
            assert.equal(item.isVisible,false);assert.equal((await call('/media/'+item.mediaId+'/full')).status,404);
            const full=await call('/api/admin/media/'+item.mediaId+'/full');assert.equal(full.status,200);assert.equal((await sharp(full.data).metadata()).exif,undefined);
            const duplicate=await call('/api/admin/upload','POST',form);assert.equal(duplicate.data.duplicate,true);
        });
        await t.test('publishing exposes derived images, never raw originals',async()=>{
            await call('/api/admin/feedback/'+item.id,'PUT',{data:{...item,isVisible:true,isFeatured:true},revision:item.revision});oldVersion=await publish();
            assert.equal((await call('/media/'+item.mediaId+'/full')).status,200);assert.equal((await call('/media/'+item.mediaId+'/original')).status,404);
            assert.equal((await call('/api/public/feedback?offset=0&limit=24')).data.total,7);
        });
        await t.test('redaction changes real pixels and old unsafe versions cannot restore it',async()=>{
            const redact=await call('/api/admin/media/'+item.mediaId+'/redact','POST',{rectangles:[{x:0,y:0,width:0.5,height:0.5}]});assert.equal(redact.status,201,JSON.stringify(redact.data));
            const full=await call('/api/admin/media/'+redact.data.id+'/full');const {data}=await sharp(full.data).raw().toBuffer({resolveWithObject:true});assert(data[0]<30&&data[1]<30&&data[2]<30);
            const current=(await state()).feedback.find(f=>f.id===item.id);
            await call('/api/admin/feedback/'+item.id,'PUT',{data:{...current,mediaId:redact.data.id},revision:current.revision});await publish();
            assert.equal((await call('/api/admin/versions/'+oldVersion+'/restore','POST',{confirm:'restore'})).status,422);
            assert.equal((await call('/media/'+originalMedia+'/full')).status,404);
        });
        await t.test('unpublish and soft deletion immediately remove public access',async()=>{
            let current=(await state()).feedback.find(f=>f.id===item.id);
            assert.equal((await call('/api/admin/feedback/'+item.id+'/unpublish','POST',{confirm:item.id,revision:current.revision})).status,200);
            assert.equal((await call('/media/'+current.mediaId+'/full')).status,404);
            current=(await state()).feedback.find(f=>f.id===item.id);
            assert.equal((await call('/api/admin/feedback/'+item.id,'DELETE',{confirm:item.id,revision:current.revision})).status,200);
            assert.equal((await state()).feedback.some(f=>f.id===item.id),false);assert(app.objects.has(originalMedia+'/original'));
        });
        await t.test('logout revokes the exact CMS session immediately',async()=>{
            const stolen=token;assert.equal((await call('/api/admin/logout','POST',{})).status,200);token=stolen;assert.equal((await call('/api/admin/state')).status,401);token='';await login();
        });
        await t.test('password minimum is ten; changing it revokes all CMS sessions',async()=>{
            assert.equal((await call('/api/admin/password','POST',{current:app.password,password:'123456789'})).status,422);
            assert.equal((await call('/api/admin/password','POST',{current:app.password,password:'1234567890'})).status,200);
            assert.equal((await call('/api/admin/state')).status,401);token='';
            assert.equal((await call('/api/admin/login','POST',{username:'admin',password:'1234567890'})).status,200);
        });
        await t.test('disabled administrators and idle/expired sessions are rejected',async()=>{
            token=(await call('/api/admin/login','POST',{username:'admin',password:'1234567890'})).data.token;
            await app.pg.exec("update dabao_cms.sessions set touched_at=now()-interval '31 minutes'");assert.equal((await call('/api/admin/state')).status,401);
            await app.pg.exec('update dabao_cms.admins set enabled=false');assert.equal((await call('/api/admin/login','POST',{username:'admin',password:'1234567890'})).status,401);
        });
    }finally{await app.close();}
});
