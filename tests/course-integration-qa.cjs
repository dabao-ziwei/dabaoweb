const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { chromium } = require('playwright');
const sharp = require('sharp');

const base = process.env.QA_BASE_URL || 'http://127.0.0.1:4273';
const output = process.env.QA_OUTPUT || path.resolve(__dirname, '../../../outputs/course-v2-integration');
fs.mkdirSync(output, { recursive: true });
const results = { checks: [], layouts: [], flows: [], tracking: [], consoleErrors: [], assetErrors: [] };
const gaEvents = [];
const check = (name, passed, detail) => {
    results.checks.push({ name, passed: Boolean(passed), ...(detail === undefined ? {} : { detail }) });
    if (!passed) console.error(`FAIL ${name}: ${JSON.stringify(detail)}`);
};

// Stub optional CMS reads and analytics transport, never write to live data or send test conversions.
const cmsStub = `var supabase = { createClient: () => ({ from: (table) => {
    const result = () => Promise.resolve({ data: table === 'site_settings' ? { setting_value: false } : table === 'announcements' ? null : [], error: null });
    const query = { select: () => query, eq: () => query, order: () => query, single: result, then: (resolve, reject) => result().then(resolve, reject) };
    return query;
} }) };`;

async function prepare(context) {
    await context.exposeBinding('__qaRecordGA', (_source, event) => { gaEvents.push(event); });
    await context.addInitScript(() => {
        window.dataLayer = [];
        const push = window.dataLayer.push.bind(window.dataLayer);
        window.dataLayer.push = (...items) => {
            items.forEach(item => { if (item?.[0] === 'event') window.__qaRecordGA(Array.from(item)); });
            return push(...items);
        };
    });
    await context.route('https://www.googletagmanager.com/**', r => r.fulfill({ contentType: 'application/javascript', body: '' }));
    await context.route(/https:\/\/([^/]+\.)?(google-analytics\.com|analytics\.google\.com|facebook\.com|connect\.facebook\.net)\//, r => r.fulfill({ contentType: 'application/javascript', body: '' }));
    await context.route('https://cdn.jsdelivr.net/npm/@supabase/**', r => r.fulfill({ contentType: 'application/javascript', body: cmsStub }));
    await context.route('https://*.supabase.co/**', r => r.fulfill({ contentType: 'application/json', body: '[]' }));
    // Exercise the native target=_blank path without contacting LINE or the booking system.
    await context.route('https://lin.ee/**', r => r.fulfill({ contentType: 'text/html', body: '<title>LINE destination intercepted</title>' }));
    await context.route('https://ziweiapp.dabao.life/**', r => r.fulfill({ contentType: 'text/html', body: '<title>Booking destination intercepted</title>' }));
}

async function open(page, file) {
    await page.goto(`${base}/${file}`, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
}

async function inspect(page, file, size) {
    const data = await page.evaluate(() => {
        const ids = [...document.querySelectorAll('[id]')].map(e => e.id);
        return {
            width: innerWidth, height: innerHeight, pageHeight: document.documentElement.scrollHeight,
            overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
            h1: document.querySelectorAll('h1').length,
            duplicateIds: [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))],
            invalidHashes: [...document.querySelectorAll('a[href^="#"]')].filter(a => a.hash && !document.getElementById(decodeURIComponent(a.hash.slice(1)))).map(a => a.getAttribute('href')),
            brokenImages: [...document.images].filter(i => i.getAttribute('src') && i.loading !== 'lazy' && (!i.complete || !i.naturalWidth)).map(i => i.src),
            sections: [...document.querySelectorAll('main > section')].map(s => ({ id: s.id || s.className, top: Math.round(s.getBoundingClientRect().top + scrollY), height: Math.round(s.getBoundingClientRect().height) })),
            testimonials: [...document.querySelectorAll('.testimonial-card')].filter(e => !e.hidden).length,
            heroCtas: [...document.querySelectorAll('#hero .hero-actions a')].map(a => ({ text: a.textContent.trim(), bottom: Math.round(a.getBoundingClientRect().bottom) }))
        };
    });
    results.layouts.push({ file, size, ...data });
    check(`${file} ${size.width} overflow`, !data.overflow, data.pageHeight);
    check(`${file} ${size.width} IDs/anchors/assets`, !data.duplicateIds.length && !data.invalidHashes.length && !data.brokenImages.length, data);
    if (file === 'course.html') {
        check(`course ${size.width} headings`, data.h1 === 1);
        check(`course ${size.width} first-screen CTA`, data.heroCtas.every(c => c.bottom <= size.height), data.heroCtas);
        check(`course ${size.width} visible stories`, data.testimonials === (size.width <= 800 ? 1 : 3), data.testimonials);
    }
    return data;
}

