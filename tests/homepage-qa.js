document.getElementById('run').addEventListener('click', async () => {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) return;
    const output = document.getElementById('results');
    const frame = document.getElementById('subject');
    frame.style.width = new URLSearchParams(location.search).get('viewport') === 'desktop' ? '1440px' : '390px';
    const button = document.getElementById('run');
    output.textContent = '';
    button.disabled = true;
    let assertions = 0;
    const assert = (condition, message) => {
        if (!condition) throw new Error(message);
        assertions++;
        output.textContent += `PASS ${message}\n`;
    };
    const load = (path) => new Promise((resolve) => {
        frame.onload = () => resolve(frame.contentWindow);
        frame.src = path;
    });
    const observe = (win) => {
        const events = [];
        win.gtag = (...args) => events.push(args);
        win.document.addEventListener('click', (event) => {
            if (event.target.closest('a')) event.preventDefault();
        });
        return events;
    };
    try {
        const win = await load('../index.html');
        const doc = win.document;
        const events = observe(win);
        assert(doc.querySelectorAll('h1').length === 1, 'One H1');
        assert(doc.querySelectorAll('#featured-feedback img').length === 6, 'Six initial testimonials');
        assert(doc.querySelectorAll('#gallery-grid img').length === 0, 'No initial full-gallery DOM');
        assert(doc.querySelectorAll('#faq details').length === 6, 'Six consultation FAQs');
        assert(doc.querySelectorAll('.home-service-card').length === 3, 'Three core services');
        const mobile = win.matchMedia('(max-width: 800px)').matches;
        const renderedFeedback = Array.from(doc.querySelectorAll('#featured-feedback .home-feedback')).filter((item) => item.getClientRects().length > 0);
        assert(renderedFeedback.length === (mobile ? 3 : 6), 'Responsive featured feedback count');
        for (const card of doc.querySelectorAll('.home-guide-card')) {
            assert(card.tagName === 'A' && card.querySelectorAll('a').length === 0, 'Whole guide card is one native keyboard-accessible link');
            assert(Boolean(card.querySelector('.home-text-link')), 'Guide card keeps visible text CTA');
        }
        for (const cta of doc.querySelectorAll('[data-event="hero_line_click"], [data-event="final_line_click"], [data-event="sticky_line_click"]')) {
            assert(cta.textContent.trim() === '我有事情想問大寶', 'Primary CTA has no external icon');
        }
        assert(doc.querySelector('.home-recording-note').textContent === '錄影檔將於雲端保留 1 個月，逾期刪除。', 'Recording retention note');
        for (const card of doc.querySelectorAll('.home-guide-card')) {
            const before = events.length;
            card.querySelector('.home-text-link').click();
            assert(events.length === before + 1 && events.at(-1)[1] === card.dataset.event, `Guide text CTA fires once: ${card.dataset.service}`);
            const keyboardBefore = events.length;
            const space = new win.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
            card.dispatchEvent(space);
            assert(space.defaultPrevented, `Guide card handles Space: ${card.dataset.service}`);
            assert(events.length === keyboardBefore + 1 && events.at(-1)[1] === card.dataset.event, `Guide Space fires once: ${card.dataset.service}`);
        }
        if (mobile) {
            const settle = () => new Promise((resolve) => win.setTimeout(resolve, 140));
            const expectFloating = async (element, shown, label, block = 'center') => {
                element.scrollIntoView({ block });
                await settle();
                const sticky = doc.getElementById('sticky-cta');
                assert(sticky.hidden === !shown, `Mobile floating CTA ${shown ? 'shown' : 'hidden'} at ${label}`);
                if (shown) {
                    const stickyRect = sticky.getBoundingClientRect();
                    const overlaps = Array.from(doc.querySelectorAll('main h1, main h2, main h3, main p, main li, main summary, main .home-button:not(#sticky-cta), main .home-text-link')).some((item) => {
                        const rect = item.getBoundingClientRect();
                        return rect.width > 0 && rect.height > 0
                            && rect.top + 8 < stickyRect.bottom && rect.bottom - 8 > stickyRect.top
                            && rect.left < stickyRect.right && rect.right > stickyRect.left;
                    });
                    assert(!overlaps, `Mobile floating CTA does not cover content at ${label}`);
                }
            };
            const expectFloatingWithin = async (element, label) => {
                const start = Math.max(0, element.offsetTop - win.innerHeight + 80);
                const end = element.offsetTop + element.offsetHeight - 64;
                const positions = element.id === 'course'
                    ? [doc.getElementById('final-cta').offsetTop - win.innerHeight + 6]
                    : Array.from({ length: Math.floor((end - start) / 40) + 1 }, (_, index) => start + index * 40);
                for (const position of positions) {
                    win.scrollTo(0, position);
                    await settle();
                    if (!doc.getElementById('sticky-cta').hidden) {
                        const stickyRect = doc.getElementById('sticky-cta').getBoundingClientRect();
                        const overlaps = Array.from(doc.querySelectorAll('main h1, main h2, main h3, main p, main li, main summary, main .home-button:not(#sticky-cta), main .home-text-link')).some((item) => {
                            const rect = item.getBoundingClientRect();
                            return rect.width > 0 && rect.height > 0
                                && rect.top + 8 < stickyRect.bottom && rect.bottom - 8 > stickyRect.top
                                && rect.left < stickyRect.right && rect.right > stickyRect.left;
                        });
                        assert(!overlaps, `Mobile floating CTA does not cover content at ${label}`);
                        return;
                    }
                }
                assert(false, `Mobile floating CTA shown within ${label}`);
            };
            assert(doc.querySelector('[data-event="hero_line_click"]').getBoundingClientRect().bottom < win.innerHeight, 'Mobile Hero CTA in first viewport');
            await expectFloating(doc.getElementById('hero'), false, 'Hero');
            for (const cta of doc.querySelectorAll('.home-service-card .home-button')) {
                await expectFloating(cta, false, `visible booking CTA: ${cta.dataset.service}`);
                await expectFloatingWithin(doc.getElementById('consultation-process'), `after ${cta.dataset.service} booking CTA leaves`);
            }
            await expectFloatingWithin(doc.getElementById('consultation-process'), 'consultation process');
            await expectFloatingWithin(doc.getElementById('faq'), 'FAQ');
            await expectFloatingWithin(doc.getElementById('course'), 'course before Final CTA enters');
            await expectFloating(doc.getElementById('final-cta'), false, 'Final CTA');
            await expectFloating(doc.getElementById('footer'), false, 'footer', 'end');
            await expectFloatingWithin(doc.getElementById('consultation-process'), 'process before menu test');
            doc.querySelector('.home-menu-toggle').click();
            assert(doc.getElementById('sticky-cta').hidden, 'Menu immediately hides floating CTA');
            doc.querySelector('.home-menu-toggle').click();
            await settle();
            doc.getElementById('testimonial-more').click();
            assert(doc.getElementById('sticky-cta').hidden, 'Gallery immediately hides floating CTA');
            doc.getElementById('feedback-gallery').close();
            win.scrollTo(0, 0);
            await settle();
            assert(doc.getElementById('sticky-cta').hidden, 'Hero stays hidden after state tests');
        } else {
            for (const selector of ['.home-service-card', '.home-price', '.home-service-card .home-button']) {
                const rects = Array.from(doc.querySelectorAll(selector)).map((item) => item.getBoundingClientRect());
                assert(Math.max(...rects.map((r) => r.bottom)) - Math.min(...rects.map((r) => r.bottom)) < 1, `Aligned desktop baseline: ${selector}`);
            }
        }
        for (const anchor of doc.querySelectorAll('a[href^="#"]')) {
            assert(Boolean(doc.getElementById(anchor.hash.slice(1))), `Valid anchor ${anchor.hash}`);
        }
        for (const cta of doc.querySelectorAll('a[href="https://lin.ee/y2XVa6h"]')) {
            assert(cta.target === '_blank' && cta.relList.contains('noopener') && cta.relList.contains('noreferrer'), `Safe LINE new tab: ${cta.dataset.location}`);
        }
        const required = ['hero_line_click', 'service_guide_complete_click', 'service_guide_annual_click', 'service_guide_divination_click', 'service_complete_booking_click', 'service_annual_booking_click', 'service_divination_booking_click', 'testimonial_more_click', 'booking_system_click', 'course_click', 'final_line_click'];
        for (const name of required) {
            const cta = doc.querySelector(`[data-event="${name}"]`);
            const before = events.length;
            cta.click();
            assert(events.length === before + 1 && events.at(-1)[0] === 'event' && events.at(-1)[1] === name, `Exactly one ${name}`);
            if (cta.dataset.service) assert(events.at(-1)[2].service === cta.dataset.service, `${name} service parameter`);
            doc.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close());
        }
        assert(doc.querySelectorAll('#gallery-grid img').length >= 78, 'Full gallery retains all local images');
        for (const detail of doc.querySelectorAll('#faq details')) {
            const before = events.filter((e) => e[1] === 'faq_open').length;
            const opened = new Promise((resolve) => detail.addEventListener('toggle', resolve, { once: true }));
            detail.open = true;
            await opened;
            assert(events.filter((e) => e[1] === 'faq_open').length === before + 1, `FAQ tracks opening: ${detail.querySelector('summary').textContent}`);
            const closed = new Promise((resolve) => detail.addEventListener('toggle', resolve, { once: true }));
            detail.open = false;
            await closed;
            assert(events.filter((e) => e[1] === 'faq_open').length === before + 1, 'FAQ closing does not emit');
        }
        for (const value of ['complete', 'annual', 'divination', 'invalid']) {
            const booking = await load(`../booking.html?service=${value}`);
            const bookingEvents = observe(booking);
            booking.document.getElementById('booking-system-link').click();
            assert(bookingEvents.length === 1 && bookingEvents[0][1] === 'booking_system_click', `One booking event for ${value}`);
            assert(bookingEvents[0][2].service === (value === 'invalid' ? 'unspecified' : value), `Whitelisted booking service ${value}`);
        }
        const offlineResponse = await fetch('../index.html', { cache: 'no-store' });
        const offlineSource = new DOMParser().parseFromString(await offlineResponse.text(), 'text/html');
        assert(Boolean(offlineSource.getElementById('cms-sdk')), `Current homepage source loaded for offline test (${offlineResponse.status})`);
        offlineSource.getElementById('cms-sdk').removeAttribute('src');
        const base = offlineSource.createElement('base');
        base.href = new URL('../', location.href).href;
        offlineSource.head.prepend(base);
        const offlineLoaded = new Promise((resolve) => { frame.onload = resolve; });
        frame.srcdoc = '<!DOCTYPE html>' + offlineSource.documentElement.outerHTML;
        await offlineLoaded;
        const offline = frame.contentWindow;
        const offlineEvents = observe(offline);
        assert(!offline.supabase, 'Simulated unavailable CMS SDK');
        offline.document.querySelector('.home-menu-toggle').click();
        assert(offline.document.querySelector('.home-menu-toggle').getAttribute('aria-expanded') === 'true', 'Menu works without CMS');
        offline.document.querySelector('[data-event="hero_line_click"]').click();
        assert(offlineEvents.at(-1)[1] === 'hero_line_click', 'Tracking works without CMS');
        offline.document.getElementById('testimonial-more').click();
        assert(offline.document.querySelectorAll('#gallery-grid img').length === 78, 'Local gallery works without CMS');
        offline.document.getElementById('feedback-gallery').close();
        output.textContent += `\n${assertions} assertions passed`;
    } catch (error) {
        output.textContent += `\nFAIL ${error.message}`;
    } finally {
        frame.removeAttribute('srcdoc');
        frame.src = 'about:blank';
        button.disabled = false;
    }
});
