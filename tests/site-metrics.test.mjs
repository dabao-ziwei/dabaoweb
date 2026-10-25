import test from 'node:test';
import assert from 'node:assert/strict';
import {sandbox} from './support/cloud-sandbox.mjs';
import {createCloudHandler} from '../cms/supabase/handler.mjs';
import {pageForPath,validEvent} from '../site-metrics-catalog.mjs';

test('fixed metrics catalog never accepts identifiers, arbitrary URLs or preview paths',()=>{
    assert.equal(pageForPath('/'),'home');assert.equal(pageForPath('/admin/'),undefined);
    assert.equal(pageForPath('/course-v2-preview.html'),undefined);
    const event={page:'home',action:'click',target:'line',location:'hero'};
    assert(validEvent(event));
    for(const extra of [{email:'x@example.com'},{url:'https://example.com'},{target:'https://lin.ee/x'},{page:['home']},{target:'constructor'},{location:'unknown'},{action:'login'},{action:'view'}])assert(!validEvent({...event,...extra}));
});

test('first-party counters use isolated Postgres, never production',async t=>{
    const origin='http://localhost:4283',base=origin+'/functions/v1/dabao-cms',app=await sandbox({fixtures:0,metricsEnabled:true});
    const call=(route,{data,token,source=origin,body}={})=>app.handler(new Request(base+route,{method:data||body?'POST':'GET',
        headers:{...(source?{Origin:source}:{}),...(data||body?{'Content-Type':'text/plain;charset=UTF-8'}:{}),...(token?{Authorization:'Bearer '+token}:{})},
        ...(data||body?{body:body||JSON.stringify(data)}:{})}));
    const view={page:'home',action:'view',target:'none',location:'content'};
    const click={page:'home',action:'click',target:'line',location:'hero'};
    let token;
    try{
        const login=await app.handler(new Request(base+'/api/admin/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:app.password})}));
        assert.equal(login.status,200);token=(await login.json()).token;
        await t.test('empty report is genuine zero with no fictional start date',async()=>{
            const response=await call('/api/admin/metrics?days=7',{token});assert.equal(response.status,200);
            const data=await response.json();assert.equal(data.startedAt,null);assert.equal(data.totals.views,0);assert.equal(data.totals.clicks,0);
            assert.equal(data.pages.find(row=>row.id==='course').hits,0);
        });
        await t.test('capability opt-in is advertised and old/disabled services collect nothing',async()=>{
            assert.equal((await (await call('/api/public/content')).json()).metrics.enabled,true);
            const disabled=createCloudHandler({services:app.services,images:app.images,origins:[origin]});
            const response=await disabled(new Request(base+'/api/public/metrics',{method:'POST',headers:{Origin:origin},body:JSON.stringify(view)}));assert.equal(response.status,503);
            assert.equal((await app.pg.query('select count(*)::int n from dabao_cms.metric_daily')).rows[0].n,0);
            const publicData=await disabled(new Request(base+'/api/public/content'));assert.equal((await publicData.json()).metrics.enabled,false);
        });
        await t.test('one upsert per event, concurrent increments not lost; no content/audit writes',async()=>{
            const before=await app.rpc('read'),audit=(await app.rpc('history')).length;
            for(const data of [view,click,click])assert.equal((await call('/api/public/metrics',{data})).status,204);
            await Promise.all(Array.from({length:12},()=>call('/api/public/metrics',{data:click})));
            const report=await (await call('/api/admin/metrics?days=1',{token})).json();
            assert.equal(report.totals.views,1);assert.equal(report.totals.clicks,14);assert.equal(report.totals.line,14);
            assert(report.startedAt);assert.equal(report.rows.length,2);
            assert.deepEqual(await app.rpc('read'),before);assert.equal((await app.rpc('history')).length,audit);
            const columns=(await app.pg.query("select column_name from information_schema.columns where table_schema='dabao_cms' and table_name='metric_daily' order by ordinal_position")).rows.map(row=>row.column_name);
            assert.deepEqual(columns,['day','page','action','target','location','hits']);
        });
        await t.test('invalid/untrusted/oversized requests never increment',async()=>{
            for(const data of [{...click,email:'private'}, {...click,target:'other'}, {...click,page:['home']},[],null]){
                assert.equal((await call('/api/public/metrics',{body:JSON.stringify(data)})).status,400);
            }
            assert.equal((await call('/api/public/metrics',{data:click,source:null})).status,403);
            assert.equal((await call('/api/public/metrics',{data:click,source:'https://evil.example'})).status,403);
            assert.equal((await call('/api/public/metrics',{body:'x'.repeat(513)})).status,413);
            assert.equal((await call('/api/admin/metrics?days=365',{token})).status,400);
            assert.equal((await call('/api/admin/metrics?days=1')).status,401);
        });
        await t.test('Taipei daily totals/ranges exclude expired and future rows',async()=>{
            for(const [age,hits] of [[-1,900],[1,20],[6,30],[7,40],[29,50],[30,999]])await app.pg.query("insert into dabao_cms.metric_daily(day,page,action,target,location,hits) values(timezone('Asia/Taipei',now())::date-$1::integer,'booking','click','booking_system','content',$2)",[age,hits]);
            for(const [days,bookings] of [[1,0],[7,50],[30,140]]){
                const report=await (await call('/api/admin/metrics?days='+days,{token})).json();
                assert.equal(report.totals.booking,bookings);assert.equal(report.totals.line,14);
                assert.equal(report.from,(await app.pg.query("select (timezone('Asia/Taipei',now())::date-($1::integer-1))::text d",[days])).rows[0].d);
            }
            await app.pg.exec("update dabao_cms.metric_started set started_at=now()-interval '31 days'");
            const all=await (await call('/api/admin/metrics?days=0',{token})).json();assert.equal(all.totals.booking,1139);
        });
        await t.test('tables and RPC are not readable/callable by public or browser auth roles',async()=>{
            for(const role of ['anon','authenticated']){
                const [row]=(await app.pg.query("select has_function_privilege($1,'public.dabao_cms_metrics(text,jsonb)','execute') allowed,has_table_privilege($1,'dabao_cms.metric_daily','select') readable",[role])).rows;
                assert.equal(row.allowed,false);assert.equal(row.readable,false);
            }
        });
        await t.test('disabled/expired/idle sessions cannot read counters',async()=>{
            await app.pg.exec('update dabao_cms.admins set enabled=false');assert.equal((await call('/api/admin/metrics',{token})).status,401);
            await app.pg.exec("update dabao_cms.admins set enabled=true; update dabao_cms.sessions set touched_at=now()-interval '31 minutes'");assert.equal((await call('/api/admin/metrics',{token})).status,401);
            await app.pg.exec("update dabao_cms.sessions set remembered=true");assert.equal((await call('/api/admin/metrics',{token})).status,200);
            await app.pg.exec("update dabao_cms.sessions set expires_at=now()-interval '1 second'");assert.equal((await call('/api/admin/metrics',{token})).status,401);
        });
    }finally{await app.close();}
});
