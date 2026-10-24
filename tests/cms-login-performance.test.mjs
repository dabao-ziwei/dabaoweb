import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {lazyImageProcessor} from '../cms/supabase/images.mjs';
import {createCloudHandler} from '../cms/supabase/handler.mjs';
import {sandbox} from './support/cloud-sandbox.mjs';

test('image initialization is lazy, shared and retryable without caching failures',async()=>{
    let loads=0;
    const bytes=new Uint8Array([1,2,3]),rectangles=[{x:0,y:0,width:1,height:1}];
    const images=lazyImageProcessor(async()=>{
        loads++;if(loads===1)throw Error('Temporary initialization failure');
        return {transform:(input,rects)=>({input,rects})};
    });
    assert.equal(loads,0);
    await assert.rejects(()=>images.transform(bytes),/initialization/);
    const results=await Promise.all([images.transform(bytes,rectangles),images.transform(bytes)]);
    assert.equal(loads,2);assert.equal(results[0].input,bytes);assert.equal(results[0].rects,rectangles);
});

test('login pipeline keeps both rate limits, final allowlist check and no image startup',async t=>{
    const app=await sandbox({fixtures:0});
    const origin='http://localhost:4283',base=origin+'/functions/v1/dabao-cms';
    try{
        let loads=0,activeAttempts=0,maxAttempts=0,deny='',disableAtRead=false,token='',release;
        const imageGate=new Promise(resolve=>{release=resolve;});
        const operations=[];
        const services={...app.services,rpc:async(operation,payload)=>{
            operations.push(operation);
            if(operation==='attempt'){
                activeAttempts++;maxAttempts=Math.max(maxAttempts,activeAttempts);
                await new Promise(resolve=>setTimeout(resolve,5));activeAttempts--;
                if(deny===String(payload.limit))return {allowed:false};
            }
            const result=await app.rpc(operation,payload);
            if(operation==='read'&&disableAtRead)await app.pg.query('update dabao_cms.admins set enabled=false where user_id=$1',[app.userId]);
            return result;
        }};
        const images=lazyImageProcessor(async()=>{loads++;await imageGate;return app.images;});
        const handler=createCloudHandler({services,images,origins:[origin]});
        const login=password=>handler(new Request(base+'/api/admin/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password})}));
        await t.test('health, anonymous session and public reads do not initialize WASM',async()=>{
            for(const route of ['/healthz','/api/admin/session','/api/public/content'])assert.equal((await handler(new Request(base+route))).status,200);
            assert.equal(loads,0);
        });
        await t.test('one login includes dashboard and preserves server-side checks',async()=>{
            operations.length=0;const response=await login(app.password),data=await response.json();assert.equal(response.status,200);
            assert.deepEqual(operations,['attempt','attempt','lookup','read','login']);assert.equal(maxAttempts,2);
            assert.equal(data.state.courses.length,4);assert.equal(data.authenticated,true);assert.equal(loads,0);
            assert.equal(data.access_token,undefined);assert.equal(data.refresh_token,undefined);
            token=data.token;
        });
        await t.test('either persistent rate limit blocks login before Auth/state',async()=>{
            for(const limit of ['5','20']){deny=limit;operations.length=0;assert.equal((await login(app.password)).status,429);assert.deepEqual(operations,['attempt','attempt']);}
            deny='';
        });
        await t.test('wrong password never reads dashboard or creates a session',async()=>{
            operations.length=0;const r=await login('incorrect-password');assert.equal(r.status,401);assert(!operations.includes('read'));assert(!operations.includes('login'));
        });
        await t.test('lazy upload awaits initialization, preserves job guard and reuses processor',async()=>{
            const bytes=await sharp({create:{width:40,height:60,channels:3,background:'#bcaeb8'}}).png().toBuffer();
            const upload=()=>{const form=new FormData();form.set('file',new File([bytes],'synthetic.png',{type:'image/png'}));return handler(new Request(base+'/api/admin/upload',{method:'POST',headers:{Origin:origin,Authorization:'Bearer '+token},body:form}));};
            const first=upload();
            while(!loads)await new Promise(resolve=>setTimeout(resolve,1));
            assert.equal((await upload()).status,429);release();
            assert.equal((await first).status,201);assert.equal((await upload()).status,200);assert.equal(loads,1);
        });
        await t.test('revocation during dashboard read denies bundled response',async()=>{
            disableAtRead=true;const before=(await app.pg.query('select count(*)::int n from dabao_cms.sessions')).rows[0].n;
            const r=await login(app.password);assert.equal(r.status,403);const body=await r.json();assert.equal(body.state,undefined);assert.equal(body.token,undefined);
            assert.equal((await app.pg.query('select count(*)::int n from dabao_cms.sessions')).rows[0].n,before);
        });
    }finally{await app.close();}
});
