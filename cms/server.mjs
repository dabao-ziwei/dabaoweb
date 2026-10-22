import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { configuration } from './config.mjs';
import { Store } from './database.mjs';
import { Auth, passwordHash, verifyPassword } from './auth.mjs';
import { Media } from './media.mjs';
import { seed } from './seed.mjs';
import { HttpError, fail, kinds } from './validation.mjs';
import { acquireLock } from './lock.mjs';

const mime={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.jpeg':'image/jpeg','.jpg':'image/jpeg','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml','.ico':'image/x-icon','.txt':'text/plain; charset=utf-8','.xml':'application/xml; charset=utf-8'};
const etag=value=>'"'+createHash('sha256').update(value).digest('hex')+'"';
function json(response,status,data) { response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});response.end(JSON.stringify(data)); }
async function body(request,limit=128*1024) {
    return new Promise((resolve,reject)=>{
        let length=0,failed=false;const chunks=[];
        request.on('data',chunk=>{if(failed)return;length+=chunk.length;if(length>limit){failed=true;chunks.length=0;}else chunks.push(chunk);});
        request.once('end',()=>{if(failed)reject(new HttpError(413,'資料過大'));else resolve(Buffer.concat(chunks));});
        request.once('error',reject);request.once('aborted',()=>reject(new HttpError(400,'上傳已中斷')));
    });
}
async function input(request) { if(!request.headers['content-type']?.startsWith('application/json')) fail('請使用 JSON 格式',415);try {const data=JSON.parse((await body(request)).toString());if(!data||typeof data!=='object'||Array.isArray(data))fail('JSON 必須為物件',400);return data;}catch(error){if(error.status)throw error;fail('JSON 格式錯誤',400);} }

