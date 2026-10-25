import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import { previewServer } from './cms-supabase-preview.mjs';

const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const output=path.resolve(process.env.QA_OUTPUT||'test-results/supabase-cms');await fs.mkdir(output,{recursive:true});
const app=await previewServer({port:4483,apiPort:4484});
const browser=await chromium.launch({executablePath:process.env.QA_CHROME});
const report={checks:[],layouts:[],errors:[],pageErrors:[],requests:[]};
const check=(name,value)=>{report.checks.push({name,passed:Boolean(value)});assert(value,name);console.log('PASS '+name);};
const screenshot=(page,name)=>page.screenshot({path:path.join(output,name+'.png'),fullPage:true});
try{
    const ctx=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce'});
    ctx.setDefaultTimeout(15000);
    await ctx.route(/https:\/\/(www\.googletagmanager\.com|[^/]*google-analytics\.com|[^/]*facebook\.com|connect\.facebook\.net)\//,r=>r.fulfill({body:'',contentType:'application/javascript'}));
    await ctx.route('https://cdn.jsdelivr.net/npm/@supabase/**',r=>r.fulfill({contentType:'application/javascript',body:"var supabase={createClient:()=>({from:()=>{const r=()=>Promise.resolve({data:null,error:null});const q={select:()=>q,eq:()=>q,order:()=>q,single:r,then:(a,b)=>r().then(a,b)};return q;}})};"}));
    await ctx.route('https://*.supabase.co/**',r=>{report.errors.push('Unexpected production Supabase request');return r.abort();});
    await ctx.route('https://lin.ee/**',r=>r.fulfill({body:'<title>LINE test</title>',contentType:'text/html'}));
    ctx.on('page',p=>{p.on('pageerror',e=>report.pageErrors.push(e.message));p.on('console',e=>{if(e.type()==='error')report.errors.push(e.text());});p.on('request',r=>{if(r.url().startsWith(app.apiOrigin))report.requests.push({url:r.url(),method:r.method()});});});
    const page=await ctx.newPage();
    const open=async(file,p=page)=>{await p.goto(app.origin+'/'+file,{waitUntil:'networkidle'});if(!file.startsWith('admin'))await p.evaluate(()=>window.DabaoCMS?.ready);};
    await open('admin/');await screenshot(page,'cloud-login-desktop');
    const loginRequestsStart=report.requests.length;
    await page.locator('[name=username]').fill('admin');await page.locator('[name=password]').fill(app.password);await page.locator('[name=remember]').check();await page.locator('#login-form button').click();await page.locator('#workspace').waitFor({state:'visible'});
    check('login renders populated dashboard with one API request',report.requests.slice(loginRequestsStart).filter(r=>r.method!=='OPTIONS').length===1&&await page.locator('.metrics strong').count()===3);
    check('cross-origin cloud login works',await page.locator('#account').textContent().then(t=>t.includes('admin')));
    check('no auth token persisted in browser storage',await page.evaluate(()=>localStorage.length===0&&sessionStorage.length===0));
    const cookies=await ctx.cookies();const remembered=cookies.find(c=>c.name==='__Host-dabaoCMS');
    check('remember cookie is HttpOnly Secure and expires in30days',remembered?.httpOnly&&remembered.secure&&remembered.sameSite==='None'&&remembered.expires>Date.now()/1000+29*86400);
    check('remember cookie cannot be read by JavaScript',!await page.evaluate(()=>document.cookie.includes('dabaoCMS')));
    await page.reload({waitUntil:'networkidle'});check('remember restores populated dashboard after reload',await page.locator('#workspace').isVisible()&&await page.locator('.metrics strong').count()===3);
    await screenshot(page,'cloud-dashboard-desktop');
    const course=await ctx.newPage(),home=await ctx.newPage(),lp=await ctx.newPage();
    let releaseContent;const contentGate=new Promise(resolve=>{releaseContent=resolve;});
    await home.route(app.apiOrigin+'/functions/v1/dabao-cms/api/public/content',async route=>{await contentGate;await route.continue();});
    await home.goto(app.origin+'/index.html',{waitUntil:'domcontentloaded'});await home.locator('#testimonials').scrollIntoViewIfNeeded();
    await home.waitForFunction(()=>[...document.querySelectorAll('#featured-feedback img')].some(i=>i.naturalWidth>0));
    check('homepage displays its existing images before CMS responds',await home.locator('#featured-feedback img').first().getAttribute('src').then(src=>src.startsWith('images/')));
    releaseContent();await home.evaluate(()=>window.DabaoCMS.ready);await home.unroute(app.apiOrigin+'/functions/v1/dabao-cms/api/public/content');
    await open('course.html',course);await open('index.html',home);await open('ziwei-beginner-course.html',lp);
    check('public 3 pages read cloud published price',await course.locator('[data-course-field=price]').textContent()==='NT$25,000'&&await lp.locator('[data-course-field=price]').textContent()==='NT$25,000'&&await home.locator('#home-cms-enrollment strong').textContent()==='NT$25,000');
    check('public images use Storage URLs, not Edge proxy URLs',await home.locator('#featured-feedback img').first().getAttribute('src').then(src=>src.startsWith(app.services.publicMediaBase+'/')));
    await page.locator('[data-page=cohorts]').click();await page.locator('[data-edit=cohorts]').first().click();await page.locator('#field-regularPrice').fill('26000');await page.locator('#edit-form [type=submit]').click();await page.locator('#editor').waitFor({state:'hidden'});
    await course.reload({waitUntil:'networkidle'});check('draft is not public',await course.locator('[data-course-field=price]').textContent()==='NT$25,000');
    await page.locator('#preview-target').selectOption('course.html');await page.locator('#preview-link').click();await page.locator('#preview-dialog[open]').waitFor();
    let frame=page.frameLocator('#preview-frame');await frame.locator('.cms-preview-banner').waitFor();await frame.locator('[data-course-field=price]').filter({hasText:'26,000'}).waitFor();
    check('draft iframe authenticates without URL/session storage tokens',!await page.locator('#preview-frame').getAttribute('src').then(src=>src.includes('token')));
    check('preview analytics suppressed',await frame.locator('body').evaluate(()=>!window.dataLayer.some(x=>x[0]==='config'||x[0]==='event')));
    check('sandbox cannot access parent admin transport',await frame.locator('body').evaluate(()=>{try{return !parent.DabaoCmsTransport;}catch{return true;}}));
    await screenshot(page,'cloud-draft-preview-desktop');await page.keyboard.press('Escape');
    await page.locator('#preview-target').selectOption('index.html');await page.locator('#preview-link').click();frame=page.frameLocator('#preview-frame');await frame.locator('#featured-feedback img').first().waitFor();
    await frame.locator('#featured-feedback .home-feedback').first().click();await frame.locator('#image-lightbox[open]').waitFor();await frame.locator('#image-lightbox-img').evaluate(i=>i.decode());
    check('draft preview reads authorized images directly from Storage',await frame.locator('#image-lightbox-img').getAttribute('src').then(src=>src.startsWith(app.services.publicMediaBase+'/')));
    await frame.locator('body').evaluate(()=>window.DabaoCMS.refresh());check('unchanged preview refresh keeps lightbox open',await frame.locator('#image-lightbox[open]').isVisible());
    await screenshot(page,'cloud-private-draft-lightbox');await page.keyboard.press('Escape');await page.locator('#preview-dialog [data-close]').click();
    await page.locator('#publish').click();await page.locator('#confirm-dialog [value=confirm]').click();await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('發布成功'));
    for(const p of [course,home,lp])await p.reload({waitUntil:'networkidle'});
    check('publish changes all 3 pages',await course.locator('[data-course-field=price]').textContent()==='NT$26,000'&&await lp.locator('[data-course-field=price]').textContent()==='NT$26,000'&&await home.locator('#home-cms-enrollment strong').textContent()==='NT$26,000');
    check('JSON-LD cloud price matches',await lp.evaluate(()=>JSON.parse(document.querySelector('#beginner-course-schema').textContent).offers.price===26000));
    const imagesStart=report.requests.length;
    await page.locator('[data-page=feedback]').click();await page.waitForFunction(()=>document.querySelector('.feedback-image')?.naturalWidth>0);check('admin thumbnails load directly from public Storage',await page.locator('.feedback-image').first().getAttribute('src').then(src=>src.startsWith(app.services.publicMediaBase+'/')));
    await page.waitForTimeout(150);
    check('feedback listing makes no image-proxy calls or full-image prefetches',!report.requests.slice(imagesStart).some(r=>r.url.includes('/api/admin/media/')||r.url.endsWith('/full.webp')));
    await page.locator('[data-open-media]').first().click();await page.waitForFunction(()=>document.querySelector('#media-viewer-image')?.naturalWidth>0);check('click loads full image on demand',await page.locator('#media-viewer[open]').isVisible());await screenshot(page,'cloud-on-demand-image');await page.keyboard.press('Escape');
    check('image viewer Escape restores keyboard focus',await page.locator('[data-open-media]').first().evaluate(el=>el===document.activeElement));
    check('reading viewer is not constrained to editor thumbnail height',await page.locator('#media-viewer-image').evaluate(i=>getComputedStyle(i).maxHeight==='none'));
    await page.locator('[data-edit=feedback]').first().click();await page.waitForFunction(()=>document.querySelector('#editor-image')?.getAttribute('src'));await page.locator('#editor-image').evaluate(i=>i.decode());await page.locator('#open-redactor').click();await page.locator('#redactor[open]').waitFor();
    const box=await page.locator('#redact-canvas').boundingBox();await page.mouse.move(box.x+10,box.y+10);await page.mouse.down();await page.mouse.move(box.x+80,box.y+80);await page.mouse.up();await page.locator('#redact-save').click();await page.locator('#redactor').waitFor({state:'hidden'});check('real cloud redaction works through form',await page.locator('#form-error').textContent().then(t=>t.includes('已產生遮蔽圖片')));await page.keyboard.press('Escape');
    for(const size of [{width:1440,height:900},{width:1280,height:720},{width:390,height:844},{width:375,height:812}]){
        await page.setViewportSize(size);
        for(const view of ['dashboard','courses','cohorts','feedback','history','settings']){
            await page.locator(`[data-page=${view}]`).click();await page.waitForTimeout(80);
            const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
            report.layouts.push({page:view,...size,overflow});check(`admin ${view} ${size.width} no overflow`,!overflow);
        }
        for(const [p,file] of [[home,'index.html'],[course,'course.html'],[lp,'ziwei-beginner-course.html']]){
            await p.setViewportSize(size);await p.reload({waitUntil:'networkidle'});const overflow=await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth);report.layouts.push({page:file,...size,overflow});check(`${file} ${size.width} no overflow`,!overflow);
        }
        if(size.width===1440||size.width===390){await page.locator('[data-page=dashboard]').click();await screenshot(page,'cloud-dashboard-'+size.width);await page.locator('[data-page=feedback]').click();await screenshot(page,'cloud-feedback-'+size.width);}
    }
    await page.locator('[data-page=feedback]').click();const bytes=await sharp({create:{width:300,height:400,channels:3,background:'#bd8499'}}).png().toBuffer();await page.locator('#feedback-upload').setInputFiles({name:'synthetic-test.png',mimeType:'image/png',buffer:bytes});await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('已處理 1 張'));check('mobile upload stays draft',await page.locator('#content').textContent().then(t=>t.includes('尚未填寫說明')));
    await page.locator('[data-page=settings]').click();await page.locator('#password-form [name=current]').fill(app.password);await page.locator('#password-form [name=password]').fill('1234567890');await page.locator('#password-form [name=confirm]').fill('1234567890');await page.locator('#password-form button').click();await page.locator('#login-screen').waitFor({state:'visible'});check('10-character password change logs out',true);
    await page.locator('[name=username]').fill('admin');await page.locator('#login-form [name=password]').fill('1234567890');await page.locator('#login-form button').click();await page.locator('#workspace').waitFor({state:'visible'});await page.locator('#logout').click();await page.locator('#login-screen').waitFor({state:'visible'});check('logout returns to login',true);
    await ctx.route(app.apiOrigin+'/functions/v1/dabao-cms/api/admin/login',async route=>{const response=await route.fetch();const data=await response.json();delete data.state;await route.fulfill({response,json:data});});
    const fallbackStart=report.requests.length;
    await page.locator('[name=username]').fill('admin');await page.locator('#login-form [name=password]').fill('1234567890');await page.locator('#login-form button').click();await page.locator('#workspace').waitFor({state:'visible'});
    check('new client supports older cloud login response',report.requests.slice(fallbackStart).filter(r=>r.method!=='OPTIONS'&&r.url.includes('/api/admin/')).map(r=>new URL(r.url).pathname.split('/api/admin/')[1]).join(',')==='login,state'&&Boolean((await page.locator('#content').textContent()).trim()));
    await page.locator('#logout').click();await page.locator('#login-screen').waitFor({state:'visible'});
    await page.reload({waitUntil:'networkidle'});check('logout remains logged out after reload',await page.locator('#login-screen').isVisible()&&!(await ctx.cookies()).some(c=>c.name==='__Host-dabaoCMS'));
    check('no browser console errors',report.errors.length===0);check('no uncaught page errors',report.pageErrors.length===0);
}catch(error){report.failure={message:error.message,stack:error.stack};process.exitCode=1;}finally{
    await fs.writeFile(path.join(output,'browser-report.json'),JSON.stringify(report,null,2));await browser.close();await app.close();
    console.log(JSON.stringify({passed:report.checks.filter(c=>c.passed).length,total:report.checks.length,layouts:report.layouts.length,errors:report.errors,pageErrors:report.pageErrors,failure:report.failure,output},null,2));
}
