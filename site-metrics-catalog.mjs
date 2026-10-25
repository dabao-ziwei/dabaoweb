export const pages = {
    home: ['index.html', '首頁'], course: ['course.html', '紫微課程'],
    beginner: ['ziwei-beginner-course.html', '初階班招生頁'], enrollment: ['course-enrollment.html', '課程招生'],
    booking: ['booking.html', '預約諮詢'], articles: ['articles.html', '教學文章'],
    new_articles: ['new_articles.html', '文章列表'], article: ['article_view.html', '站內文章內容'], chart: ['chart.html', '線上排盤'], faq: ['faq.html', '常見問題']
};
export const targets = {
    home:'前往首頁', services:'查看諮詢服務', guide:'查看適合的諮詢',
    complete:'查看完整論命', annual:'查看流年分析', divination:'查看紫微占卜',
    course:'查看紫微課程', articles:'查看教學文章', new_articles:'查看文章列表', article:'閱讀站內文章', chart:'查看線上排盤', faq:'查看常見問題',
    booking:'進入預約介紹頁', booking_complete:'預約完整論命入口', booking_annual:'預約流年分析入口', booking_divination:'預約紫微占卜入口',
    booking_system:'開啟線上預約系統', chart_system:'啟動排盤系統', line:'聯繫官方 LINE',
    beginner:'查看初階班招生頁', enrollment:'查看目前招生', learning_path:'查看學習路徑', course_signup:'前往課程報名入口',
    threads:'前往 Threads', instagram:'前往 Instagram', article_external:'閱讀外部教學文章',
    testimonials:'查看全部諮詢回饋', testimonial_image:'放大諮詢回饋圖片', faq_expand:'展開常見問題'
};
export const locations = {
    navigation:'導覽列',hero:'Hero',guide:'需求辨識',services:'諮詢服務',testimonials:'回饋區',
    faq:'常見問題',course:'課程區',enrollment:'招生區',pricing:'費用區',final:'最後 CTA',
    sticky:'浮動 CTA',footer:'頁尾',content:'頁面內容',other_services:'其他服務'
};
export function pageForPath(path) {
    if(path==='/')return 'home';
    return Object.keys(pages).find(key=>path==='/'+pages[key][0]);
}
export function validEvent(event) {
    if(!event||typeof event!=='object'||Array.isArray(event)||Object.keys(event).sort().join(',')!=='action,location,page,target')return false;
    if(!Object.values(event).every(value=>typeof value==='string'))return false;
    return Object.hasOwn(pages,event.page)&&(
        event.action==='view'&&event.target==='none'&&event.location==='content'||
        event.action==='click'&&Object.hasOwn(targets,event.target)&&Object.hasOwn(locations,event.location)
    );
}
export function reportWithLabels(report) {
    const rows=report.rows.map(row=>({...row,hits:Number(row.hits),pageLabel:pages[row.page]?.[1]||row.page,
        targetLabel:targets[row.target]||row.target,locationLabel:locations[row.location]||row.location}));
    const total=predicate=>rows.filter(predicate).reduce((sum,row)=>sum+row.hits,0);
    return {...report,rows,totals:{views:total(row=>row.action==='view'),clicks:total(row=>row.action==='click'),
        line:total(row=>row.target==='line'),booking:total(row=>row.target==='booking_system')},
        pages:Object.entries(pages).map(([id,[,label]])=>({id,label,hits:total(row=>row.page===id&&row.action==='view')})),
        targets:Object.entries(targets).map(([id,label])=>({id,label,hits:total(row=>row.target===id)}))};
}
