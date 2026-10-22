(() => {
    'use strict';

    const data = Object.freeze({
        courseName: '實戰紫微斗數初階班',
        startDate: '2026-11-09',
        registrationDeadline: '2026-11-08',
        weekday: '一',
        startTime: '19:00',
        endTime: '21:00',
        sessions: 12,
        hoursPerSession: 2,
        price: 25000,
        lineUrl: 'https://lin.ee/y2XVa6h'
    });
    const formatPrice = (amount) => `NT$${amount.toLocaleString('en-US')}`;
    const formatDate = (value) => value ? value.split('-').map(Number).join('/') : '';
    // A new cohort is shown as open only after its dates and times are confirmed.
    const open = Boolean(data.startDate && data.registrationDeadline && data.weekday
        && data.startTime && data.endTime
        && new Date(`${data.registrationDeadline}T23:59:59+08:00`) >= new Date()
        && new Date(`${data.startDate}T23:59:59+08:00`) >= new Date());
    const fields = {
        courseName: data.courseName,
        startDate: open ? `${formatDate(data.startDate)}（${data.weekday}）開課` : '本梯報名已截止',
        schedule: open ? `每週${data.weekday} ${data.startTime}–${data.endTime}` : '每週一堂｜時段待確認',
        sessions: `共 ${data.sessions} 堂`,
        sessionLength: `每堂 ${data.hoursPerSession} 小時｜共 ${data.sessions * data.hoursPerSession} 小時`,
        price: formatPrice(data.price),
        priceNote: '目前恢復原價，報名詳情可洽官方 LINE 小幫手',
        enrollmentStatus: open ? `報名截止 ${formatDate(data.registrationDeadline)}，詳情可洽官方 LINE 小幫手` : '本梯報名已截止，下一梯資訊請洽官方 LINE',
        finalInvitation: open ? `我們 ${formatDate(data.startDate)} 課堂上見` : '加入官方 LINE，詢問下一梯開課與報名資訊'
    };
    window.DabaoCourse = Object.freeze({ data, fields, open });
    document.querySelectorAll('[data-course-field]').forEach((node) => {
        node.textContent = fields[node.dataset.courseField] || '';
    });

    const schemaNode = document.getElementById('beginner-course-schema');
    if (schemaNode) {
        const schema = {
            '@context': 'https://schema.org',
            '@type': 'Course',
            name: data.courseName,
            description: '從零建立紫微斗數解盤判斷方式，不靠死背星曜答案',
            provider: { '@type': 'Person', name: '大寶老師', url: 'https://dabao.life/' },
            url: 'https://dabao.life/ziwei-beginner-course.html',
            inLanguage: 'zh-TW',
            educationalLevel: 'Beginner',
            timeRequired: `PT${data.sessions * data.hoursPerSession}H`,
            offers: {
                '@type': 'Offer',
                url: 'https://dabao.life/ziwei-beginner-course.html#pricing',
                category: 'Paid',
                price: data.price,
                priceCurrency: 'TWD'
            }
        };
        if (open) {
            schema.hasCourseInstance = {
                '@type': 'CourseInstance',
                courseMode: 'online',
                startDate: `${data.startDate}T${data.startTime}:00+08:00`,
                location: { '@type': 'VirtualLocation', name: 'Google Meet' }
            };
            schema.offers.validThrough = data.registrationDeadline;
        }
        schemaNode.textContent = JSON.stringify(schema);
    }
})();
