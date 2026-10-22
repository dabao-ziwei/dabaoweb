import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

export function seed(store) {
    if(store.db.prepare('SELECT count(*) count FROM courses').get().count) return;
    const sandbox={window:{},document:{querySelectorAll:()=>[],querySelector:()=>null,getElementById:()=>null},Date,Intl};
    vm.runInNewContext(fs.readFileSync(path.join(store.config.root,'course-data.js'),'utf8'),sandbox);
    const initial=sandbox.window.DabaoCourse.data;
    const classes=[
        ['beginner','實戰紫微斗數初階班','初階班','看得懂','命盤結構、十二宮位、星曜與宮位的邏輯分析、單星與雙星組合','零基礎，或曾學過卻總是在看盤時卡關的妳','ziwei-beginner-course.html'],
        ['intermediate','實戰紫微斗數進階班','進階班','看得出時間與事件','事件與時間判斷、夫官線、財福線與定盤入門','完成初階課程，想判斷感情、事業與財富何時發生變化的妳',''],
        ['advanced','實戰紫微斗數高階班','高階班','從預測走向調整','星曜與疾病的關聯、健康判斷、居家與辦公空間的基礎風水','完成進階課程，想理解健康資訊與基礎風水調整的妳',''],
        ['professional','實戰紫微斗數職業班','職業班','能替別人解盤','快速解盤、案例演練、表達與實務諮詢方法','完成高階課程，想把興趣發展成專業或第二份工作的妳','']
    ];
    for(const [index,[id,name,shortName,position,summary,audience,introUrl]] of classes.entries()) {
        const created=store.save('courses',null,{name,shortName,position,summary,audience,introUrl,sessions:index===0?initial.sessions:null,minutes:index===0?initial.hoursPerSession*60:null,level:shortName,sort:index+1,isVisible:true},null,'bootstrap');
        const row=store.row('courses',created.id);
        const data={...JSON.parse(row.draft_json),id};
        store.db.prepare('UPDATE courses SET id=?,draft_json=? WHERE id=?').run(id,JSON.stringify(data),row.id);
    }
    store.save('cohorts',null,{courseId:'beginner',name:'2026 年 11 月初階班',status:'open',regularPrice:initial.price,earlyBirdEnabled:false,earlyBirdPrice:null,earlyBirdStart:null,earlyBirdEnd:null,startDate:initial.startDate,endDate:null,registrationDeadline:initial.registrationDeadline,weekday:1,startTime:initial.startTime,endTime:initial.endTime,sessions:initial.sessions,minutes:initial.hoursPerSession*60,platform:'Google Meet',capacity:null,enrolled:null,signupUrl:initial.lineUrl,notes:'報名詳情可洽官方 LINE 小幫手',isFeatured:true,isVisible:true,sort:1},null,'bootstrap');
    const settings={id:'site',featuredDesktop:6,featuredMobile:3,lineUrl:initial.lineUrl};
    store.db.prepare('INSERT INTO settings(id,draft_json,updated_at,updated_by) VALUES(?,?,?,?)').run('site',JSON.stringify(settings),new Date().toISOString(),'bootstrap');
    store.publish('bootstrap');
}
