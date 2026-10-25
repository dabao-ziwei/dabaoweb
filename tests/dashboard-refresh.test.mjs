import test from 'node:test';
import assert from 'node:assert/strict';
import {sandbox} from './support/cloud-sandbox.mjs';

test('dashboard refresh settings persist privately without publishing website content',async t=>{
    const origin='http://localhost:4283',base=origin+'/functions/v1/dabao-cms/api/',app=await sandbox({fixtures:0,metricsEnabled:true});
    const call=(route,{method='GET',data,token,source=origin}={})=>app.handler(new Request(base+route,{method,
        headers:{...(source?{Origin:source}:{}),...(token?{Authorization:'Bearer '+token}:{}),...(data?{'Content-Type':'application/json'}:{})},
        ...(data?{body:JSON.stringify(data)}:{})}));
    try{
        const login=await (await call('admin/login',{method:'POST',data:{username:'admin',password:app.password}})).json(),token=login.token;
        const state=async()=>{const response=await call('admin/state',{token});assert.equal(response.status,200);return response.json();};
        const save=(refreshMinutes,revision=0,extra={})=>call('admin/dashboard-settings',{method:'PUT',token,data:{data:{refreshMinutes},revision},...extra});
        const before=await state(),publicBefore=await (await call('public/content')).json();
        await t.test('older documents default to five minutes without any writes',async()=>{
            assert.deepEqual(login.state.dashboardSettings,{refreshMinutes:5,revision:0});
            assert.equal((await app.rpc('read')).document.dashboardSettings,undefined);
        });
        await t.test('unauthenticated and originless writes are rejected',async()=>{
            assert.equal((await save(1,0,{token:null})).status,401);
            assert.equal((await save(1,0,{source:null})).status,403);
            assert.equal((await save(1,0,{source:'https://evil.example'})).status,403);
        });
        await t.test('only integer minutes from one to sixty are accepted',async()=>{
            for(const value of [0,61,-1,1.5,'5',null])assert.equal((await save(value)).status,422);
            assert.deepEqual((await state()).dashboardSettings,{refreshMinutes:5,revision:0});
        });
        await t.test('saving takes effect immediately and survives a fresh login',async()=>{
            const result=await save(1);assert.equal(result.status,200);assert.deepEqual(await result.json(),{refreshMinutes:1,revision:1});
            const current=await state();assert.deepEqual(current.dashboardSettings,{refreshMinutes:1,revision:1});
            assert.equal(current.pending,before.pending);assert.deepEqual(current.versions,before.versions);
            for(const key of ['courses','cohorts','feedback','settings'])assert.deepEqual(current[key],before[key]);
            const again=await (await call('admin/login',{method:'POST',data:{username:'admin',password:app.password}})).json();
            assert.equal(again.state.dashboardSettings.refreshMinutes,1);
        });
        await t.test('concurrent/stale settings cannot silently overwrite a newer interval',async()=>{
            assert.equal((await save(10,0)).status,409);
            assert.equal((await save(60,1)).status,200);
            assert.deepEqual((await state()).dashboardSettings,{refreshMinutes:60,revision:2});
        });
        await t.test('private setting changes neither public content nor publishing versions',async()=>{
            assert.deepEqual(await (await call('public/content')).json(),publicBefore);
            const history=await app.rpc('history');assert.equal(history.filter(row=>row.action==='save_dashboard_settings').length,2);
            const record=await app.rpc('read');assert.equal(record.document.dashboardSettings.refreshMinutes,60);
        });
        await t.test('website publish and restore keep dashboard preferences intact',async()=>{
            const version=before.versions[0].id;
            assert.equal((await call('admin/publish',{method:'POST',token,data:{confirm:'publish'}})).status,200);
            assert.equal((await call(`admin/versions/${version}/restore`,{method:'POST',token,data:{confirm:'restore'}})).status,200);
            assert.deepEqual((await state()).dashboardSettings,{refreshMinutes:60,revision:2});
        });
    }finally{await app.close();}
});
