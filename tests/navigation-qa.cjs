const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const base = process.env.QA_BASE_URL || 'http://127.0.0.1:4281';
const output = process.env.QA_OUTPUT || path.resolve(__dirname, '../../../outputs/unified-site-navigation');
fs.mkdirSync(output, { recursive: true });
const results = { layouts: [], errors: [] };
const expected = ['首頁', '諮詢服務', '紫微課程', '教學文章', '線上排盤', '常見問題', '預約諮詢'];

(async () => {
    const browser = await chromium.launch({ executablePath: process.env.QA_CHROMIUM });
    try {
        const context = await browser.newContext({ reducedMotion: 'reduce' });
        // Isolate optional content and conversion transports from production services.
        await context.route('https://www.googletagmanager.com/**', r => r.fulfill({ body: '', contentType: 'application/javascript' }));
        await context.route('https://*.google-analytics.com/**', r => r.fulfill({ body: '' }));
        await context.route('https://cdn.jsdelivr.net/npm/@supabase/**', r => r.fulfill({
            contentType: 'application/javascript',
            body: `var supabase = {createClient: () => ({from: () => {
                const result = () => Promise.resolve({data: null, error: null});
                const q = {select: () => q, eq: () => q, order: () => q, single: result, then: (a,b) => result().then(a,b)};
                return q;
            }})};`
        }));
        await context.route('https://lin.ee/**', r => r.fulfill({ body: '<title>Intercepted LINE</title>', contentType: 'text/html' }));
        const page = await context.newPage();
        page.on('pageerror', error => results.errors.push(error.message));
        page.on('console', message => { if (message.type() === 'error') results.errors.push(message.text()); });
        for (const size of [{ width: 1440, height: 900 }, { width: 1280, height: 720 }, { width: 820, height: 900 }, { width: 390, height: 844 }, { width: 375, height: 812 }]) {
            await page.setViewportSize(size);
            const pair = [];
            for (const file of ['index.html', 'course.html']) {
                await page.goto(`${base}/${file}`, { waitUntil: 'networkidle' });
                await page.evaluate(() => document.fonts.ready);
                const header = page.locator('.dabao-header');
                const toggle = header.getByRole('button');
                if (size.width <= 800) {
                    await toggle.click();
                    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
                    await page.keyboard.press('Escape');
                    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
                    assert(await toggle.evaluate(e => e === document.activeElement));
                    await toggle.press('Enter');
                    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
                }
                const state = await header.evaluate(el => {
                    const rect = e => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(n => Math.round(n * 100) / 100); };
                    const links = [...el.querySelectorAll(':is(.home-menu, .site-menu) > a')];
                    return {
                        header: rect(el),
                        links: links.map(a => ({ text: a.textContent.trim(), href: a.href, rect: rect(a) })),
                        current: el.querySelector('[aria-current="page"]').textContent.trim(),
                        overflow: document.documentElement.scrollWidth > innerWidth
                    };
                });
                assert.deepEqual(state.links.map(a => a.text), expected);
                assert.equal(state.current, file === 'index.html' ? '首頁' : '紫微課程');
                assert.equal(state.overflow, false);
                const cta = header.getByRole('link', { name: '預約諮詢', exact: true });
                assert.equal(await cta.getAttribute('target'), '_blank');
                assert.equal(await cta.getAttribute('rel'), 'noopener noreferrer');
                const before = page.url();
                const popupPromise = page.waitForEvent('popup');
                await cta.click();
                const popup = await popupPromise;
                await popup.waitForLoadState();
                assert.equal(popup.url(), 'https://lin.ee/y2XVa6h');
                assert.equal(page.url(), before);
                await popup.close();
                const events = await page.evaluate(() => window.dataLayer.filter(x => x[0] === 'event' && (x[1] === 'nav_line_click' || x[2]?.cta_location === 'navigation')).map(x => Array.from(x)));
                assert.equal(events.length, 1);
                if (size.width <= 800) {
                    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
                    await toggle.click();
                }
                await page.screenshot({ path: path.join(output, `${file.replace('.html', '')}-navigation-${size.width}.png`) });
                pair.push(state);
                results.layouts.push({ file, size, ...state, events });
            }
            assert.deepEqual(pair[0].header, pair[1].header);
            assert.deepEqual(pair[0].links.map(a => a.rect), pair[1].links.map(a => a.rect));
            assert.deepEqual(pair[0].links.map(a => a.href.split('#')[0]), pair[1].links.map(a => a.href.split('#')[0]));
        }
        assert.deepEqual(results.errors, []);
        console.log('PASS: 10 page/viewports; identical navigation geometry, labels and destinations; mobile keyboard/Escape; one analytics event per CTA; LINE new tab; zero overflow/console errors.');
    } finally {
        fs.writeFileSync(path.join(output, 'navigation-qa.json'), JSON.stringify(results, null, 2));
        await browser.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