export function createCms(config=configuration()) {
    process.umask(0o077);
    const unlock=acquireLock(config.dataDir);
    let store;
    try {store=new Store(config);seed(store);}catch(error){store?.close();unlock();throw error;}
    const auth=new Auth(store),media=new Media(store);
    let imageJobs=0;
    const server=http.createServer(async(request,response)=>{
        response.setHeader('X-Content-Type-Options','nosniff');
        response.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
        response.setHeader('X-Frame-Options','SAMEORIGIN');
        let url;
        try {url=new URL(request.url,config.origin);}catch{return json(response,400,{error:'網址格式不正確'});}
        const route=url.pathname;
        const method=request.method;
        const requestOrigin=request.headers.origin;
        if(requestOrigin && config.publicOrigins.includes(requestOrigin) && route.startsWith('/api/public/')) {
            response.setHeader('Access-Control-Allow-Origin',requestOrigin);response.setHeader('Vary','Origin');
            response.setHeader('Access-Control-Allow-Headers','If-None-Match');response.setHeader('Access-Control-Expose-Headers','ETag');
        }
        try {
            if(method==='OPTIONS'&&route.startsWith('/api/public/')){response.writeHead(204);response.end();return;}
            if(route==='/admin'||route.startsWith('/admin/')||route.startsWith('/api/admin/')) {
                response.setHeader('X-Robots-Tag','noindex, nofollow');
                response.setHeader('Cache-Control','no-store');
                response.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'");
            }
            if(method==='GET'&&route==='/healthz')return json(response,200,{ok:true});
            if(method==='GET'&&route==='/cms-config.js') {
                response.writeHead(200,{'Content-Type':mime['.js'],'Cache-Control':'no-store'});
                response.end(`window.DabaoCmsConfig=${JSON.stringify({enabled:true,apiBase:config.origin,pollSeconds:60})};window.DabaoCmsPreview=new URLSearchParams(location.search).get('cms-preview')==='1';`);return;
            }
            if(method==='GET'&&route==='/api/admin/session')return json(response,200,auth.bootstrap(request,response));
            if(method==='POST'&&route==='/api/admin/login')return json(response,200,await auth.login(request,response,await input(request)));
            if(method==='POST'&&route==='/api/admin/logout'){auth.logout(request,response);return json(response,200,{ok:true});}
            if(route.startsWith('/api/public/')&&method==='GET') {
                const data=store.publicData();
                let result;
                if(route==='/api/public/content') {const {feedback,...content}=data;result=content;}
                else if(route==='/api/public/feedback') {
                    const offset=Number(url.searchParams.get('offset')||0),limit=Number(url.searchParams.get('limit')||24);
                    if(!Number.isInteger(offset)||offset<0||offset>100000||!Number.isInteger(limit)||limit<1||limit>60)fail('分頁參數不正確');
                    result={version:data.version,total:data.feedbackCount,items:data.feedback.slice(offset,offset+limit),next:offset+limit<data.feedbackCount?offset+limit:null};
                } else fail('找不到 API',404);
                const raw=JSON.stringify(result),tag=etag(raw);
                response.setHeader('ETag',tag);response.setHeader('Cache-Control','no-cache, must-revalidate');
                if(request.headers['if-none-match']===tag){response.writeHead(304);response.end();return;}
                response.writeHead(200,{'Content-Type':mime['.json']});response.end(raw);return;
            }
            const mediaRoute=route.match(/^\/(api\/admin\/)?media\/([a-z0-9-]{1,100})\/(full|thumb|original)$/);
            if(mediaRoute&&method==='GET') {
                const [,privatePrefix,id,variant]=mediaRoute;
                if(privatePrefix)auth.require(request);
                else if(variant==='original'||!store.publicMediaActive(id))fail('圖片未公開',404);
                const row=store.db.prepare('SELECT * FROM media WHERE id=?').get(id);
                if(!row)fail('找不到圖片',404);
                const buffer=await fsp.readFile(media.file(id,variant));
                response.setHeader('Cache-Control',privatePrefix?'no-store':'no-cache, must-revalidate');
                if(privatePrefix)response.setHeader('Cross-Origin-Resource-Policy','same-origin');
                response.setHeader('Content-Type',variant==='original'?'application/octet-stream':'image/webp');
                if(variant==='original')response.setHeader('Content-Disposition','attachment; filename="original.bin"');
                response.end(buffer);return;
            }
            if(route.startsWith('/api/admin/')) {
                const session=auth.require(request,!['GET','HEAD'].includes(method));
                const actor=session.username;
                if(method==='GET'&&route==='/api/admin/state')return json(response,200,store.adminData());
                if(method==='GET'&&route==='/api/admin/preview')return json(response,200,store.publicData({draft:true}));
                if(method==='GET'&&route==='/api/admin/history')return json(response,200,store.db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200').all());
                if(method==='POST'&&route==='/api/admin/publish') {
                    const data=await input(request);
                    if(data.confirm!=='publish')fail('請確認發布');
                    return json(response,200,{version:store.publish(actor)});
                }
                const restoreRoute=route.match(/^\/api\/admin\/versions\/(\d+)\/restore$/);
                if(method==='POST'&&restoreRoute) {
                    const data=await input(request);if(data.confirm!=='restore')fail('請確認版本還原');
                    return json(response,200,{version:store.restore(Number(restoreRoute[1]),actor)});
                }
                if(method==='POST'&&route==='/api/admin/password') {
                    const data=await input(request);
                    if(typeof data.current!=='string'||data.current.length>128)fail('目前密碼錯誤',401);
                    const admin=store.db.prepare('SELECT password_hash FROM admins WHERE id=?').get(session.admin_id);
                    if(!(await verifyPassword(data.current,admin.password_hash)))fail('目前密碼錯誤',401);
                    const hashed=await passwordHash(data.password);
                    store.transaction(()=>{store.db.prepare('UPDATE admins SET password_hash=? WHERE id=?').run(hashed,session.admin_id);store.db.prepare('DELETE FROM sessions WHERE admin_id=?').run(session.admin_id);store.audit(actor,'change_password','auth',session.admin_id,null,null);});
                    return json(response,200,{ok:true,loginRequired:true});
                }
                if(method==='POST'&&route==='/api/admin/upload') {
                    if(imageJobs>=2)fail('圖片正在處理，請稍後再試',429);
                    imageJobs++;
                    try {
                    const buffer=await body(request,config.maxUpload+64*1024);
                    let form;
                    try {form=await new Request(config.origin,{method:'POST',headers:{'Content-Type':request.headers['content-type']||''},body:buffer}).formData();}catch{fail('圖片上傳格式不正確',400);}
                    const file=form.get('file');
                    if(!file||typeof file.arrayBuffer!=='function')fail('請選擇圖片');
                    const image=await media.add(Buffer.from(await file.arrayBuffer()),file.name,actor);
                    const existing=store.rows('feedback').find(row=>JSON.parse(row.draft_json).mediaId===image.id);
                    if(existing)return json(response,200,{duplicate:true,item:store.item(existing)});
                    const item=store.save('feedback',null,{mediaId:image.id,description:'',sort:store.rows('feedback',true).length+1,isVisible:false,isFeatured:false},null,actor);
                    return json(response,201,{item,duplicate:false});
                    } finally {imageJobs--;}
                }
                const redactRoute=route.match(/^\/api\/admin\/media\/([a-z0-9-]{1,100})\/redact$/);
                if(method==='POST'&&redactRoute){const data=await input(request);return json(response,201,await media.redact(redactRoute[1],data.rectangles,actor));}
                if(method==='POST'&&route==='/api/admin/feedback/reorder')return json(response,200,store.reorderFeedback(await input(request),actor));
                const entityRoute=route.match(/^\/api\/admin\/(courses|cohorts|feedback|settings)(?:\/([a-z0-9-]{1,100}))?(?:\/(unpublish))?$/);
                if(entityRoute) {
                    const [,kind,id,action]=entityRoute;
                    if(method==='PUT'&&!action) {
                        const data=await input(request);
                        return json(response,200,store.save(kind,id||null,data.data,data.revision,actor));
                    }
                    if((method==='DELETE'&&!action)||(method==='POST'&&action==='unpublish')) {
                        const data=await input(request);if(data.confirm!==id)fail('請確認此操作');
                        return json(response,200,{version:store.remove(kind,id,actor,data.revision,method==='DELETE')});
                    }
                }
                fail('找不到 API',404);
            }
            if(route.startsWith('/api/'))fail('找不到 API',404);
            if(!['GET','HEAD'].includes(method))fail('不允許此方法',405);
            if(route.startsWith('/admindashboard/')){response.writeHead(302,{Location:'/admin/'});response.end();return;}
            let decoded;
            try {decoded=decodeURIComponent(route);}catch{fail('網址格式不正確',400);}
            let relative=route==='/'?'index.html':route==='/admin'||route==='/admin/'?'admin/index.html':decoded.replace(/^\//,'');
            if(relative.split('/').some(part=>part==='..'||part.startsWith('.'))||relative.includes('\\')||relative.includes('\0'))fail('無法存取此檔案',403);
            const extension=path.extname(relative);
            if(!mime[extension]||relative.startsWith('cms/')||relative.startsWith('node_modules/')||relative.startsWith('tests/')||relative==='package.json'||relative==='package-lock.json')fail('無法存取此檔案',403);
            const target=path.resolve(config.root,relative);
            if(!target.startsWith(config.root+path.sep))fail('無法存取此檔案',403);
            const real=await fsp.realpath(target);
            if(!real.startsWith(config.root+path.sep))fail('無法存取此檔案',403);
            const buffer=await fsp.readFile(real);
            if(url.searchParams.get('cms-preview')==='1')response.setHeader('X-Robots-Tag','noindex, nofollow');
            response.setHeader('Content-Type',mime[extension]);response.setHeader('Cache-Control','no-cache');
            response.end(method==='HEAD'?undefined:buffer);
        } catch(error) {
            if(response.headersSent){response.destroy();return;}
            const status=error.status||(['ENOENT','ENOTDIR'].includes(error.code)?404:500);
            if(status===413)response.setHeader('Connection','close');
            if(status===500)console.error('CMS request failed:',error.message);
            json(response,status,{error:status===500?'服務發生錯誤，請稍後再試':error.message});
        }
    });
    server.requestTimeout=30000;server.headersTimeout=10000;server.maxConnections=100;server.maxRequestsPerSocket=100;
    server.once('close',unlock);server.once('error',unlock);
    return {server,store,auth,media};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
    const config=configuration();
    const app=createCms(config);
    app.server.listen(config.port,config.host,()=>console.log(`CMS: ${config.origin}/admin/\n網站: ${config.origin}/index.html\n資料: ${config.dataDir}`));
    const stop=()=>app.server.close(()=>{app.store.close();process.exit(0);});
    process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
