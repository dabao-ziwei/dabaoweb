import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import { createCms } from '../cms/server.mjs';
import { configuration } from '../cms/config.mjs';

const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const output=path.resolve(process.env.QA_OUTPUT||'test-results/cms-browser');
await fs.mkdir(output,{recursive:true});
const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'dabao-cms-browser-'));
const config=configuration({CMS_PORT:process.env.QA_PORT||'4382',CMS_DATA_DIR:dataDir});
const app=createCms(config),password='Only-for-isolated-browser-QA-123!';
await app.auth.addAdmin('reviewer',password);
await new Promise(resolve=>app.server.listen(config.port,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,...(process.env.QA_CHROME?{executablePath:process.env.QA_CHROME}:{})});
const report={checks:[],layouts:[],consoleErrors:[],pageErrors:[],failedAssets:[],analytics:[]};
const check=(name,value)=>{report.checks.push({name,passed:Boolean(value)});console.log(`${value?'PASS':'FAIL'} ${name}`);assert.ok(value,name);};
const screenshot=(page,name,options={})=>page.screenshot({path:path.join(output,name+'.png'),fullPage:true,...options});
const errorSources=new WeakMap();
async function context(options={}){
    const ctx=await browser.newContext(options);
    ctx.setDefaultTimeout(12000);ctx.setDefaultNavigationTimeout(20000);
    await ctx.route(/https:\/\/(www\.googletagmanager\.com|[^/]*google-analytics\.com|[^/]*facebook\.com|connect\.facebook\.net)\//,r=>r.fulfill({contentType:'application/javascript',body:''}));
    const supabaseStub="var supabase={createClient:()=>({from:table=>{const result=()=>Promise.resolve({data:table==='site_settings'?{setting_value:false}:[],error:null});const q={select:()=>q,eq:()=>q,order:()=>q,single:result,then:(a,b)=>result().then(a,b)};return q;}})};";
    await ctx.route('https://cdn.jsdelivr.net/npm/@supabase/**',r=>r.fulfill({contentType:'application/javascript',body:supabaseStub}));
    await ctx.route('https://*.supabase.co/**',r=>r.fulfill({contentType:'application/json',body:'[]'}));
    await ctx.route('https://lin.ee/**',r=>r.fulfill({contentType:'text/html',body:'<title>LINE QA destination</title>'}));
    ctx.on('page',page=>{
        page.on('pageerror',error=>report.pageErrors.push({url:page.url(),message:error.message}));
        page.on('console',message=>{if(message.type()==='error')report.consoleErrors.push({url:page.url(),message:message.text()});});
        page.on('response',response=>{if(response.status()>=400&&!response.url().includes('/api/admin/session'))report.failedAssets.push({url:response.url(),status:response.status()});});
    });
    return ctx;
}
async function open(page,file){await page.goto(config.origin+'/'+file,{waitUntil:'networkidle'});if(!file.startsWith('admin'))await page.evaluate(()=>window.DabaoCMS?.ready);}
async function layout(page,label){
    const result=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,overflow:document.documentElement.scrollWidth>innerWidth+1}));
    report.layouts.push({label,...result});check(label+' no horizontal overflow',!result.overflow);
}
async function login(page){await open(page,'admin/');await page.locator('[name=username]').fill('reviewer');await page.locator('[name=password]').fill(password);await page.locator('#login-form button').click();await page.locator('#workspace').waitFor({state:'visible'});}
async function confirm(page){await page.locator('#confirm-dialog [value=confirm]').click();await page.locator('#confirm-dialog').waitFor({state:'hidden'});}
async function publish(page){await page.locator('#publish').click();await confirm(page);await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('發布成功'));}
async function state(page){return page.evaluate(()=>fetch('/api/admin/state').then(r=>r.json()));}
try {
    // These are synthetic fixtures in a disposable database, never customer feedback.
    for(let index=0;index<6;index++){
        const svg=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="800"><rect width="640" height="800" fill="${['#e6eeee','#e5e9f1','#f0e9e1'][index%3]}"/><text x="48" y="100" font-size="32" fill="#334455">SYNTHETIC QA IMAGE ${index+1}</text><rect x="48" y="160" width="500" height="120" rx="8" fill="#fff"/><rect x="100" y="320" width="490" height="180" rx="8" fill="#b5d9b2"/></svg>`);
        const image=await app.media.add(await sharp(svg).png().toBuffer(),`qa-${index+1}.png`,'test-fixture');
        app.store.save('feedback',null,{mediaId:image.id,description:`測試用圖片 ${index+1}（非客戶回饋）`,sort:index+1,isVisible:true,isFeatured:true},null,'test-fixture');
    }
    app.store.publish('test-fixture');
    const ctx=await context({viewport:{width:1440,height:900}}),admin=await ctx.newPage();
    await open(admin,'admin/');await screenshot(admin,'admin-login-desktop');await login(admin);await screenshot(admin,'admin-dashboard-desktop');
    check('dashboard has no consent workflow',!await admin.locator('#content').textContent().then(text=>text.includes('同意'))&&!Object.hasOwn(await state(admin),'consentPending'));
    const publicCtx=await context({viewport:{width:1440,height:900}}),course=await publicCtx.newPage(),home=await publicCtx.newPage(),lp=await publicCtx.newPage();
    await open(course,'course.html');await open(home,'index.html');await open(lp,'ziwei-beginner-course.html');
    check('all initial public prices 25000',await course.locator('[data-course-field=price]').textContent()==='NT$25,000'&&await lp.locator('[data-course-field=price]').textContent()==='NT$25,000'&&await home.locator('#home-cms-enrollment strong').textContent()==='NT$25,000');
    check('desktop 6 featured images',await home.locator('#featured-feedback .home-feedback:visible').count()===6);
    await admin.locator('[data-page=cohorts]').click();await admin.locator('[data-edit=cohorts]').first().click();
    await admin.locator('#field-earlyBirdEnabled').check();await admin.locator('#field-earlyBirdPrice').fill('19800');await admin.locator('#edit-form [type=submit]').click();await admin.locator('#editor').waitFor({state:'hidden'});
    await course.reload({waitUntil:'networkidle'});check('draft does not change public price',await course.locator('[data-course-field=price]').textContent()==='NT$25,000');
    const preview=await ctx.newPage();await open(preview,'course.html?cms-preview=1');
    check('preview shows draft price',await preview.locator('[data-course-field=price]').textContent()==='NT$19,800');
    check('preview does not initialize analytics',await preview.evaluate(()=>!window.dataLayer.some(item=>item[0]==='config'||item[0]==='event')));
    await screenshot(preview,'course-draft-preview-desktop');
    await publish(admin);
    for(const page of [course,home,lp]){await page.reload({waitUntil:'networkidle'});await page.evaluate(()=>DabaoCMS.ready);}
    check('publish updates all 3 public sources',await course.locator('[data-course-field=price]').textContent()==='NT$19,800'&&await lp.locator('[data-course-field=price]').textContent()==='NT$19,800'&&await home.locator('#home-cms-enrollment strong').textContent()==='NT$19,800');
    check('schema matches published price',await lp.evaluate(()=>JSON.parse(document.querySelector('#beginner-course-schema').textContent).offers.price===19800));
    await admin.locator('[data-page=cohorts]').click();await admin.locator('[data-edit=cohorts]').first().click();await admin.locator('#field-earlyBirdPrice').fill('19900');await admin.locator('#edit-form [type=submit]').click();await admin.locator('#editor').waitFor({state:'hidden'});
    await publish(admin);await course.bringToFront();if(process.env.QA_SKIP_POLL)await course.evaluate(()=>DabaoCMS.refresh());else await new Promise(resolve=>setTimeout(resolve,61000));await course.waitForFunction(()=>document.querySelector('[data-course-field=price]').textContent==='NT$19,900');check(process.env.QA_SKIP_POLL?'quick-run manual refresh':'already-open public tab updates by real 60s polling',true);
    await admin.locator('[data-page=feedback]').click();await screenshot(admin,'admin-feedback-desktop');
    await home.locator('#testimonials').scrollIntoViewIfNeeded();await home.locator('#featured-feedback .home-feedback').first().click();await home.locator('#image-lightbox[open]').waitFor();
    await home.locator('#image-lightbox-img').evaluate(img=>img.decode());check('lightbox loads full image',await home.locator('#image-lightbox-img').evaluate(img=>img.complete&&img.naturalWidth>0&&img.src.endsWith('/full')));
    check('lightbox locks scrolling',await home.locator('body').evaluate(node=>node.classList.contains('home-dialog-open')));await home.keyboard.press('Escape');check('Escape closes lightbox',await home.locator('#image-lightbox[open]').count()===0);
    await home.locator('#testimonial-more').click();await home.locator('#feedback-gallery[open]').waitFor();check('gallery count from data',await home.locator('#gallery-grid .home-feedback').count()===6);await home.keyboard.press('Escape');
    await lp.locator('.js-line-cta').first().click({noWaitAfter:true});await lp.waitForTimeout(100);const lead=await lp.evaluate(()=>window.dataLayer.filter(e=>e[0]==='event'&&e[1]==='generate_lead').length);check('one GA generate_lead per CTA click',lead===1);check('one Meta Lead queued per CTA click',await lp.evaluate(()=>window.fbq.queue.filter(e=>e[0]==='track'&&e[1]==='Lead').length===1));check('native new tab keeps LP',lp.url().includes('ziwei-beginner-course.html'));
    await admin.locator('[data-edit=feedback]').first().click();check('feedback editor has no consent controls',await admin.locator('#editor [name^=consent]').count()===0);await screenshot(admin,'admin-feedback-editor-desktop');await admin.locator('#editor [data-close=editor]').first().click();
    const beforeSwitch=(await state(admin)).versions[0].id;
    await admin.locator('[data-page=cohorts]').click();await admin.locator('[data-new=cohorts]').click();
    await admin.locator('#field-courseId').selectOption('intermediate');await admin.locator('#field-name').fill('測試進階期別（隔離測試）');await admin.locator('#field-status').selectOption('open');await admin.locator('#field-regularPrice').fill('30000');await admin.locator('#field-startDate').fill('2030-11-04');await admin.locator('#field-registrationDeadline').fill('2030-11-03');await admin.locator('#field-isFeatured').check();await admin.locator('#field-isVisible').check();await admin.locator('#edit-form [type=submit]').click();await admin.locator('#editor').waitFor({state:'hidden'});await publish(admin);
    for(const page of [home,course]){await page.reload({waitUntil:'networkidle'});await page.evaluate(()=>DabaoCMS.ready);}
    check('featured switch updates homepage and overview',await home.locator('#home-cms-enrollment').textContent().then(t=>t.includes('進階班')&&t.includes('30,000'))&&await course.locator('[data-enrollment-heading]').textContent()==='實戰紫微斗數進階班');
    check('simultaneous cohorts shown',await course.locator('#other-enrollments .cms-enrollment-row').count()===1);
    const intro=await course.locator('[data-course-cta=beginner_lp][data-location=enrollment]').getAttribute('href');check('nonbeginner uses dynamic enrollment route',intro.startsWith('course-enrollment.html?cohort='));const generic=await publicCtx.newPage();await open(generic,intro);check('dynamic enrollment page binds correct course',await generic.locator('h1').textContent()==='實戰紫微斗數進階班'&&await generic.locator('[data-course-field=price]').textContent()==='NT$30,000');await screenshot(generic,'dynamic-enrollment-desktop');await generic.close();
    const beginner=(await state(admin)).cohorts.find(c=>c.courseId==='beginner');await admin.locator(`[data-edit=cohorts][data-id="${beginner.id}"]`).click();await admin.locator('#field-status').selectOption('closed');await admin.locator('#edit-form [type=submit]').click();await admin.locator('#editor').waitFor({state:'hidden'});await publish(admin);await lp.reload({waitUntil:'networkidle'});check('beginner LP never becomes a different course',await lp.evaluate(()=>window.DabaoCourse.data.courseName.includes('初階班'))&&await lp.locator('[data-course-field=enrollmentStatus]').first().textContent().then(t=>t.includes('截止')));
    await admin.locator('[data-page=history]').click();await admin.locator(`[data-restore="${beforeSwitch}"]`).click();await confirm(admin);await admin.waitForFunction(()=>document.querySelector('#notice').textContent.includes('版本已還原'));
    for(const viewport of [{width:1440,height:900},{width:1280,height:720},{width:390,height:844},{width:375,height:812}]){
        const name=`${viewport.width}x${viewport.height}`;await admin.setViewportSize(viewport);
        for(const view of ['dashboard','courses','cohorts','feedback','history','settings']){await admin.locator(`[data-page=${view}]`).click();await admin.waitForTimeout(100);await layout(admin,`admin ${view} ${name}`);}
        for(const file of ['index.html','course.html','ziwei-beginner-course.html','course-enrollment.html']){
            const page=await publicCtx.newPage();await page.setViewportSize(viewport);const cohortId=app.store.publicData().cohorts[0].id;await open(page,file+(file==='course-enrollment.html'?'?cohort='+cohortId:''));await layout(page,file+' '+name);
            if(file==='index.html')check('featured count '+name,await page.locator('#featured-feedback .home-feedback:visible').count()===(viewport.width<800?3:6));
            if(viewport.width===1440||viewport.width===390)await screenshot(page,file.replace('.html','')+'-'+viewport.width);
            await page.close();
        }
        if(viewport.width===390){await admin.locator('[data-page=dashboard]').click();await screenshot(admin,'admin-dashboard-mobile');await admin.locator('[data-page=cohorts]').click();await admin.locator('[data-edit=cohorts]').first().click();await screenshot(admin,'admin-cohort-editor-mobile');await layout(admin,'admin cohort dialog 390');await admin.keyboard.press('Escape');await admin.locator('[data-page=feedback]').click();await screenshot(admin,'admin-feedback-mobile',{fullPage:false});}
    }
    // Exercise the actual mobile form, file picker, preview and publish controls.
    await admin.setViewportSize({width:390,height:844});await admin.locator('[data-page=cohorts]').click();await admin.locator('[data-edit=cohorts]').first().click();await admin.locator('#field-earlyBirdPrice').fill('20100');await admin.locator('#edit-form [type=submit]').click();await admin.locator('#editor').waitFor({state:'hidden'});check('mobile edit persists draft',(await state(admin)).cohorts[0].earlyBirdPrice===20100);
    await admin.locator('[data-page=feedback]').click();const image=await sharp({create:{width:300,height:400,channels:3,background:'#34b487'}}).png().toBuffer();await admin.locator('#feedback-upload').setInputFiles({name:'mobile-synthetic.png',mimeType:'image/png',buffer:image});await admin.waitForFunction(()=>document.querySelector('#notice').textContent.includes('已處理 1 張'));
    let latest=(await state(admin)).feedback.find(f=>f.description==='');check('mobile upload remains private draft',latest&&!latest.isVisible&&!latest.published);
    await admin.locator(`[data-edit=feedback][data-id="${latest.id}"]`).click();await admin.locator('#field-description').fill('手機上傳測試（非客戶回饋）');await admin.locator('#field-isVisible').check();await admin.locator('#field-isFeatured').check();await admin.locator('#field-sort').fill('0');await admin.locator('#edit-form [type=submit]').click();await admin.locator('#editor').waitFor({state:'hidden'});await publish(admin);check('mobile publish visible publicly',app.store.publicData().feedbackCount===7);
    await admin.locator('#preview-target').selectOption('index.html');const [mobilePreview]=await Promise.all([ctx.waitForEvent('page'),admin.locator('#preview-link').click()]);await mobilePreview.waitForLoadState('networkidle');check('mobile preview works',await mobilePreview.locator('.cms-preview-banner').isVisible());await mobilePreview.close();
    latest=(await state(admin)).feedback.find(f=>f.id===latest.id);await admin.locator(`[data-unpublish=feedback][data-id="${latest.id}"]`).click();await confirm(admin);await admin.waitForFunction(()=>document.querySelector('#notice').textContent.includes('已取消發布'));check('mobile unpublish retains original',app.store.publicData().feedbackCount===6&&app.store.row('feedback',latest.id));
    await admin.locator('[data-page=history]').click();await screenshot(admin,'admin-history-mobile',{fullPage:false});
    const finalState=await state(admin);check('audit and versions visible',finalState.versions.length>=4&&finalState.recent.length>0);
    const mobileCtx=await context({viewport:{width:375,height:812},isMobile:true,hasTouch:true}),mobileAdmin=await mobileCtx.newPage();await open(mobileAdmin,'admin/');await screenshot(mobileAdmin,'admin-login-mobile');await login(mobileAdmin);check('fresh mobile login works',await mobileAdmin.locator('#workspace').isVisible());
    await mobileAdmin.locator('[data-page=courses]').click();await mobileAdmin.locator('[data-edit=courses]').first().click();await mobileAdmin.keyboard.press('Tab');check('mobile dialog keyboard focus stays inside',await mobileAdmin.locator('#editor').evaluate(dialog=>dialog.contains(document.activeElement)));await mobileAdmin.keyboard.press('Escape');check('editor Escape closes',await mobileAdmin.locator('#editor[open]').count()===0);
    const unavailable=await publicCtx.newPage();await unavailable.route(config.origin+'/api/public/content',route=>route.fulfill({contentType:'application/json',body:'unavailable'}));await open(unavailable,'ziwei-beginner-course.html');check('API failure never resurrects fallback price',await unavailable.locator('[data-course-field=price]').textContent()==='請洽小幫手'&&await unavailable.evaluate(()=>!JSON.parse(document.querySelector('#beginner-course-schema').textContent).offers));await unavailable.close();
    check('no browser page errors',report.pageErrors.length===0);check('no console errors',report.consoleErrors.length===0);check('no failed normal assets',report.failedAssets.length===0);
} catch(error){report.failure={message:error.message,stack:error.stack};process.exitCode=1;} finally {
    await fs.writeFile(path.join(output,'browser-report.json'),JSON.stringify(report,null,2));
    await browser.close();await new Promise(resolve=>app.server.close(resolve));app.store.close();await fs.rm(dataDir,{recursive:true,force:true});
    console.log(JSON.stringify({checks:report.checks.length,passed:report.checks.filter(c=>c.passed).length,layouts:report.layouts.length,consoleErrors:report.consoleErrors,pageErrors:report.pageErrors,failedAssets:report.failedAssets,failure:report.failure,output},null,2));
}
