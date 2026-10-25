import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {previewServer} from './cms-supabase-preview.mjs';

const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const output=path.resolve(process.env.QA_OUTPUT||'test-results/dashboard-refresh');await fs.mkdir(output,{recursive:true});
const app=await previewServer({port:4500,apiPort:4501,metricsEnabled:true});
const browser=await chromium.launch({executablePath:process.env.QA_CHROME});
const report={checks:[],errors:[],layouts:[],failedResponses:[]};
const check=(name,value)=>{report.checks.push({name,passed:!!value});assert(value,name);console.log('PASS '+name);};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let calls=0,expectedFailure=false;
try{
    const context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage();
    page.on('request',request=>{if(request.method()==='GET'&&request.url().includes('/api/admin/metrics?'))calls++;});
    page.on('response',response=>{if(response.status()>=400&&!expectedFailure)report.failedResponses.push({url:response.url(),status:response.status()});});
    page.on('pageerror',error=>report.errors.push(error.message));
    page.on('console',message=>{if(message.type()==='error'&&!expectedFailure)report.errors.push({message:message.text(),location:message.location()});});
    const fixed=new Date('2026-10-25T04:00:00Z');await page.clock.install({time:fixed});await page.clock.pauseAt(fixed);
    const until=async condition=>{for(let n=0;n<150;n++){if(await condition())return;await sleep(20);}throw Error('Condition timeout');};
    const settled=()=>until(()=>page.locator('#metrics-result').getAttribute('aria-busy').then(value=>value==='false'));
    const dashboard=async()=>{await page.locator('[data-page=dashboard]').click({force:true});await settled();};
    const save=async minutes=>{
        await page.locator('[data-page=settings]').click({force:true});
        await page.locator('#dashboard-settings-form input').fill(String(minutes));
        await page.locator('#dashboard-settings-form button').click({force:true});
        await until(()=>page.locator('#notice').textContent().then(text=>text.includes(`每 ${minutes} 分鐘`)));
    };
    const advance=async ms=>{await page.clock.runFor(ms);await sleep(50);};
    const addView=()=>app.services.metrics('collect',{page:'home',action:'view',target:'none',location:'content'});
    await page.goto(app.origin+'/admin/');
    await page.locator('[name=username]').fill('admin');await page.locator('[name=password]').fill(app.password);await page.locator('[name=remember]').check({force:true});
    await page.locator('#login-form button').click({force:true});await settled();
    check('default interval is five minutes and empty statistics load once',calls===1&&await page.locator('#metrics-refresh-status').textContent().then(text=>text.includes('每 5 分鐘')));
    await addView();await advance(299999);check('no premature refresh before five minutes',calls===1);
    await advance(1);await settled();check('five-minute boundary refreshes actual server counts',calls===2&&await page.locator('[data-total=views]').textContent()==='1');
    const pending=await page.locator('#publish').textContent();await save(1);
    check('settings save immediately without creating a website publishing draft',await page.locator('#publish').textContent()===pending);
    let before=calls;await advance(180000);check('settings page makes no background statistics requests',calls===before);
    await page.reload();await until(()=>page.locator('#workspace').isVisible());await settled();
    check('saved one-minute interval survives reload/session restore',await page.locator('#metrics-refresh-status').textContent().then(text=>text.includes('每 1 分鐘')));
    await page.locator('#metrics-days').selectOption('7');await settled();
    await page.locator('.metrics-zero summary').click({force:true});await page.locator('.metrics-zero summary').focus();
    const range=await page.locator('#metrics-days').elementHandle();
    const scroll=await page.evaluate(()=>{scrollTo(0,400);return scrollY;});
    before=calls;await addView();await advance(60000);await settled();
    check('changed interval performs exactly one request per minute',calls===before+1&&await page.locator('[data-total=views]').textContent()==='2');
    check('automatic refresh preserves range control and selected date range',await range.evaluate(element=>element===document.querySelector('#metrics-days'))&&await page.locator('#metrics-days').inputValue()==='7');
    check('expanded zero-count group and keyboard focus survive refresh',await page.locator('.metrics-zero').evaluate(element=>element.open)&&await page.locator('.metrics-zero summary').evaluate(element=>element===document.activeElement));
    check('automatic refresh does not jump the reading position',Math.abs(await page.evaluate(()=>scrollY)-scroll)<=1);
    await page.locator('#refresh').click({force:true});await settled();before=calls;await advance(60000);await settled();
    check('manual refresh resets rather than duplicates automatic timers',calls===before+1);
    await page.evaluate(()=>document.querySelector('#confirm-dialog').showModal());before=calls;
    await advance(60000);check('open dialog suspends automatic reads',calls===before);await page.keyboard.press('Escape');
    await advance(60000);await settled();check('automatic schedule resumes after dialog closes',calls===before+1);
    await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
    before=calls;await advance(180000);check('background visibility event stops periodic requests',calls===before);
    await addView();await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});await settled();
    check('returning to foreground updates once with current server data',calls===before+1&&await page.locator('[data-total=views]').textContent()==='3');
    const endpoint=app.apiOrigin+'/functions/v1/dabao-cms/api/admin/metrics?*';expectedFailure=true;
    await page.route(endpoint,route=>route.fulfill({status:503,json:{error:'Local QA metrics outage'}}));
    await advance(60000);await settled();
    check('failed automatic refresh preserves last successful numbers and reports retry',await page.locator('[data-total=views]').textContent()==='3'&&await page.locator('#metrics-refresh-status').textContent().then(text=>text.includes('自動刷新失敗')));
    await page.unroute(endpoint);expectedFailure=false;await addView();await advance(60000);await settled();
    check('next automatic interval recovers after outage',await page.locator('[data-total=views]').textContent()==='4'&&await page.locator('#metrics-refresh-status').textContent().then(text=>text==='每 1 分鐘自動刷新'));
    await save(2);await dashboard();before=calls;await advance(60000);check('new two-minute setting cancels old one-minute timer',calls===before);
    await advance(60000);await settled();check('two-minute interval becomes active',calls===before+1);
    for(const size of [{width:1440,height:900},{width:1280,height:720},{width:390,height:844},{width:375,height:812}]){
        await page.setViewportSize(size);
        for(const view of ['settings','dashboard']){
            await page.locator(`[data-page=${view}]`).click({force:true});if(view==='dashboard')await settled();
            const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);report.layouts.push({...size,view,overflow});
            check(view+' '+size.width+'×'+size.height+' has no horizontal overflow',!overflow);
            if(size.width===1440||size.width===390)await page.screenshot({path:path.join(output,view+'-refresh-'+size.width+'.png'),fullPage:true});
        }
    }
    await page.locator('#logout').click({force:true});await until(()=>page.locator('#login-screen').isVisible());before=calls;
    await advance(300000);check('logout clears automatic schedule completely',calls===before);
    check('zero unexpected console/page errors',report.errors.length===0);
}catch(error){report.failure={message:error.message,stack:error.stack};process.exitCode=1;}
finally{await fs.writeFile(path.join(output,'dashboard-refresh-report.json'),JSON.stringify(report,null,2));await browser.close();await app.close();console.log(JSON.stringify({passed:report.checks.filter(check=>check.passed).length,total:report.checks.length,errors:report.errors,failure:report.failure,output},null,2));}
