import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import https from 'node:https';
import os from 'node:os';
import {Readable} from 'node:stream';
import {sandbox} from './support/cloud-sandbox.mjs';
import {createCloudHandler} from '../cms/supabase/handler.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(new URL('../',import.meta.url).pathname);
const output=path.resolve(process.env.QA_OUTPUT||'test-results/cms-access-media');await fs.mkdir(output,{recursive:true});
const site='https://cms-review.test:4485',api='https://cms-api.test:4486',calls=[],errors=[];
const app=await sandbox({fixtures:30,origins:[site],publicMediaBase:api+'/storage/v1/object/public/dabao-cms-public'});
let proxiedReads=0,databaseCalls=0;
const services={...app.services,async rpc(...args){databaseCalls++;return app.services.rpc(...args);},async getObject(...args){proxiedReads++;return app.services.getObject(...args);}};
const handler=createCloudHandler({services,images:app.images,origins:[site]});
const tlsDir=await fs.mkdtemp(path.join(os.tmpdir(),'cms-cookie-qa-'));
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',tlsDir+'/key.pem','-out',tlsDir+'/cert.pem','-days','1','-subj','/CN=cms-review.test'],{stdio:'ignore'});
const tls={key:await fs.readFile(tlsDir+'/key.pem'),cert:await fs.readFile(tlsDir+'/cert.pem')};
const web=https.createServer(tls,async(req,res)=>{
    try{
        const url=new URL(req.url,site),file=url.pathname==='/admin/'?'admin/index.html':decodeURIComponent(url.pathname).slice(1);
        if(file==='favicon.ico'){res.writeHead(204);res.end();return;}
        if(file==='cms-config.js'){res.setHeader('Content-Type','text/javascript');res.end(`window.DabaoCmsConfig={enabled:true,provider:'supabase',apiBase:'${api}/functions/v1/dabao-cms'};`);return;}
        if(!['admin/index.html','admin/admin.js','admin/admin.css','cms-transport.js','images/Dabao logo.jpeg'].includes(file)){res.writeHead(404);res.end();return;}
        let body=await fs.readFile(path.join(root,file));if(file.endsWith('.html'))body=Buffer.from(body.toString().replaceAll('https://uwktzlxlduqyjyoolgrs.supabase.co',api));
        res.setHeader('Content-Type',file.endsWith('.html')?'text/html':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'image/jpeg');res.end(body);
    }catch{res.writeHead(500);res.end();}
});
const backend=https.createServer(tls,async(req,res)=>{
    try{
        calls.push({url:api+req.url,method:req.method,hasAuthorization:!!req.headers.authorization,hasCookie:!!req.headers.cookie});
        const request=new Request(api+req.url,{method:req.method,headers:req.headers,...(['GET','HEAD','OPTIONS'].includes(req.method)?{}:{body:Readable.toWeb(req),duplex:'half'})});
        const response=await (req.url.startsWith('/storage/')?app.storage(request):handler(request));
        res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
    }catch{res.writeHead(500);res.end();}
});
await new Promise(resolve=>web.listen(4485,'127.0.0.1',resolve));await new Promise(resolve=>backend.listen(4486,'127.0.0.1',resolve));
const browser=await chromium.launch({executablePath:process.env.QA_CHROME,args:['--host-resolver-rules=MAP cms-review.test 127.0.0.1,MAP cms-api.test 127.0.0.1','--no-proxy-server']});
const checks=[];const check=(name,value)=>{checks.push({name,passed:!!value});assert(value,name);console.log('PASS '+name);};
try{
    // Self-signed certificates are confined to these two disposable loopback
    // servers. No browser interception of Set-Cookie: test real CHIPS handling.
    const ctx=await browser.newContext({viewport:{width:1440,height:900},ignoreHTTPSErrors:true});
    const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
    const login=async remember=>{await page.locator('[name=username]').fill('admin');await page.locator('[name=password]').fill(app.password);await page.locator('[name=remember]').setChecked(remember);await page.locator('#login-form button').click();await page.locator('#workspace').waitFor({state:'visible'});};
    await page.goto(site+'/admin/');await login(true);
    const cookies=await ctx.cookies();const cookie=cookies.find(c=>c.name==='__Host-dabaoCMS');
    const cdp=await ctx.newCDPSession(page),networkCookies=(await cdp.send('Network.getAllCookies')).cookies;
    const partitioned=networkCookies.find(c=>c.name==='__Host-dabaoCMS');
    check('cross-site HTTPS Remember Me sets partitioned HttpOnly Secure cookie',cookie?.httpOnly&&cookie.secure&&(cookie.partitionKey==='https://cms-review.test'||partitioned?.partitionKey?.topLevelSite==='https://cms-review.test'));
    check('no token/password stored in localStorage/sessionStorage/JS cookies',await page.evaluate(()=>localStorage.length===0&&sessionStorage.length===0&&!document.cookie.includes('dabaoCMS')));
    await page.reload();await page.locator('#workspace').waitFor({state:'visible'});check('cross-site remember restores after reload',true);
    const second=await ctx.newPage();await second.goto(site+'/admin/');await second.locator('#workspace').waitFor({state:'visible'});check('new tab restores remembered session',true);await second.close();
    const before=calls.length,beforeDatabase=databaseCalls;await page.locator('[data-page=feedback]').click();await page.waitForFunction(()=>document.querySelector('.feedback-image')?.naturalWidth>0);await page.waitForTimeout(700);
    const initial=calls.slice(before).filter(c=>c.url.includes('/storage/'));check('list loads only thumbnails; full images are not prefetched',initial.length>0&&initial.every(c=>c.url.endsWith('/thumb.webp')));
    check('image reads bypass Edge/API proxy completely',proxiedReads===0&&!calls.slice(before).some(c=>c.url.includes('/api/admin/media/')));
    check('displaying thumbnails makes zero database calls',databaseCalls===beforeDatabase);
    check('image requests send no login token or session cookie',initial.every(c=>!c.hasAuthorization&&!c.hasCookie));
    await page.screenshot({path:path.join(output,'lazy-feedback-desktop.png')});
    await page.locator('[data-open-media]').first().click();await page.waitForFunction(()=>document.querySelector('#media-viewer-image')?.naturalWidth>0);check('full image fetched only after click',calls.slice(before).some(c=>c.url.endsWith('/full.webp')));
    check('dialog locks document scrolling',await page.evaluate(()=>getComputedStyle(document.body).overflow==='hidden'));await page.keyboard.press('Escape');
    check('Escape closes viewer and restores focus',!await page.locator('#media-viewer').isVisible()&&await page.locator('[data-open-media]').first().evaluate(el=>el===document.activeElement));
    await page.waitForTimeout(300);const cacheStart=calls.length;
    await page.locator('[data-page=dashboard]').click();await page.locator('[data-page=feedback]').click();await page.waitForFunction(()=>document.querySelector('.feedback-image')?.naturalWidth>0);await page.waitForTimeout(300);
    check('returning to feedback reuses browser cached images without another Storage request',!calls.slice(cacheStart).some(c=>c.url.includes('/storage/')));
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(output,'lazy-feedback-mobile.png')});
    check('mobile feedback has no horizontal overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.locator('#logout').click();await page.locator('#login-screen').waitFor({state:'visible'});await page.reload();await page.locator('#login-screen').waitFor({state:'visible'});check('logout removes remembered login after reload',!(await ctx.cookies()).some(c=>c.name==='__Host-dabaoCMS'));
    await login(false);await page.reload();await page.locator('#login-screen').waitFor({state:'visible'});check('unchecked Remember Me does not survive reload',true);
    await page.screenshot({path:path.join(output,'remember-login-mobile.png')});check('zero console/page errors',errors.length===0);
    await fs.writeFile(path.join(output,'remember-media-browser-report.json'),JSON.stringify({checks,errors,initialImageRequests:initial.length,proxiedImageReads:proxiedReads},null,2));
}finally{await browser.close();await new Promise(resolve=>web.close(resolve));await new Promise(resolve=>backend.close(resolve));await app.close();await fs.rm(tlsDir,{recursive:true,force:true});}
