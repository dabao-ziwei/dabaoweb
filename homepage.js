(() => {
    'use strict';

    const menu = document.getElementById('home-menu');
    const menuToggle = document.querySelector('.home-menu-toggle');
    const sticky = document.getElementById('sticky-cta');
    const hero = document.getElementById('hero');
    const finalCta = document.getElementById('final-cta');
    const faq = document.getElementById('faq');
    const gallery = document.getElementById('feedback-gallery');
    const galleryGrid = document.getElementById('gallery-grid');
    const moreButton = document.getElementById('testimonial-more');
    const lightbox = document.getElementById('image-lightbox');
    const lightboxImage = document.getElementById('image-lightbox-img');
    const mobile = window.matchMedia('(max-width: 800px)');
    const testimonials = document.getElementById('testimonials');
    const footer = document.getElementById('footer');
    const serviceBookingCtas = Array.from(document.querySelectorAll('.home-service-card .home-button'));
    const localFeedback = Array.from({ length: 78 }, (_, i) => ({
        src: `images/${String(i + 1).padStart(3, '0')}.jpeg`,
        alt: `第 ${i + 1} 則真實諮詢回饋截圖`
    }));
    let feedback = localFeedback;
    let galleryDirty = true;
    let scrollFrame = 0;
    let scrollTimer = 0;

    const track = (name, params = {}) => {
        if (typeof window.gtag === 'function') {
            window.gtag('event', name, { ...params, page_type: 'homepage' });
        }
    };

    const visible = (element) => {
        const rect = element.getBoundingClientRect();
        return rect.bottom > 64 && rect.top < window.innerHeight;
    };

    const updateSticky = () => {
        scrollFrame = 0;
        if (mobile.matches) {
            const intersectsViewport = (element) => {
                const rect = element.getBoundingClientRect();
                return rect.bottom > 64 && rect.top < window.innerHeight;
            };
            const clearlyVisible = (element) => {
                const rect = element.getBoundingClientRect();
                return rect.top >= 64 && rect.bottom <= window.innerHeight - 8;
            };
            sticky.hidden = false;
            const stickyRect = sticky.getBoundingClientRect();
            const wouldCoverContent = Array.from(document.querySelectorAll('main h1, main h2, main h3, main p, main li, main summary, main .home-button:not(#sticky-cta), main .home-text-link')).some((element) => {
                const rect = element.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0
                    && rect.top + 8 < stickyRect.bottom && rect.bottom - 8 > stickyRect.top
                    && rect.left < stickyRect.right && rect.right > stickyRect.left;
            });
            sticky.hidden = testimonials.getBoundingClientRect().bottom > 64
                || serviceBookingCtas.some(clearlyVisible)
                || wouldCoverContent
                || finalCta.getBoundingClientRect().top < stickyRect.bottom
                || intersectsViewport(footer)
                || menu.classList.contains('is-open')
                || Boolean(document.querySelector('dialog[open]'));
            return;
        }
        const importantButtonVisible = Array.from(document.querySelectorAll('main .home-button')).some(visible);
        const floatingLeft = mobile.matches ? 16 : document.documentElement.clientWidth - 288;
        const wouldCoverControl = Array.from(document.querySelectorAll('main a, main button, main summary')).some((element) => {
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.bottom > window.innerHeight - 100 && rect.top < window.innerHeight
                && rect.right > floatingLeft && rect.left < document.documentElement.clientWidth - 16;
        });
        // Hide throughout FAQ reading and whenever a regular CTA already occupies the viewport.
        sticky.hidden = hero.getBoundingClientRect().bottom > 64
            || finalCta.getBoundingClientRect().top < window.innerHeight + 80
            || visible(faq)
            || importantButtonVisible
            || wouldCoverControl
            || menu.classList.contains('is-open')
            || Boolean(document.querySelector('dialog[open]'));
    };
    const scheduleSticky = () => {
        if (!scrollFrame) scrollFrame = requestAnimationFrame(updateSticky);
    };
    const setMenu = (open) => {
        if (open) sticky.hidden = true;
        menu.classList.toggle('is-open', open);
        menuToggle.setAttribute('aria-expanded', String(open));
        menuToggle.setAttribute('aria-label', open ? '關閉選單' : '開啟選單');
        menuToggle.title = open ? '關閉選單' : '開啟選單';
        scheduleSticky();
    };
    menuToggle.addEventListener('click', () => setMenu(!menu.classList.contains('is-open')));
    menu.addEventListener('click', (event) => {
        if (event.target.closest('a')) setMenu(false);
    });
    document.querySelectorAll('.home-guide-card').forEach((card) => {
        card.addEventListener('keydown', (event) => {
            if (event.key !== ' ') return;
            event.preventDefault();
            card.click();
        });
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && menu.classList.contains('is-open')) {
            setMenu(false);
            menuToggle.focus();
        }
    });
    document.addEventListener('click', (event) => {
        if (!event.target.closest('.home-nav')) setMenu(false);
        const cta = event.target.closest('[data-event]');
        if (cta) {
            track(cta.dataset.event, {
                cta_location: cta.dataset.location,
                ...(cta.dataset.service ? { service: cta.dataset.service } : {}),
                ...(cta.href ? { link_url: cta.href } : {})
            });
        }
        const imageButton = event.target.closest('.home-feedback');
        if (imageButton) {
            const image = imageButton.querySelector('img');
            lightboxImage.src = image.currentSrc || image.src;
            lightboxImage.alt = image.alt;
            document.getElementById('original-image').href = lightboxImage.src;
            openDialog(lightbox);
        }
        const closeButton = event.target.closest('[data-close-dialog]');
        if (closeButton) closeButton.closest('dialog').close();
    });
    faq.querySelectorAll('details').forEach((detail) => {
        detail.addEventListener('toggle', () => {
            if (detail.open) track('faq_open', { question: detail.querySelector('summary').textContent });
            scheduleSticky();
        });
    });

    const syncDialogs = () => {
        document.body.classList.toggle('home-dialog-open', Boolean(document.querySelector('dialog[open]')));
        scheduleSticky();
    };
    const openDialog = (dialog) => {
        sticky.hidden = true;
        dialog.showModal();
        syncDialogs();
    };
    document.querySelectorAll('dialog').forEach((dialog) => {
        dialog.addEventListener('close', syncDialogs);
        dialog.addEventListener('click', (event) => {
            const rect = dialog.getBoundingClientRect();
            if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
        });
    });
    const updateFeedbackCount = () => {
        moreButton.textContent = `查看 ${feedback.length} 則真實諮詢回饋 →`;
        document.getElementById('gallery-title').textContent = `${feedback.length} 則真實諮詢回饋`;
    };
    const renderGallery = () => {
        if (!galleryDirty) return;
        const fragment = document.createDocumentFragment();
        feedback.forEach(({ src, alt }) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'home-feedback';
            button.setAttribute('aria-label', `查看${alt}大圖`);
            const image = document.createElement('img');
            image.src = src;
            image.alt = alt;
            image.loading = 'lazy';
            button.append(image);
            fragment.append(button);
        });
        galleryGrid.replaceChildren(fragment);
        galleryDirty = false;
    };
    moreButton.addEventListener('click', () => {
        renderGallery();
        openDialog(gallery);
    });
    updateFeedbackCount();
    window.addEventListener('scroll', () => {
        scheduleSticky();
        window.clearTimeout(scrollTimer);
        scrollTimer = window.setTimeout(updateSticky, 100);
    }, { passive: true });
    window.addEventListener('resize', scheduleSticky);
    mobile.addEventListener('change', () => setMenu(false));
    new ResizeObserver(scheduleSticky).observe(document.querySelector('main'));
    const sectionObserver = new IntersectionObserver(scheduleSticky);
    [testimonials, finalCta, footer, ...serviceBookingCtas].forEach((section) => sectionObserver.observe(section));
    updateSticky();

    // Optional CMS data must not gate navigation, lightboxes, or tracking.
    let sbClient;
    const loadCms = async () => {
        if (!sbClient) return;
        const results = await Promise.allSettled([
            sbClient.from('feedbacks').select('image_url').order('created_at', { ascending: true }),
            sbClient.from('announcements').select('content').eq('id', 1).single(),
            sbClient.from('site_settings').select('setting_value').eq('setting_key', 'new_article_list_enabled').single()
        ]);
        const [images, announcement, settings] = results.map((result) => result.status === 'fulfilled' ? result.value.data : null);
        if (images) {
            const seen = new Set(localFeedback.map((item) => new URL(item.src, document.baseURI).href));
            const uploaded = [];
            images.slice().reverse().forEach((item) => {
                try {
                    const url = new URL(item.image_url);
                    if (url.protocol !== 'https:' || seen.has(url.href)) return;
                    seen.add(url.href);
                    uploaded.push({ src: url.href, alt: '新增真實諮詢回饋截圖' });
                } catch { /* Ignore malformed CMS image URLs without hiding local feedback. */ }
            });
            feedback = [...uploaded, ...localFeedback];
            galleryDirty = true;
            updateFeedbackCount();
            if (gallery.open) renderGallery();
        }
        // The current CMS only exposes content, not a reliable expiry. Keep public announcements hidden.
        if (announcement?.content) document.getElementById('announcement-text').textContent = announcement.content;
        if (settings?.setting_value === true) {
            document.querySelectorAll('a[href="articles.html"]').forEach((link) => { link.href = 'new_articles.html'; });
        }
    };
    const initializeCms = () => {
        if (!window.supabase) return;
        sbClient = window.supabase.createClient(
            'https://uwktzlxlduqyjyoolgrs.supabase.co',
            'sb_publishable_zd-hddZrWPl2uzLUJmouxw_U31_3PYa'
        );
        loadCms();
    };
    if (window.supabase) initializeCms();
    else document.getElementById('cms-sdk').addEventListener('load', initializeCms, { once: true });

    // Existing admin RPC/session contract is retained; the three-click entry moves to the footer.
    let clickCount = 0;
    let clickTimer;
    const adminModal = document.getElementById('admin-modal');
    const passInput = document.getElementById('admin-pass');
    const btnLogin = document.getElementById('btn-login');
    const adminStatus = document.getElementById('admin-status');
    document.getElementById('announcement-banner').addEventListener('click', () => {
        clickCount++;
        if (clickCount === 1) clickTimer = setTimeout(() => { clickCount = 0; }, 1000);
        if (clickCount === 3) {
            clearTimeout(clickTimer);
            clickCount = 0;
            passInput.value = '';
            adminStatus.textContent = '';
            openDialog(adminModal);
            passInput.focus();
        }
    });
    document.getElementById('admin-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const passcode = passInput.value.trim();
        if (!passcode || btnLogin.disabled) return;
        if (!sbClient) {
            adminStatus.textContent = '登入服務暫時無法連線，請稍後重試。';
            return;
        }
        btnLogin.disabled = true;
        btnLogin.textContent = '驗證中...';
        try {
            const { data, error } = await sbClient.rpc('verify_admin_password', { input_passcode: passcode });
            if (error) throw error;
            if (data === true) {
                sessionStorage.setItem('isAdminLoggedIn', 'true');
                window.location.href = './admindashboard/admin.html';
            } else {
                adminStatus.textContent = '密碼錯誤！請重新輸入。';
            }
        } catch {
            adminStatus.textContent = '登入服務暫時無法連線，請稍後重試。';
        } finally {
            btnLogin.disabled = false;
            btnLogin.textContent = '登入後台';
        }
    });
})();
