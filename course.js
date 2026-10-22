(() => {
    'use strict';

    const toggle = document.querySelector('.menu-toggle');
    const menu = document.getElementById('site-menu');
    const mobile = window.matchMedia('(max-width: 800px)');
    const storiesToggle = document.querySelector('.stories-toggle');
    const extraStories = [...document.querySelectorAll('.testimonial-card')].slice(1);
    let storiesExpanded = false;

    extraStories.forEach((story, index) => { story.id = `student-story-0${index + 2}`; });
    const updateStories = () => {
        const collapsed = mobile.matches && !storiesExpanded;
        extraStories.forEach((story) => { story.hidden = collapsed; });
        storiesToggle.hidden = !mobile.matches;
        storiesToggle.setAttribute('aria-expanded', String(!collapsed));
        storiesToggle.textContent = storiesExpanded ? '收合另外 2 位學員的故事 −' : '再看 2 位學員的故事 ＋';
    };
    storiesToggle.addEventListener('click', () => {
        storiesExpanded = !storiesExpanded;
        updateStories();
        if (!storiesExpanded) storiesToggle.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    });
    mobile.addEventListener('change', updateStories);
    updateStories();

    // Preserve the existing GA event and labels, with explicit destinations for V2 paths.
    document.addEventListener('click', (event) => {
        const link = event.target.closest('a[data-course-cta]');
        if (!link || typeof window.gtag !== 'function') return;
        const location = link.dataset.location;
        const labels = {
            hero: '課程頁頁首按鈕',
            enrollment: '課程頁招生區塊按鈕',
            final: '課程頁底部按鈕'
        };
        window.gtag('event', 'click', {
            event_category: 'CTA',
            event_label: labels[location] || `課程頁${location}按鈕`,
            cta_action: link.dataset.courseCta,
            cta_location: location,
            link_url: link.href,
            page_type: 'course_overview'
        });
    });

    const setMenu = (open) => {
        menu.classList.toggle('is-open', open);
        toggle.setAttribute('aria-expanded', String(open));
        toggle.setAttribute('aria-label', open ? '關閉選單' : '開啟選單');
        toggle.title = open ? '關閉選單' : '開啟選單';
        document.body.classList.toggle('menu-open', open);
    };

    toggle.addEventListener('click', () => setMenu(!menu.classList.contains('is-open')));
    menu.addEventListener('click', (event) => {
        if (event.target.closest('a')) setMenu(false);
    });
    document.addEventListener('click', (event) => {
        if (!event.target.closest('.site-nav')) setMenu(false);
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && menu.classList.contains('is-open')) {
            setMenu(false);
            toggle.focus();
        }
    });
    window.matchMedia('(min-width: 801px)').addEventListener('change', (event) => {
        if (event.matches) setMenu(false);
    });
})();
