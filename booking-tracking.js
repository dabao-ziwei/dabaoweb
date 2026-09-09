(() => {
    const requestedService = new URLSearchParams(window.location.search).get('service');
    const service = ['complete', 'annual', 'divination'].includes(requestedService) ? requestedService : 'unspecified';
    // Keep the external system URL unchanged; it does not declare query-string support.
    document.getElementById('booking-system-link').addEventListener('click', () => {
        if (typeof window.gtag === 'function') {
            window.gtag('event', 'booking_system_click', {
                service,
                cta_location: 'booking-page',
                link_url: 'https://ziweiapp.dabao.life/booking'
            });
        }
    });
})();
