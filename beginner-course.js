(() => {
    'use strict';

    const data = () => window.DabaoCourse.data;
    const track = (name, label) => {
        if (!window.DabaoCmsPreview && typeof window.gtag === 'function') {
            window.gtag('event', name, {
                event_category: 'ziwei_beginner_course',
                event_label: label || '',
                course_name: data().courseName
            });
        }
    };
    const trackMeta = (name) => {
        if (!window.DabaoCmsPreview && typeof window.fbq === 'function') window.fbq('track', name, { content_name: data().courseName });
    };

    const ready = () => {
        trackMeta('ViewContent');
        document.querySelectorAll('.js-line-cta').forEach((link) => {
            if (!window.DabaoCMS?.enabled) link.href = data().lineUrl;
            if (!window.DabaoCMS?.enabled && !window.DabaoCourse.open) link.textContent = '加入 LINE 詢問下一梯';
            link.addEventListener('click', () => {
                track('generate_lead', link.dataset.label);
                trackMeta('Lead');
            });
        });
        const pricing = document.getElementById('pricing');
        if ('IntersectionObserver' in window && pricing) {
            const observer = new IntersectionObserver((entries) => {
                if (!entries.some((entry) => entry.isIntersecting)) return;
                track('view_pricing', 'pricing_section');
                observer.disconnect();
            }, { threshold: 0.35 });
            observer.observe(pricing);
        }
    };
    const initialize = () => (window.DabaoCMS?.ready || Promise.resolve()).then(ready);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
    else initialize();
})();
