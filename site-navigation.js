(() => {
    'use strict';

    const nav = document.querySelector('[data-site-nav]');
    if (!nav) return;
    const toggle = nav.querySelector('.site-menu-toggle');
    const menu = nav.querySelector('.nav-links');
    const setMenu = (open) => {
        menu.classList.toggle('is-open', open);
        document.body.classList.toggle('site-menu-open', open);
        toggle.setAttribute('aria-expanded', String(open));
        toggle.setAttribute('aria-label', open ? '關閉選單' : '開啟選單');
        toggle.title = open ? '關閉選單' : '開啟選單';
    };
    toggle.addEventListener('click', () => setMenu(toggle.getAttribute('aria-expanded') !== 'true'));
    menu.addEventListener('click', (event) => { if (event.target.closest('a')) setMenu(false); });
    document.addEventListener('click', (event) => { if (!nav.contains(event.target)) setMenu(false); });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
            setMenu(false);
            toggle.focus();
        }
    });
    window.matchMedia('(min-width: 801px)').addEventListener('change', (event) => {
        if (event.matches) setMenu(false);
    });
})();