async function menuCheck(page, selector, target) {
    const toggle = page.locator(selector);
    await toggle.click();
    check(`${target} menu opens`, await toggle.getAttribute('aria-expanded') === 'true');
    await page.keyboard.press('Escape');
    check(`${target} menu Escape/focus`, await toggle.getAttribute('aria-expanded') === 'false' && await toggle.evaluate(e => e === document.activeElement));
}

async function trackClick(page, selector, expectedAction) {
    const before = gaEvents.length;
    await page.locator(selector).click();
    await page.waitForTimeout(30);
    const events = gaEvents.slice(before);
    results.tracking.push({ selector, events });
    check(`GA single click ${selector}`, events.length === 1 && events[0][1] === 'click' && events[0][2].cta_action === expectedAction, events);
}

(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: process.env.QA_CHROMIUM || chromium.executablePath() });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'Asia/Taipei', reducedMotion: 'reduce' });
    await prepare(context);
    const page = await context.newPage();
    page.on('pageerror', e => results.consoleErrors.push({ url: page.url(), message: e.message }));
    page.on('console', e => { if (e.type() === 'error') results.consoleErrors.push({ url: page.url(), message: e.text() }); });
    page.on('response', r => { if (r.url().startsWith(base) && r.status() >= 400) results.assetErrors.push({ url: r.url(), status: r.status() }); });
    try {
        for (const size of [{ width: 1440, height: 900 }, { width: 1280, height: 720 }, { width: 390, height: 844 }, { width: 375, height: 812 }]) {
            await page.setViewportSize(size);
            for (const file of ['course.html', 'index.html', 'booking.html', 'faq.html', 'ziwei-beginner-course.html', 'articles.html', 'chart.html', 'new_articles.html', 'article_view.html']) {
                await open(page, file);
                await inspect(page, file, size);
            }
        }

        await page.setViewportSize({ width: 375, height: 812 });
        await open(page, 'course.html');
        await menuCheck(page, '.menu-toggle', 'course');
        const initialStoryHeight = await page.locator('#student-story').evaluate(e => Math.round(e.getBoundingClientRect().height));
        await page.locator('.stories-toggle').press('Enter');
        check('mobile reveal both additional stories', await page.locator('.testimonial-card:visible').count() === 3);
        await page.locator('.stories-toggle').press('Space');
        check('mobile collapse additional stories', await page.locator('.testimonial-card:visible').count() === 1);
        check('mobile story height improves', initialStoryHeight < 1800, initialStoryHeight);
        await page.locator('.stories-toggle').click();
        const summaries = page.locator('details > summary');
        for (let i = 0; i < await summaries.count(); i++) {
            await summaries.nth(i).press('Enter');
            check(`details ${i} opens`, await summaries.nth(i).evaluate(e => e.parentElement.open));
            await summaries.nth(i).press('Enter');
            check(`details ${i} closes/focus-visible`, await summaries.nth(i).evaluate(e => !e.parentElement.open && getComputedStyle(e).outlineStyle === 'solid'));
        }
        await page.locator('#hero a[href="#learning-path"]').click();
        check('sticky anchor clearance', await page.locator('#learning-path').evaluate(e => e.getBoundingClientRect().top >= document.querySelector('header').getBoundingClientRect().bottom));
        check('reduced motion', await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior === 'auto'));

        await page.setViewportSize({ width: 1440, height: 900 });
        await open(page, 'course.html');
        check('GA one config', await page.evaluate(() => window.dataLayer.filter(x => x[0] === 'config' && x[1] === 'G-0XPZVQ42QP').length === 1));
        check('GA pageview default enabled', await page.evaluate(() => window.dataLayer.find(x => x[0] === 'config')?.[2]?.send_page_view !== false));
        for (const [selector, action] of [['.nav-button', 'enrollment'], ['#hero .button', 'learning_path'], ['#hero .text-link', 'enrollment'], ['.path-enrollment-link', 'enrollment']]) await trackClick(page, selector, action);
        for (const selector of ['#enrollment a[data-course-cta="line"]', '.final-section a[data-course-cta="line"]']) {
            const popup = page.waitForEvent('popup');
            await trackClick(page, selector, 'line');
            const child = await popup;
            await child.waitForLoadState();
            check(`LINE new tab ${selector}`, child.url() === 'https://lin.ee/y2XVa6h' && page.url().includes('/course.html'));
            await child.close();
        }
        for (const location of ['enrollment', 'final']) {
            await open(page, 'course.html');
            await trackClick(page, `a[data-course-cta="beginner_lp"][data-location="${location}"]`, 'beginner_lp');
            await page.waitForURL('**/ziwei-beginner-course.html');
            check(`Course to beginner ${location}`, true);
        }
        const lpSchema = await page.locator('#beginner-course-schema').textContent();
        const parsed = JSON.parse(lpSchema);
        check('beginner schema price/date', parsed.offers.price === 25000 && parsed.hasCourseInstance.startDate === '2026-11-09T19:00:00+08:00' && parsed.offers.validThrough === '2026-11-08', parsed);
        check('beginner dates and price displayed', await page.locator('body').innerText().then(s => s.includes('2026/11/9') && s.includes('2026/11/8') && s.includes('NT$25,000') && !s.includes('21,500') && !s.includes('19,800')));
        check('Meta one init/PageView/ViewContent', await page.evaluate(() => { const q = window.fbq.queue.map(x => Array.from(x)); return q.filter(x => x[0] === 'init').length === 1 && q.filter(x => x[1] === 'PageView').length === 1 && q.filter(x => x[1] === 'ViewContent').length === 1; }));
        for (const label of ['hero', 'pricing', 'final']) {
            const selector = `.js-line-cta[data-label="${label}"]`;
            const prior = await page.evaluate(() => ({ ga: window.dataLayer.filter(x => x[0] === 'event' && x[1] === 'generate_lead').length, meta: window.fbq.queue.filter(x => x[1] === 'Lead').length }));
            const popup = page.waitForEvent('popup');
            await page.locator(selector).click();
            const child = await popup;
            await child.waitForLoadState();
            const after = await page.evaluate(() => ({ ga: window.dataLayer.filter(x => x[0] === 'event' && x[1] === 'generate_lead').length, meta: window.fbq.queue.filter(x => x[1] === 'Lead').length }));
            check(`LP Lead exactly once ${label}`, after.ga === prior.ga + 1 && after.meta === prior.meta + 1);
            check(`LP LINE new tab ${label}`, child.url() === 'https://lin.ee/y2XVa6h' && page.url().includes('ziwei-beginner-course.html'));
            await child.close();
        }
        await page.locator('#pricing').scrollIntoViewIfNeeded();
        await page.waitForTimeout(100);
        check('LP view_pricing once', await page.evaluate(() => window.dataLayer.filter(x => x[1] === 'view_pricing').length === 1));

        const runFlow = async (name, run) => { await run(); results.flows.push({ name, passed: true }); };
        await runFlow('A first course visit', async () => {
            await open(page, 'index.html');
            await page.locator('#home-menu a[href="course.html"]').click();
            await page.waitForURL('**/course.html');
            await page.locator('#hero .button').click();
            await page.waitForURL(/#learning-path$/);
            await page.locator('.path-enrollment-link').click();
            await page.waitForURL(/#enrollment$/);
            await page.locator('#enrollment .button').click();
            await page.waitForURL('**/ziwei-beginner-course.html');
            const promise = page.waitForEvent('popup'); await page.locator('.js-line-cta').first().click(); const popup = await promise; await popup.close();
        });
        await runFlow('B directly find beginner', async () => {
            await open(page, 'index.html'); await page.locator('#course a').click(); await page.waitForURL('**/course.html');
            await page.locator('.nav-button').click(); await page.locator('#enrollment .button').click(); await page.waitForURL('**/ziwei-beginner-course.html');
        });
        await runFlow('C teaching articles to course', async () => {
            await open(page, 'articles.html'); await page.getByRole('link', { name: '了解實戰紫微斗數課程', exact: true }).click(); await page.waitForURL('**/course.html');
            await page.locator('#enrollment .button').click(); await page.waitForURL('**/ziwei-beginner-course.html');
        });
        await runFlow('D return to consulting', async () => {
            await open(page, 'course.html'); await page.locator('#site-menu a[href="index.html#services"]').click(); await page.waitForURL('**/index.html#services');
            await page.locator('a[href="booking.html?service=complete"]').last().click(); await page.waitForURL('**/booking.html?service=complete');
        });
        await runFlow('E beginner back to overview and home', async () => {
            await open(page, 'ziwei-beginner-course.html'); await page.locator('.lp-overview-link').click(); await page.waitForURL('**/course.html');
            await page.locator('header .brand').click(); await page.waitForURL('**/index.html');
        });
        await runFlow('F mobile course registration', async () => {
            await page.setViewportSize({ width: 375, height: 812 }); await open(page, 'index.html');
            await page.locator('.home-menu-toggle').click(); await page.locator('#home-menu a[href="course.html"]').click(); await page.waitForURL('**/course.html');
            await page.locator('.menu-toggle').click(); await page.locator('.nav-button').click(); await page.locator('#enrollment .button').click(); await page.waitForURL('**/ziwei-beginner-course.html');
            const promise = page.waitForEvent('popup'); await page.locator('.js-line-cta').first().click(); const popup = await promise; await popup.close();
        });
        for (const file of ['index.html', 'booking.html', 'faq.html']) {
            await open(page, file);
            const text = await page.locator('body').textContent();
            check(`${file} Meet recording policy`, text.includes('紫微占卜不提供錄影') || text.includes('不提供錄影'));
            check(`${file} no LINE voice`, !text.includes('LINE 語音'));
            await menuCheck(page, file === 'index.html' ? '.home-menu-toggle' : '.site-menu-toggle', file);
        }
        for (const file of ['articles.html', 'chart.html', 'new_articles.html', 'article_view.html']) {
            await open(page, file);
            await menuCheck(page, '.site-menu-toggle', file);
        }
        await page.setViewportSize({ width: 1440, height: 900 });
        await open(page, 'course.html');
        check('course SEO', await page.evaluate(() => document.querySelector('link[rel="canonical"]').href === 'https://dabao.life/course.html' && document.querySelector('meta[name="robots"]').content === 'index, follow' && !document.title.includes('Preview') && Boolean(document.querySelector('meta[name="description"]').content)));
        check('Course JSON-LD no invented dates/ratings', await page.evaluate(() => { const data = JSON.parse(document.querySelector('script[type="application/ld+json"]').textContent); return data['@type'] === 'Course' && !data.aggregateRating && !data.startDate && data.url === 'https://dabao.life/course.html'; }));
        for (const size of [{ width: 1440, height: 900 }, { width: 1280, height: 720 }, { width: 390, height: 844 }, { width: 375, height: 812 }]) {
            await page.setViewportSize(size); await open(page, 'course.html');
            const fullPage = await page.screenshot({ path: path.join(output, `course-${size.width}-full.png`), fullPage: true });
            if (size.width === 1440 || size.width === 390) {
                for (const [name, selector] of [['hero', '#hero'], ['testimonials', '#student-story'], ['learning-path', '#learning-path'], ['enrollment', '#enrollment'], ['class-format', '.format-section']]) {
                    const rect = await page.locator(selector).boundingBox();
                    await sharp(fullPage).extract({ left: 0, top: Math.round(rect.y), width: size.width, height: Math.round(rect.height) }).toFile(path.join(output, `${name}-${size.width}.png`));
                }
            }
        }

        const courseScript = fs.readFileSync(path.resolve(__dirname, '..', 'course-data.js'), 'utf8');
        for (const [now, expectedOpen] of [['2026-10-22T12:00:00+08:00', true], ['2026-11-09T00:00:00+08:00', false]]) {
            const NativeDate = Date;
            class FixedDate extends NativeDate { constructor(...args) { super(...(args.length ? args : [now])); } }
            const schema = { textContent: '' };
            const sandbox = { window: {}, document: { querySelectorAll: () => [], querySelector: () => null, getElementById: id => id === 'beginner-course-schema' ? schema : null }, Date: FixedDate };
            vm.runInNewContext(courseScript, sandbox);
            check(`enrollment expiry ${now}`, sandbox.window.DabaoCourse.open === expectedOpen && Boolean(JSON.parse(schema.textContent).hasCourseInstance) === expectedOpen);
        }

        const hrefs = new Set();
        for (const file of ['index.html', 'course.html', 'ziwei-beginner-course.html', 'booking.html', 'faq.html', 'articles.html', 'chart.html', 'new_articles.html', 'article_view.html']) {
            await open(page, file);
            const localHrefs = await page.locator('a[href]').evaluateAll(links => links.map(a => a.href).filter(href => href.startsWith(location.origin) && !href.includes('#')));
            localHrefs.forEach(href => hrefs.add(href));
        }
        for (const href of hrefs) {
            const response = await context.request.get(href);
            check(`local link ${new URL(href).pathname}${new URL(href).search}`, response.status() === 200, response.status());
        }

        for (const name of ['course.html', 'ziwei-beginner-course.html', 'index.html', 'booking.html', 'faq.html', 'articles.html', 'chart.html', 'article_view.html', 'new_articles.html']) {
            const html = fs.readFileSync(path.resolve(__dirname, '..', name), 'utf8');
            for (const match of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
                if (/type="application\/(ld\+)?json"/.test(match[1])) JSON.parse(match[2]);
                else if (match[2].trim()) new vm.Script(match[2], { filename: name });
            }
        }
        check('inline JavaScript and JSON syntax', true);
    } catch (error) {
        check('unhandled QA failure', false, error.stack);
        await page.screenshot({ path: path.join(output, 'qa-failure.png'), fullPage: true }).catch(() => {});
    } finally {
        check('console zero errors', results.consoleErrors.length === 0, results.consoleErrors);
        check('local assets zero errors', results.assetErrors.length === 0, results.assetErrors);
        fs.writeFileSync(path.join(output, 'qa-results.json'), JSON.stringify(results, null, 2));
        console.log(JSON.stringify({ passed: results.checks.filter(x => x.passed).length, failed: results.checks.filter(x => !x.passed), layouts: results.layouts.length, flows: results.flows, output }, null, 2));
        await browser.close();
        if (results.checks.some(x => !x.passed)) process.exitCode = 1;
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
