import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {previewServer} from './cms-supabase-preview.mjs';

const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const output=path.resolve(process.env.QA_OUTPUT||'test-results/site-metrics');await fs.mkdir(output,{recursive:true});
const app=await previewServer({port:4490,apiPort:4491,metricsEnabled:true});
const browser=await chromium.launch({executablePath:process.env.QA_CHROME});
const report={checks:[],errors:[],layouts:[],events:[]};
const check=(name,value)=>{report.checks.push({name,passed:!!value});assert(value,name);console.log('PASS '+name);};
const base=app.apiOrigin+'/functions/v1/dabao-cms';
let expectedFailure=false;
try{
    const ctx=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce'});
    await ctx.route(/https:\/\/(www\.googletagmanager\.com|[^/]*google-analytics\.com|[^/]*facebook\.com|connect\.facebook\.net)\//,route=>route.fulfill({body:'',contentType:'application/javascript'}));
    await ctx.route('https://cdn.jsdelivr.net/npm/@supabase/**',route=>route.fulfill({contentType:'application/javascript',body:"var supabase={createClient:()=>({from:()=>{const r=()=>Promise.resolve({data:[],error:null});const q={select:()=>q,eq:()=>q,order:()=>q,single:r,then:(a,b)=>r().then(a,b)};return q;}})};"}));
    await ctx.route('https://*.supabase.co/**',route=>{report.errors.push('Unexpected production Supabase request');return route.abort();});
    await ctx.route(/https:\/\/(lin.ee|line.me|ziweiapp.dabao.life)\//,route=>route.fulfill({body:'<title>Local QA external destination</title>',contentType:'text/html'}));
    ctx.on('page',p=>{
        p.on('pageerror',e=>report.errors.push(e.message));
        p.on('console',m=>{if(m.type()==='error'&&!expectedFailure)report.errors.push(m.text());});
        p.on('request',request=>{if(request.url()===base+'/api/public/metrics')report.events.push({event:request.postDataJSON(),headers:request.headers()});});
    });
    const page=await ctx.newPage();
    const open=async file=>{await page.goto(app.origin+'/'+file,{waitUntil:'networkidle'});await page.evaluate(()=>window.DabaoCMS?.ready);};
    const waitEvent=async(event,click)=>{
        const count=async()=>{const rows=(await app.pg.query('select * from dabao_cms.metric_daily')).rows;return rows.filter(row=>Object.entries(event).every(([key,value])=>row[key]===value)).reduce((sum,row)=>sum+Number(row.hits),0);};
        const before=await count();await click();
        // keepalive responses can outlive the source document. Verify the
        // committed server count, not a response tied to a navigated frame.
        for(let attempt=0;attempt<50&&await count()===before;attempt++)await new Promise(resolve=>setTimeout(resolve,100));
        assert.equal(await count(),before+1);await page.waitForTimeout(100);
    };
    await open('index.html');
    check('one homepage view on initial load, CMS subscription + ready do not double-count',report.events.filter(row=>row.event.action==='view').length===1);
    const beforeGuide=report.events.length;
    await waitEvent({target:'complete'},()=>page.locator('.home-guide-card').first().click());
    check('whole guide-card click counts once and existing GA event still fires once',report.events.length===beforeGuide+1&&await page.evaluate(()=>dataLayer.filter(entry=>entry[0]==='event'&&entry[1]==='service_guide_complete_click').length===1));
    const beforeKeyboard=report.events.length;
    await page.locator('.home-guide-card').nth(1).focus();
    await waitEvent({target:'annual'},()=>page.keyboard.press('Enter'));
    check('keyboard Enter counts a native card activation once',report.events.length===beforeKeyboard+1);
    await page.locator('.home-guide-card').nth(2).focus();const beforeSpace=report.events.length;
    await waitEvent({target:'divination'},()=>page.keyboard.press('Space'));
    check('existing Space handler is not double-counted',report.events.length===beforeSpace+1);
    await page.locator('#hero').scrollIntoViewIfNeeded();
    await waitEvent({target:'line',location:'hero'},()=>page.locator('#hero [data-cms-line]').click());
    check('LINE click leaves source page intact and existing GA hero event unchanged',new URL(page.url()).pathname==='/index.html'&&await page.evaluate(()=>dataLayer.filter(entry=>entry[0]==='event'&&entry[1]==='hero_line_click').length===1));
    const service=page.locator('[data-event=service_complete_booking_click]');
    await waitEvent({target:'booking_complete',location:'services'},()=>service.locator('span').click());
    await page.waitForURL('**/booking.html?service=complete');await page.waitForLoadState('networkidle');
    check('nested service CTA increments exactly once and retains service query',report.events.filter(row=>row.event.target==='booking_complete').length===1&&new URL(page.url()).searchParams.get('service')==='complete');
    await waitEvent({target:'booking_system'},()=>page.locator('#booking-system-link').click());
    check('actual booking-system click remains separate from introduction-page click',report.events.filter(row=>row.event.target==='booking_system').length===1);
    for(const [target,href] of [['course','course.html'],['services','#services'],['articles','articles.html'],['chart','chart.html'],['faq','faq.html']]){
        await open('index.html');
        await waitEvent({target,location:'navigation'},()=>page.locator('.home-nav a[href="'+href+'"]').click());
        check('navigation '+target+' increments the correct function once',true);
    }
    await open('faq.html');const beforeFaq=report.events.length;
    await waitEvent({target:'faq_expand'},()=>page.locator('.faq-list summary').first().click());
    await page.locator('.faq-list summary').first().click();await page.waitForTimeout(100);
    check('FAQ opens count once; closing does not count',report.events.length===beforeFaq+1);
    await open('index.html');
    await waitEvent({target:'testimonials'},()=>page.locator('#testimonial-more').click());
    await waitEvent({target:'testimonial_image'},()=>page.locator('#feedback-gallery .home-feedback').first().click());
    await page.keyboard.press('Escape');await page.keyboard.press('Escape');
    for(const file of ['course.html','ziwei-beginner-course.html','course-enrollment.html','articles.html','chart.html','faq.html','new_articles.html','article_view.html']){
        const before=report.events.length;await open(file);
        check(file+' records one page view without query data',report.events.slice(before).filter(row=>row.event.action==='view').length===1);
    }
    await open('course.html');await waitEvent({target:'enrollment'},()=>page.locator('a[href="#enrollment"]').first().click());
    await waitEvent({target:'beginner'},()=>page.locator('a[href="ziwei-beginner-course.html"]').first().click());await page.waitForLoadState('networkidle');
    await waitEvent({target:'line',location:'hero'},()=>page.locator('.js-line-cta[data-label=hero]').click());
    check('Meta Lead and GA generate_lead remain exactly one per LP CTA',await page.evaluate(()=>fbq.queue.filter(entry=>entry[0]==='track'&&entry[1]==='Lead').length===1&&dataLayer.filter(entry=>entry[0]==='event'&&entry[1]==='generate_lead').length===1));
    check('all collection requests omit cookies, authorization and raw URLs/identifiers',report.events.every(row=>!row.headers.cookie&&!row.headers.authorization&&Object.keys(row.event).sort().join(',')==='action,location,page,target'));
    const beforePreview=report.events.length;
    await open('index.html?cms-preview=1');check('CMS draft previews do not count views or clicks',report.events.length===beforePreview);
    await page.route(app.origin+'/cms-config.js',route=>route.fulfill({contentType:'text/javascript',body:`window.DabaoCmsConfig={enabled:true,provider:'supabase',apiBase:'${base}'};`}));
    await open('index.html');check('ordinary localhost browsing is excluded by default',report.events.length===beforePreview);await page.unroute(app.origin+'/cms-config.js');
    await page.route(base+'/api/public/content',async route=>{const response=await route.fetch();const data=await response.json();delete data.metrics;await route.fulfill({response,json:data});});
    await open('index.html');check('older backend without metrics capability triggers no collection requests',report.events.length===beforePreview);await page.unroute(base+'/api/public/content');
    const beforeAdmin=report.events.length;await open('admin/');
    let releaseStats;const gate=new Promise(resolve=>{releaseStats=resolve;});
    await page.route(base+'/api/admin/metrics?*',async route=>{await gate;await route.continue();});
    await page.locator('[name=username]').fill('admin');await page.locator('[name=password]').fill(app.password);
    await page.locator('#login-form button').click();await page.locator('#workspace').waitFor({state:'visible'});
    check('slow statistics never block login/dashboard or settings navigation',await page.locator('#metrics-result').getAttribute('aria-busy')==='true');
    await page.locator('[data-page=settings]').click();check('settings usable while statistics are pending',await page.locator('#password-form').isVisible());
    releaseStats();await page.waitForTimeout(100);check('late dashboard response does not overwrite other admin tabs',await page.locator('#password-form').isVisible());await page.unroute(base+'/api/admin/metrics?*');
    await page.locator('[data-page=dashboard]').click();await page.waitForFunction(()=>document.querySelector('#metrics-result')?.getAttribute('aria-busy')==='false');
    check('admin never records itself',report.events.length===beforeAdmin);
    const totals=await app.pg.query("select coalesce(sum(hits) filter(where action='view'),0)::int views,coalesce(sum(hits) filter(where target='line'),0)::int line from dabao_cms.metric_daily");
    check('dashboard shows actual local counters, not content inventory or audit logs',await page.locator('[data-total=views]').textContent()===String(totals.rows[0].views)&&await page.locator('[data-total=line]').textContent()===String(totals.rows[0].line)&&!await page.locator('#content').textContent().then(text=>text.includes('最近修改')||text.includes('已發布諮詢回饋')));
    for(const days of ['1','30','7','0']){
        await page.locator('#metrics-days').selectOption(days);await page.waitForFunction(()=>document.querySelector('#metrics-result')?.getAttribute('aria-busy')==='false');
        check('range '+days+' refreshes actual statistics',await page.locator('[data-total=views]').textContent()===String(totals.rows[0].views));
    }
    for(const size of [{width:1440,height:900},{width:1280,height:720},{width:390,height:844},{width:375,height:812}]){
        await page.setViewportSize(size);
        const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
        report.layouts.push({...size,overflow});check('dashboard '+size.width+'×'+size.height+' no horizontal overflow',!overflow);
        if(size.width===1440||size.width===390)await page.screenshot({path:path.join(output,'traffic-dashboard-'+size.width+'.png'),fullPage:true});
    }
    expectedFailure=true;
    await page.route(base+'/api/admin/metrics?*',route=>route.fulfill({status:503,json:{error:'Local QA outage'}}));
    await page.locator('#refresh').click();await page.locator('#metrics-result .error').waitFor();
    check('stats outage displays unavailable, never fake zero or logout',await page.locator('#workspace').isVisible()&&await page.locator('[data-total=views]').textContent()==='—');
    await page.unroute(base+'/api/admin/metrics?*');expectedFailure=false;
    await page.route(base+'/api/admin/metrics?*',route=>route.fulfill({json:{enabled:false}}));
    await page.locator('#refresh').click();await page.waitForFunction(()=>document.querySelector('#metrics-result').textContent.includes('尚未啟用'));
    check('disabled backend does not break new dashboard/login',await page.locator('#workspace').isVisible());await page.unroute(base+'/api/admin/metrics?*');
    await app.pg.exec('truncate dabao_cms.metric_daily,dabao_cms.metric_started');
    await page.locator('#refresh').click();await page.waitForFunction(()=>document.querySelector('[data-total=views]')?.textContent==='0');
    check('genuine empty data shows zero, no fabricated visits',await page.locator('#metrics-result').textContent().then(text=>text.includes('尚無累計資料')));
    await page.locator('#metrics-days').focus();check('range control is keyboard focusable',await page.locator('#metrics-days').evaluate(el=>el===document.activeElement));
    check('zero unexpected console/page errors',report.errors.length===0);
}catch(error){report.failure={message:error.message,stack:error.stack};process.exitCode=1;}
finally{await fs.writeFile(path.join(output,'site-metrics-browser-report.json'),JSON.stringify(report,null,2));await browser.close();await app.close();console.log(JSON.stringify({passed:report.checks.filter(c=>c.passed).length,total:report.checks.length,errors:report.errors,failure:report.failure,output},null,2));}
