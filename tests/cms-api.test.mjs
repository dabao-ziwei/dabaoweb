import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { createCms } from '../cms/server.mjs';
import { configuration } from '../cms/config.mjs';
import { Store } from '../cms/database.mjs';
import { Media } from '../cms/media.mjs';
import { effectiveCohort } from '../cms/validation.mjs';

const exec=promisify(execFile);
test('CMS real HTTP integration, security and persistence',async t=>{
    const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'dabao-cms-test-'));
    const config=configuration({CMS_PORT:'4381',CMS_DATA_DIR:dataDir});
    const password='Test-only-secret-password-123!';
    let app=createCms(config),cookies=new Map(),csrf='';
    const start=()=>new Promise(resolve=>app.server.listen(config.port,'127.0.0.1',resolve));
    const stop=async()=>{await new Promise(resolve=>app.server.close(resolve));app.store.close();};
    await app.auth.addAdmin('testadmin',password);await start();
    t.after(async()=>{if(app.server.listening)await stop();await fs.rm(dataDir,{recursive:true,force:true});});
    async function request(route,{method='GET',data,form,anonymous=false,headers={},status=200}={}){
        const response=await fetch(config.origin+route,{method,headers:{Connection:'close',...(!anonymous?{Cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join(';'),'X-CSRF-Token':csrf}:{}),...(method!=='GET'?{Origin:config.origin}:{}),...(data!==undefined?{'Content-Type':'application/json'}:{}),...headers},body:form|| (data!==undefined?JSON.stringify(data):undefined)});
        if(!anonymous)for(const raw of response.headers.getSetCookie()){const [pair]=raw.split(';'),at=pair.indexOf('=');cookies.set(pair.slice(0,at),pair.slice(at+1));}
        const buffer=Buffer.from(await response.arrayBuffer());let json;try{json=JSON.parse(buffer.toString());}catch{}
        assert.equal(response.status,status,`${method} ${route}: ${buffer.toString().slice(0,300)}`);
        return {json,response,buffer};
    }
    const admin=async()=> (await request('/api/admin/state')).json;
    const publicData=async()=> (await request('/api/public/content',{anonymous:true})).json;
    const save=async(kind,item,changes={})=>(await request(`/api/admin/${kind}/${item.id}`,{method:'PUT',data:{data:{...item,...changes},revision:item.revision}})).json;
    const publish=async()=> (await request('/api/admin/publish',{method:'POST',data:{confirm:'publish'}})).json.version;
    let cohort,baselineVersion,priceVersion,feedback,secondFeedback,feedbackVersion;
    await t.test('anonymous reads restricted; mutations and static private paths denied',async()=>{
        for(const [route,method] of [['state','GET'],['preview','GET'],['courses','PUT'],['cohorts','PUT'],['feedback/test','DELETE'],['publish','POST'],['upload','POST'],['versions/1/restore','POST']])await request('/api/admin/'+route,{method,anonymous:true,...(method==='GET'?{}:{data:{}}),status:401});
        for(const route of ['/cms/legacy-source.json','/cms/migrations/001-initial.sql','/package.json','/.git/config','/node_modules/sharp/package.json'])await request(route,{anonymous:true,status:403});
        await request('/%zz',{anonymous:true,status:400});await request('/api/admin/login',{method:'POST',data:null,anonymous:true,status:400});
        const data=await publicData();assert.equal(data.courses.length,4);assert.equal(data.feedback,undefined);assert.equal(data.cohorts[0].regularPrice,25000);baselineVersion=data.version;
    });
    await t.test('secure login, cookie, origin and CSRF enforcement',async()=>{
        csrf=(await request('/api/admin/session')).json.csrf;
        await request('/api/admin/login',{method:'POST',data:{username:'testadmin',password},headers:{Origin:'https://evil.example'},status:403});
        const logged=await request('/api/admin/login',{method:'POST',data:{username:'testadmin',password}});csrf=logged.json.csrf;
        assert.match(logged.response.headers.getSetCookie()[0],/HttpOnly; SameSite=Strict/);
        await request('/api/admin/publish',{method:'POST',data:{confirm:'publish'},headers:{'X-CSRF-Token':'invalid'},status:403});
        cohort=(await admin()).cohorts[0];
        assert.ok(!JSON.stringify(await publicData()).includes('consentNote'));
    });
    await t.test('draft price isolated; authenticated preview; atomic publish + ETag',async()=>{
        const before=(await request('/api/public/content',{anonymous:true})).response.headers.get('etag');
        cohort=await save('cohorts',cohort,{earlyBirdEnabled:true,earlyBirdPrice:19800});
        assert.equal((await publicData()).cohorts[0].price,25000);
        assert.equal((await request('/api/admin/preview')).json.cohorts[0].price,19800);
        priceVersion=await publish();assert.equal((await publicData()).cohorts[0].price,19800);
        const after=(await request('/api/public/content',{anonymous:true})).response.headers.get('etag');assert.notEqual(after,before);
        await request('/api/public/content',{anonymous:true,headers:{'If-None-Match':after},status:304});
        await request(`/api/admin/cohorts/${cohort.id}`,{method:'PUT',data:{data:{...cohort,regularPrice:26000},revision:0},status:409});
    });
    await t.test('strict dates, money, URLs, automatic expiry and manual early bird',async()=>{
        for(const changes of [{regularPrice:-1},{regularPrice:1.2},{startDate:'2026-02-30'},{earlyBirdStart:'2027-01-02T12:00',earlyBirdEnd:'2027-01-01T12:00'},{signupUrl:'javascript:alert(1)'},{startTime:'25:00'},{enrolled:5,capacity:3}])await request(`/api/admin/cohorts/${cohort.id}`,{method:'PUT',data:{data:{...cohort,...changes},revision:cohort.revision},status:422});
        const item={...cohort,startDate:'2030-12-01',registrationDeadline:'2030-11-30',earlyBirdEnd:'2030-10-31T23:59'};
        assert.equal(effectiveCohort(item,new Date('2030-10-31T15:59:59Z')).price,19800);
        assert.equal(effectiveCohort(item,new Date('2030-10-31T16:00:00Z')).price,25000);
        assert.equal(effectiveCohort({...item,earlyBirdEnd:null},new Date('2030-11-01')).price,19800);
        assert.equal(effectiveCohort(item,new Date('2030-12-01')).open,false);
    });
    await t.test('dynamic course + featured switch + multiple simultaneous cohorts',async()=>{
        const original=(await admin()).courses[1];
        const other=(await request('/api/admin/cohorts',{method:'PUT',data:{data:{...cohort,id:undefined,courseId:original.id,name:'Isolated test cohort',startDate:'2030-12-01',registrationDeadline:'2030-11-30',isFeatured:true,sort:2}}})).json;
        await publish();const data=await publicData();assert.equal(data.cohorts.length,2);assert.equal(data.cohorts[0].id,other.id);assert.equal(data.cohorts.filter(c=>c.isFeatured).length,1);
        const course=(await request('/api/admin/courses',{method:'PUT',data:{data:{...(await admin()).courses[0],id:undefined,name:'Isolated extra course',shortName:'Extra',sort:5,isVisible:false}}})).json;
        await publish();assert.equal((await publicData()).courses.length,4);
        await save('courses',course,{isVisible:true});await publish();assert.equal((await publicData()).courses.length,5);
        const first=(await admin()).cohorts.find(c=>c.id===cohort.id);await save('cohorts',first,{status:'closed'});await publish();assert.equal((await publicData()).cohorts.find(c=>c.id===cohort.id).open,false);
        await request(`/api/admin/versions/${priceVersion}/restore`,{method:'POST',data:{confirm:'restore'}});cohort=(await admin()).cohorts.find(c=>c.id===cohort.id);
    });
    async function upload(buffer,name='test.jpeg'){
        const form=new FormData();form.set('file',new Blob([buffer],{type:'image/jpeg'}),name);
        return (await request('/api/admin/upload',{method:'POST',form,status:201})).json.item;
    }
    await t.test('validated uploads, dedup, safe dimensions, EXIF stripped; private drafts',async()=>{
        const image=await sharp({create:{width:2400,height:1200,channels:3,background:'#d02020'}}).withExif({IFD0:{Artist:'private metadata'}}).jpeg().toBuffer();
        feedback=await upload(image,'../../test.jpeg');assert.equal(feedback.consent,undefined);assert.equal(feedback.isVisible,false);
        const meta=await sharp(app.media.file(feedback.mediaId)).metadata();assert.equal(meta.width,2000);assert.equal(meta.exif,undefined);
        const form=new FormData();form.set('file',new Blob([image]),'duplicate.png');assert.equal((await request('/api/admin/upload',{method:'POST',form})).json.duplicate,true);
        assert.equal((await publicData()).feedbackCount,0);
        await request(`/media/${feedback.mediaId}/full`,{anonymous:true,status:404});
        await request(`/api/admin/media/${feedback.mediaId}/original`,{anonymous:true,status:401});
        await request(`/api/admin/media/${feedback.mediaId}/thumb`);
        for(const invalid of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),Buffer.from('not a real jpg')]){const form=new FormData();form.set('file',new Blob([invalid],{type:'image/jpeg'}),'fake.jpg');await request('/api/admin/upload',{method:'POST',form,status:422});}
        await request('/api/admin/upload',{method:'POST',data:{file:'bad'},status:400});
        const formLarge=new FormData();formLarge.set('file',new Blob([Buffer.alloc(10*1024*1024+1)]),'big.jpg');await request('/api/admin/upload',{method:'POST',form:formLarge,status:413});
        const oversized=new FormData();oversized.set('file',new Blob([Buffer.alloc(12*1024*1024)]),'oversized.jpg');await request('/api/admin/upload',{method:'POST',form:oversized,status:413});
    });
    await t.test('draft isolation and explicit publication without an extra consent workflow',async()=>{
        feedback=await save('feedback',feedback,{isVisible:true,isFeatured:true,description:'Synthetic QA image only',sort:10});
        assert.equal((await publicData()).feedbackCount,0);await publish();
        assert.equal((await publicData()).feedbackCount,1);await request(`/media/${feedback.mediaId}/full`,{anonymous:true});
        secondFeedback=await upload(await sharp({create:{width:320,height:200,channels:3,background:'#2030a0'}}).png().toBuffer(),'test2.png');
        secondFeedback=await save('feedback',secondFeedback,{isVisible:true,isFeatured:true,description:'Second synthetic image',sort:20});
        await request('/api/admin/feedback/reorder',{method:'POST',data:{id:feedback.id,revision:feedback.revision,otherId:secondFeedback.id,otherRevision:secondFeedback.revision}});
        const settings=(await admin()).settings[0];await save('settings',settings,{featuredDesktop:1,featuredMobile:1});feedbackVersion=await publish();
        assert.equal((await publicData()).featuredFeedback[0].id,secondFeedback.id);
        const list=(await request('/api/public/feedback?limit=1',{anonymous:true})).json;assert.equal(list.total,2);assert.equal(list.next,1);assert.equal(list.items[0].id,secondFeedback.id);
        assert.ok(!JSON.stringify(list).includes('consentBy'));assert.ok(!JSON.stringify(list).includes('original'));
    });
    await t.test('unpublish removes public access, original remains; rollback restores price',async()=>{
        feedback=(await admin()).feedback.find(f=>f.id===feedback.id);
        await request(`/api/admin/feedback/${feedback.id}/unpublish`,{method:'POST',data:{confirm:feedback.id,revision:feedback.revision}});
        assert.equal((await publicData()).feedbackCount,1);await request(`/media/${feedback.mediaId}/full`,{anonymous:true,status:404});await fs.access(app.media.file(feedback.mediaId,'original'));
        await request(`/api/admin/versions/${baselineVersion}/restore`,{method:'POST',data:{confirm:'restore'}});assert.equal((await publicData()).cohorts[0].price,25000);
        await request(`/api/admin/versions/${feedbackVersion}/restore`,{method:'POST',data:{confirm:'restore'}});assert.equal((await publicData()).feedbackCount,2);
    });
    await t.test('redaction produces different opaque pixels; rollback never restores replaced images',async()=>{
        const redacted=(await request(`/api/admin/media/${feedback.mediaId}/redact`,{method:'POST',data:{rectangles:[{x:0.1,y:0.1,width:0.5,height:0.5}]},status:201})).json;
        assert.notEqual(redacted.id,feedback.mediaId);
        const {data,info}=await sharp(app.media.file(redacted.id)).raw().toBuffer({resolveWithObject:true});const offset=(Math.floor(info.height*.3)*info.width+Math.floor(info.width*.3))*info.channels;assert.ok(data[offset]<40&&data[offset+1]<40);
        feedback=(await admin()).feedback.find(f=>f.id===feedback.id);feedback=await save('feedback',feedback,{mediaId:redacted.id});
        await request(`/api/admin/versions/${feedbackVersion}/restore`,{method:'POST',data:{confirm:'restore'},status:422});
        await publish();
        await request(`/media/${redacted.id}/full`,{anonymous:true});
    });
    await t.test('audit records, process lock, persistent restart and full backup/restore',async()=>{
        const before=await publicData();const logs=(await request('/api/admin/history')).json;assert.ok(logs.some(l=>l.action==='publish'&&l.before_json&&l.after_json));assert.ok(logs.some(l=>l.action==='restore'));
        assert.throws(()=>createCms(config),/正在使用/);
        const backupDir=path.join(dataDir,'backups','test');const env={...process.env,CMS_DATA_DIR:dataDir,CMS_PORT:String(config.port)};
        await exec(process.execPath,['cms/cli.mjs','backup','--to',backupDir],{cwd:config.root,env});
        await assert.rejects(exec(process.execPath,['cms/cli.mjs','restore','--from',backupDir,'--confirm-replace'],{cwd:config.root,env}),/正在使用/);
        await stop();
        app=createCms({...config,root:config.root});await start();assert.deepEqual(await publicData(),before);await stop();
        await exec(process.execPath,['cms/cli.mjs','restore','--from',backupDir,'--confirm-replace'],{cwd:config.root,env});
        app=createCms(config);await start();assert.deepEqual(await publicData(),before);await request('/api/admin/state',{status:401});
    });
    await t.test('legacy consent data is removed without changing publication, media or ordering',async()=>{
        const migrationConfig={...config,dataDir:path.join(dataDir,'legacy-migration')};
        let legacy=new Store(migrationConfig);
        const image=await new Media(legacy).add(await sharp({create:{width:32,height:32,channels:3,background:'#6484a4'}}).png().toBuffer(),'legacy.png','fixture');
        const item=legacy.save('feedback',null,{mediaId:image.id,description:'Legacy fixture',sort:7,isFeatured:true,isVisible:true},null,'fixture');
        legacy.save('feedback',null,{mediaId:image.id,description:'Unpublished fixture',sort:8,isFeatured:false,isVisible:false},null,'fixture');
        legacy.publish('fixture');
        const old={...JSON.parse(legacy.row('feedback',item.id).draft_json),consent:false,consentNote:'obsolete fixture',consentMediaId:image.id,consentAt:'2026-01-01',consentBy:'fixture'};
        legacy.db.prepare('UPDATE feedback SET draft_json=?,published_json=? WHERE id=?').run(JSON.stringify(old),JSON.stringify(old),item.id);
        const version=legacy.db.prepare('SELECT * FROM versions ORDER BY id DESC LIMIT 1').get();
        const snapshot=JSON.parse(version.snapshot_json);snapshot.feedback[0]=old;
        legacy.db.prepare('UPDATE versions SET snapshot_json=? WHERE id=?').run(JSON.stringify(snapshot),version.id);
        legacy.audit('fixture','save_draft','feedback',item.id,old,old);
        legacy.db.prepare('DELETE FROM schema_migrations WHERE version=2').run();legacy.close();
        legacy=new Store(migrationConfig);
        assert.equal(legacy.publicData().feedbackCount,1);assert.equal(legacy.publicData().featuredFeedback[0].sort,7);assert.equal(legacy.publicData().featuredFeedback[0].mediaId,image.id);
        assert.ok(!Object.hasOwn(legacy.adminData(),'consentPending'));
        for(const row of legacy.rows('feedback'))for(const raw of [row.draft_json,row.published_json])if(raw)assert.ok(!Object.keys(JSON.parse(raw)).some(key=>key.startsWith('consent')));
        assert.ok(!legacy.db.prepare('SELECT snapshot_json FROM versions WHERE id=?').get(version.id).snapshot_json.includes('consent'));
        const log=legacy.db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 1').get();assert.ok(!log.before_json.includes('consent')&&!log.after_json.includes('consent'));
        const before=legacy.publicData();legacy.close();legacy=new Store(migrationConfig);assert.deepEqual(legacy.publicData(),before);legacy.close();
    });
    await t.test('persistent failed-login throttling and logout invalidates session',async()=>{
        cookies=new Map();csrf=(await request('/api/admin/session')).json.csrf;
        for(let i=0;i<5;i++)await request('/api/admin/login',{method:'POST',data:{username:'attacker',password:'wrong'},status:401});
        await request('/api/admin/login',{method:'POST',data:{username:'attacker',password:'wrong'},status:429});
        csrf=(await request('/api/admin/session')).json.csrf;csrf=(await request('/api/admin/login',{method:'POST',data:{username:'testadmin',password}})).json.csrf;
        await request('/api/admin/logout',{method:'POST',data:{}});await request('/api/admin/state',{status:401});
    });
    await t.test('idle session expiry and password rotation revoke existing sessions',async()=>{
        csrf=(await request('/api/admin/session')).json.csrf;csrf=(await request('/api/admin/login',{method:'POST',data:{username:'testadmin',password}})).json.csrf;
        app.store.db.prepare('UPDATE sessions SET last_seen=?').run(Date.now()-31*60000);
        await request('/api/admin/state',{status:401});
        csrf=(await request('/api/admin/session')).json.csrf;csrf=(await request('/api/admin/login',{method:'POST',data:{username:'testadmin',password}})).json.csrf;
        await request('/api/admin/password',{method:'POST',data:{current:password,password:'Short123!'},status:422});
        const newPassword='TestPass10';assert.equal(newPassword.length,10);await request('/api/admin/password',{method:'POST',data:{current:password,password:newPassword}});await request('/api/admin/state',{status:401});
        csrf=(await request('/api/admin/session')).json.csrf;csrf=(await request('/api/admin/login',{method:'POST',data:{username:'testadmin',password:newPassword}})).json.csrf;await request('/api/admin/state');
        const row=app.store.db.prepare('SELECT password_hash FROM admins WHERE username=?').get('testadmin');assert.match(row.password_hash,/^scrypt:65536:/);assert.ok(!row.password_hash.includes(newPassword));
        assert.throws(()=>configuration({NODE_ENV:'production',CMS_ORIGIN:'http://not-https.test'}),/HTTPS/);
    });
});
