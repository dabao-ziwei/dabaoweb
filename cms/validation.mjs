export class HttpError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}
export const fail = (message, status = 422) => { throw new HttpError(status, message); };
export const kinds = ['courses', 'cohorts', 'feedback', 'settings'];
export function text(value, label, max = 200, required = false) {
    if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(`${label}格式不正確`);
    return value.trim();
}
export function number(value, label, min = 0, max = 1000000, nullable = false) {
    if (nullable && (value === null || value === '')) return null;
    if (!Number.isInteger(value) || value < min || value > max) fail(`${label}必須為 ${min}～${max} 的整數`);
    return value;
}
const bool = (value, label) => { if (typeof value !== 'boolean') fail(`${label}必須為是或否`); return value; };
export function safeUrl(value, label, { local = true, empty = false } = {}) {
    value = text(value, label, 1000);
    if (!value && empty) return '';
    if (local && /^(?:\/?[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\.html)(?:[?#][^\s<>]*)?$/.test(value)) return value;
    let url;
    try { url = new URL(value); } catch { fail(`${label}必須為有效的 HTTPS 網址或站內 HTML 頁面`); }
    if (url.protocol !== 'https:' || url.username || url.password) fail(`${label}只允許 HTTPS 網址`);
    return url.href;
}
export function date(value, label, datetime = false) {
    if (value === null || value === '') return null;
    const pattern = datetime ? /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/ : /^\d{4}-\d{2}-\d{2}$/;
    if (typeof value !== 'string' || !pattern.test(value)) fail(`${label}日期格式不正確`);
    const iso = datetime ? `${value}:00+08:00` : `${value}T00:00:00+08:00`;
    const parsed = new Date(iso);
    if (!Number.isFinite(parsed.getTime()) || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year:'numeric',month:'2-digit',day:'2-digit' }).format(parsed) !== value.slice(0,10)) fail(`${label}不是有效日期`);
    return value;
}
export function validate(kind, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('資料格式不正確');
    if (kind === 'courses') return {
        name: text(input.name, '課程名稱', 100, true), shortName: text(input.shortName || input.name, '課程簡稱', 60, true),
        summary: text(input.summary, '課程簡介', 1500), position: text(input.position, '課程定位', 300), audience: text(input.audience, '適合對象', 1500),
        sessions: number(input.sessions, '課程堂數', 1, 500, true), minutes: number(input.minutes, '每堂分鐘', 15, 1440, true),
        level: text(input.level, '課程階序', 80), sort: number(input.sort, '排序', 0, 10000),
        isVisible: bool(input.isVisible, '公開顯示'), introUrl: safeUrl(input.introUrl, '相關介紹頁', { empty:true })
    };
    if (kind === 'cohorts') {
        const item = {
            courseId: text(input.courseId, '所屬課程', 100, true), name: text(input.name, '招生期別', 120, true),
            status: text(input.status, '招生狀態', 30, true), regularPrice: number(input.regularPrice, '正式費用'),
            earlyBirdEnabled: bool(input.earlyBirdEnabled, '早鳥優惠'), earlyBirdPrice: number(input.earlyBirdPrice, '早鳥費用', 0, 1000000, true),
            earlyBirdStart: date(input.earlyBirdStart, '早鳥開始', true), earlyBirdEnd: date(input.earlyBirdEnd, '早鳥截止', true),
            startDate: date(input.startDate, '開課日期'), endDate: date(input.endDate, '結束日期'), registrationDeadline: date(input.registrationDeadline, '報名截止'),
            weekday: number(input.weekday, '上課星期', 0, 6, true), startTime: text(input.startTime || '', '開始時間', 5), endTime: text(input.endTime || '', '結束時間', 5),
            sessions: number(input.sessions, '堂數', 1, 500), minutes: number(input.minutes, '每堂分鐘', 15, 1440), platform: text(input.platform, '授課平台', 100, true),
            capacity: number(input.capacity, '招生上限', 1, 100000, true), enrolled: number(input.enrolled, '報名人數', 0, 100000, true),
            signupUrl: safeUrl(input.signupUrl, '報名入口', { local:false }), notes: text(input.notes, '補充說明', 3000),
            isFeatured: bool(input.isFeatured, '主推'), isVisible: bool(input.isVisible, '公開顯示'), sort: number(input.sort, '排序', 0, 10000)
        };
        if (!['not_open','open','almost_full','full','closed','paused'].includes(item.status)) fail('無效的招生狀態');
        for (const [a,b,label] of [['startDate','endDate','課程'],['earlyBirdStart','earlyBirdEnd','早鳥']]) if (item[a] && item[b] && item[a] > item[b]) fail(`${label}開始日期不得晚於結束日期`);
        if (item.registrationDeadline && item.startDate && item.registrationDeadline > item.startDate) fail('報名截止不得晚於開課日期');
        for (const time of [item.startTime,item.endTime]) if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) fail('上課時間不正確');
        if (Boolean(item.startTime) !== Boolean(item.endTime) || (item.startTime && item.startTime >= item.endTime)) fail('上課開始時間須早於結束時間');
        if (item.earlyBirdEnabled && (item.earlyBirdPrice === null || item.earlyBirdPrice > item.regularPrice)) fail('早鳥費用不得空白或高於原價');
        if (item.capacity !== null && item.enrolled !== null && item.enrolled > item.capacity) fail('報名人數不得大於招生上限');
        return item;
    }
    if (kind === 'feedback') return {
        mediaId: text(input.mediaId, '圖片', 100, true), description: text(input.description, '圖片說明', 500),
        sort: number(input.sort, '排序', 0, 100000), isVisible: bool(input.isVisible, '公開顯示'), isFeatured: bool(input.isFeatured, '首頁精選')
    };
    if (kind === 'settings') return { featuredDesktop: number(input.featuredDesktop, '桌面精選數', 1, 24), featuredMobile: number(input.featuredMobile, '手機精選數', 1, 24), lineUrl: safeUrl(input.lineUrl, '官方 LINE', { local:false }) };
    fail('無效的資料類型', 404);
}
export function effectiveCohort(cohort, now = new Date()) {
    const end = value => value ? new Date(`${value}T23:59:59.999+08:00`).getTime() : Infinity;
    const time = now.getTime();
    const status = (time > end(cohort.registrationDeadline) || time > end(cohort.startDate)) ? 'closed' : cohort.status;
    const open = ['open','almost_full'].includes(status);
    const earlyBird = open && cohort.earlyBirdEnabled && cohort.earlyBirdPrice !== null
        && (!cohort.earlyBirdStart || time >= new Date(`${cohort.earlyBirdStart}:00+08:00`).getTime())
        && (!cohort.earlyBirdEnd || time <= new Date(`${cohort.earlyBirdEnd}:59.999+08:00`).getTime());
    return { ...cohort, effectiveStatus: status, open, earlyBird, price: earlyBird ? cohort.earlyBirdPrice : cohort.regularPrice, totalHours: cohort.sessions * cohort.minutes / 60 };
}
