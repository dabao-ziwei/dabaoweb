import http from 'node:http';
import { Readable } from 'node:stream';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import { sandbox } from './support/cloud-sandbox.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.ico':'image/x-icon'};
export async function previewServer({port=4283,apiPort=4284,password,packageDirectory}={}){
    const origin=`http://localhost:${port}`,apiOrigin=`http://localhost:${apiPort}`;
    const app=await sandbox({origins:[origin],port,packageDirectory,fixtures:packageDirectory?0:6});
    if(password)await app.services.changePassword('local-admin@example.invalid',app.password,password,app.userId);
    const api=http.createServer(async(req,res)=>{
        try{
            const request=new Request(apiOrigin+req.url,{method:req.method,headers:req.headers,...(!['GET','HEAD'].includes(req.method)?{body:Readable.toWeb(req),duplex:'half'}:{})});
            const response=await app.handler(request);
            res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
        }catch{res.writeHead(500);res.end('Local QA server error');}
    });
    const web=http.createServer(async(req,res)=>{
        try{
            const url=new URL(req.url,origin),decoded=decodeURIComponent(url.pathname);
            if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return;}
            res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
            if(decoded==='/cms-config.js'){
                res.setHeader('Content-Type',mime['.js']);res.end(`window.DabaoCmsConfig=${JSON.stringify({enabled:true,provider:'supabase',apiBase:apiOrigin+'/functions/v1/dabao-cms',pollSeconds:60})};window.DabaoCmsPreview=new URLSearchParams(location.search).get('cms-preview')==='1';`);return;
            }
            const relative=decoded==='/'?'index.html':decoded==='/admin/'?'admin/index.html':decoded.slice(1);
            if(relative.split('/').some(p=>p==='..'||p.startsWith('.'))||/^(cms|supabase|tests|node_modules)\//.test(relative)||!mime[path.extname(relative)])throw new Error('Not found');
            const file=await fs.realpath(path.join(root,relative));if(!file.startsWith(root))throw new Error('Not found');
            let bytes=await fs.readFile(file);
            if(relative==='admin/index.html')bytes=Buffer.from(bytes.toString().replace("connect-src 'self' https://uwktzlxlduqyjyoolgrs.supabase.co;",`connect-src 'self' https://uwktzlxlduqyjyoolgrs.supabase.co ${apiOrigin};`));
            res.setHeader('Content-Type',mime[path.extname(relative)]);res.end(req.method==='HEAD'?undefined:bytes);
        }catch{res.writeHead(404);res.end('Not found');}
    });
    await new Promise((resolve,reject)=>{api.once('error',reject);api.listen(apiPort,'127.0.0.1',resolve);});
    try{await new Promise((resolve,reject)=>{web.once('error',reject);web.listen(port,'127.0.0.1',resolve);});}
    catch(error){await new Promise(resolve=>api.close(resolve));await app.close();throw error;}
    return {...app,origin,apiOrigin,async close(){await new Promise(resolve=>web.close(resolve));await new Promise(resolve=>api.close(resolve));await app.close();}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
    const password=randomBytes(8).toString('base64url').slice(0,10);
    const app=await previewServer({password,packageDirectory:process.env.CMS_REVIEW_PACKAGE});
    const privateDir=path.join(os.homedir(),'Library','Application Support','DabaoCMS-Supabase-Local-Review');
    await fs.mkdir(privateDir,{recursive:true,mode:0o700});
    const credentials=path.join(privateDir,'local-preview-login.txt');
    await fs.writeFile(credentials,`本機隔離驗收專用，不是 Supabase 或正式站帳密\nURL: ${app.origin}/admin/\n帳號: admin\n密碼: ${password}\n`,{mode:0o600});
    console.log(`本機 Supabase 串接驗收：${app.origin}/admin/\n隔離 Postgres / 私有媒體；Auth 為本機測試替身，不連正式資料\n登入資料：${credentials}\n本輪變更只存在記憶體，重啟重新匯入，不影響來源 SQLite 或正式 Supabase`);
    const stop=async()=>{await app.close();process.exit(0);};process.once('SIGINT',stop);process.once('SIGTERM',stop);
}
