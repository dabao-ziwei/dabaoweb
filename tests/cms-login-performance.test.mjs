import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {lazyImageProcessor} from '../cms/supabase/images.mjs';
import {createCloudHandler} from '../cms/supabase/handler.mjs';
import {sandbox} from './support/cloud-sandbox.mjs';

test('image initialization is lazy, shared and retryable without caching failures',async()=>{
    let loads=0;
    const images=lazyImageProcessor(async()=>{loads++;if(loads===1)throw Error('Temporary initialization failure');return {transform:input=>input};});
    const bytes=new Uint8Array([1,2,3]);assert.equal(loads,0);
    await assert.rejects(()=>images.transform(bytes),/initialization/);
    assert.deepEqual(await Promise.all([images.transform(bytes),images.transform(bytes)]),[bytes,bytes]);assert.equal(loads,2);
});

test('optimized login, remembered sessions, short cooldown and direct public images',async t=>{
    const app=await sandbox(),origin='http://localhost:4283',base=origin+'/functions/v1/dabao-cms';
    let loads=0,disabledAtFinish=false,objectReads=0;
    const operations=[];
    const services={...app.services,async getObject(...args){objectReads++;return app.services.getObject(...args);},rpc:async(operation,payload)=>{
        operations.push(operation);
        if(operation==='login_finish'&&disabledAtFinish)await app.pg.exec('update dabao_cms.admins set enabled=false');
        return app.rpc(operation,payload);
    }};
    const images=lazyImageProcessor(async()=>{loads++;return app.images;});
    const handler=createCloudHandler({services,images,origins:[origin]});
    const call=(route,{method='GET',data,token,cookie,source=origin}={})=>handler(new Request(base+route,{method,headers:{...(source?{Origin:source}:{}),...(data?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{}),...(cookie?{Cookie:cookie}:{})},...(data?{body:JSON.stringify(data)}:{})}));
    const login=(password=app.password,remember=false)=>call('/api/admin/login',{method:'POST',data:{username:'admin',password,remember}});
    let token,cookie;
    try{
        await t.test('health, anonymous session and public reads do not initialize WASM',async()=>{
            for(const route of ['/healthz','/api/admin/session','/api/public/content'])assert.equal((await call(route)).status,200);assert.equal(loads,0);
        });
        await t.test('login is two DB calls plus Auth; response includes populated dashboard',async()=>{
            operations.length=0;const response=await login(),data=await response.json();assert.equal(response.status,200,JSON.stringify(data));
            assert.deepEqual(operations,['login_prepare','login_finish']);assert.equal(data.state.courses.length,4);assert.equal(loads,0);
            assert.equal(data.access_token,undefined);assert.equal(data.refresh_token,undefined);token=data.token;
            assert.match(response.headers.get('Set-Cookie'),/Max-Age=0/);
        });
        await t.test('wrong passwords never read dashboard or create a session; cooldown <=60 seconds',async()=>{
            for(let n=0;n<5;n++){operations.length=0;assert.equal((await login('wrong')).status,401);assert.deepEqual(operations,['login_prepare']);}
            const blocked=await login();assert.equal(blocked.status,429);assert(Number(blocked.headers.get('Retry-After'))<=60);
            await app.pg.exec("update dabao_cms.login_attempts set started_at=now()-interval '61 seconds'");assert.equal((await login()).status,200);
        });
        await t.test('successful logins reset account failures without resetting IP protection',async()=>{
            for(let n=0;n<4;n++){assert.equal((await login('wrong')).status,401);assert.equal((await login()).status,200);}
            assert.equal((await app.pg.query('select count(*)::int n from dabao_cms.login_attempts')).rows[0].n,1);
            await app.pg.exec('update dabao_cms.login_attempts set attempts=30');assert.equal((await login()).status,429);
            await app.pg.exec('delete from dabao_cms.login_attempts');
        });
        await t.test('parallel reservations allow no more than five account attempts',async()=>{
            const results=await Promise.all(Array.from({length:8},()=>login('wrong')));assert.equal(results.filter(r=>r.status===401).length,5);assert.equal(results.filter(r=>r.status===429).length,3);
            await app.pg.exec('delete from dabao_cms.login_attempts');
        });
        await t.test('remember uses HttpOnly Secure partitioned cookie, survives idle, expires at30days',async()=>{
            const response=await login(app.password,true),data=await response.json();token=data.token;
            const set=response.headers.get('Set-Cookie');for(const flag of ['HttpOnly','Secure','SameSite=None','Partitioned','Max-Age=2592000'])assert(set.includes(flag));cookie=set.split(';')[0];
            await app.pg.exec("update dabao_cms.sessions set touched_at=now()-interval '2 days'");
            operations.length=0;const restored=await call('/api/admin/session',{cookie}),bundle=await restored.json();assert.equal(bundle.authenticated,true);assert.equal(bundle.state.feedback.length,6);assert.deepEqual(operations,['session_bundle']);
            assert.equal((await call('/api/admin/state',{cookie})).status,200);
            await app.pg.exec("update dabao_cms.sessions set expires_at=now()-interval '1 second'");
            const expired=await call('/api/admin/session',{cookie});assert.equal((await expired.json()).authenticated,false);assert.match(expired.headers.get('Set-Cookie'),/Max-Age=0/);
        });
        await t.test('ordinary sessions still enforce idle timeout; logout revokes remembered cookie',async()=>{
            const ordinary=await (await login()).json();await app.pg.exec("update dabao_cms.sessions set touched_at=now()-interval '31 minutes'");assert.equal((await call('/api/admin/state',{token:ordinary.token})).status,401);
            const remembered=await login(app.password,true);cookie=remembered.headers.get('Set-Cookie').split(';')[0];
            assert.equal((await call('/api/admin/logout',{method:'POST',data:{},cookie,source:null})).status,403);
            const logout=await call('/api/admin/logout',{method:'POST',data:{},cookie});assert.equal(logout.status,200);assert.match(logout.headers.get('Set-Cookie'),/Max-Age=0/);assert.equal((await call('/api/admin/state',{cookie})).status,401);
        });
        await t.test('direct images and old image redirects perform zero database/session/Storage-proxy calls',async()=>{
            token=(await (await login()).json()).token;const id=(await app.rpc('read')).document.media[0].id;
            for(const route of ['/media/'+id+'/thumb','/api/admin/media/'+id+'/full']){operations.length=0;const r=await call(route);assert.equal(r.status,302);assert(r.headers.get('Location').startsWith(services.publicMediaBase));assert.deepEqual(operations,[]);}
            const first=await app.storage(new Request(services.publicMediaBase+'/'+id+'/thumb.webp'));
            const cached=await app.storage(new Request(services.publicMediaBase+'/'+id+'/thumb.webp',{headers:{'If-None-Match':first.headers.get('ETag')}}));
            assert.equal(cached.status,304);assert.equal(objectReads,0);assert.match(first.headers.get('Cache-Control'),/max-age=86400/);
            assert.equal((await call('/media/'+id+'/original')).status,404);assert.equal((await call('/api/admin/media/'+id+'/original')).status,401);
        });
        await t.test('image transformer remains lazy and upload works',async()=>{
            const bytes=await sharp({create:{width:40,height:60,channels:3,background:'#bcaeb8'}}).png().toBuffer();const form=new FormData();form.set('file',new File([bytes],'synthetic.png',{type:'image/png'}));
            const result=await handler(new Request(base+'/api/admin/upload',{method:'POST',headers:{Origin:origin,Authorization:'Bearer '+token},body:form}));assert.equal(result.status,201);assert.equal(loads,1);
        });
        await t.test('disabled member before final transaction receives no session or data',async()=>{
            disabledAtFinish=true;const before=(await app.pg.query('select count(*)::int n from dabao_cms.sessions')).rows[0].n;
            const response=await login(),data=await response.json();assert.equal(response.status,403);assert.equal(data.state,undefined);assert.equal(data.token,undefined);assert.equal((await app.pg.query('select count(*)::int n from dabao_cms.sessions')).rows[0].n,before);
        });
        await t.test('legacy gateway remains inaccessible to client roles and service-role direct calls',async()=>{
            for(const role of ['anon','authenticated','service_role']){await app.pg.exec('set role '+role);await assert.rejects(()=>app.pg.query("select public.dabao_cms_backend_legacy('read')"),/permission denied/);await app.pg.exec('reset role');}
        });
    }finally{await app.close();}
});
