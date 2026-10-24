(() => {
    'use strict';

    const fallback = Object.freeze({
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
    const money = amount => `NT$${Number(amount).toLocaleString('en-US')}`;
    const date = value => value ? value.split('-').map(Number).join('/') : '';
    const text = (selector,value) => document.querySelectorAll(selector).forEach(node=>{node.textContent=value;});
    const cms=window.DabaoCMS;
    let previousCourses='';
    const stageTemplates=new Map(['beginner','intermediate','advanced','professional'].map((id,index)=>[id,document.querySelectorAll('.stage-details > details')[index]?.cloneNode(true)]));
    const originalCtaLabels=new Map([...document.querySelectorAll('.js-line-cta,[data-enrollment-signup]')].map(link=>[link,link.textContent]));
    const courseId=typeof document.body !== 'undefined' ? document.body.dataset.cmsCourse : null;
    const enrollmentUrl=(cohort,course)=>course?.introUrl||`course-enrollment.html?cohort=${encodeURIComponent(cohort.id)}`;
    function render(snapshot) {
        const managed=Boolean(cms?.enabled),failed=managed&&!snapshot;
        let cohort=null,course=null;
        if(snapshot){
            const requested=new URLSearchParams(location.search).get('cohort');
            const candidates=snapshot.cohorts.filter(c=>(!courseId||c.courseId===courseId)&&(!requested||c.id===requested));
            cohort=candidates.find(c=>c.isFeatured&&c.open)||candidates.find(c=>c.open)||candidates.find(c=>c.isFeatured)||candidates[0];
            course=cohort&&snapshot.courses.find(c=>c.id===cohort.courseId);
        }
        const data=cohort?{courseName:course.name,startDate:cohort.startDate,registrationDeadline:cohort.registrationDeadline,weekday:'日一二三四五六'[cohort.weekday]||'',startTime:cohort.startTime,endTime:cohort.endTime,sessions:cohort.sessions,hoursPerSession:cohort.minutes/60,price:cohort.price,lineUrl:snapshot.settings.lineUrl}:{...fallback,lineUrl:snapshot?.settings.lineUrl||fallback.lineUrl};
        const open=managed?Boolean(cohort?.open):Boolean(data.startDate&&data.registrationDeadline&&new Date(`${data.registrationDeadline}T23:59:59+08:00`)>=new Date()&&new Date(`${data.startDate}T23:59:59+08:00`)>=new Date());
        const empty=(managed&&!cohort)||(!managed&&Boolean(document.getElementById('enrollment-schema')));
        const status=failed?'招生資訊暫時無法載入，請洽官方 LINE':empty?'目前沒有此課程的公開招生期別，請洽官方 LINE':!open?'本梯報名已截止或暫停，下一梯資訊請洽官方 LINE':data.registrationDeadline?`報名截止 ${date(data.registrationDeadline)}，詳情可洽官方 LINE 小幫手`:'招生中，報名詳情請洽官方 LINE 小幫手';
        const fields={courseName:empty?(courseId==='beginner'?fallback.courseName:'課程招生資訊'):data.courseName,startDate:empty?'日期待確認':data.startDate?`${date(data.startDate)}（${data.weekday}）開課`:'開課日期待確認',schedule:empty?'時段待確認':data.startTime&&data.endTime?`每週${data.weekday} ${data.startTime}–${data.endTime}`:'每週一堂｜時段待確認',sessions:empty?'堂數待確認':`共 ${data.sessions} 堂`,sessionLength:empty?'時數待確認':`每堂 ${data.hoursPerSession} 小時｜共 ${data.sessions*data.hoursPerSession} 小時`,price:empty?'請洽小幫手':money(data.price),priceNote:cohort?.earlyBird?`原價 ${money(cohort.regularPrice)}，公開早鳥優惠${cohort.earlyBirdEnd?'至 '+cohort.earlyBirdEnd.replace('T',' '):'期間詳洽小幫手'}`:cohort?.notes||'報名詳情可洽官方 LINE 小幫手',enrollmentStatus:status,finalInvitation:open&&data.startDate?`我們 ${date(data.startDate)} 課堂上見`:'加入官方 LINE，詢問下一梯開課與報名資訊',platform:empty?'授課資訊待確認':cohort?.platform||'Google Meet',description:course?.summary||''};
        window.DabaoCourse=Object.freeze({data,fields,open,cohort,course});
        document.querySelectorAll('[data-course-field]').forEach(node=>{node.textContent=fields[node.dataset.courseField]||'';});
        document.querySelectorAll('[data-cms-line]').forEach(link=>{link.href=data.lineUrl;});
        document.querySelectorAll('.js-line-cta,[data-enrollment-signup]').forEach(link=>{
            link.href=open&&cohort?cohort.signupUrl:data.lineUrl;
            const isLine=/^https:\/\/(lin\.ee|line\.me)\//.test(link.href);
            link.textContent=open?(isLine?originalCtaLabels.get(link):'前往課程報名'):'加入 LINE 詢問課程';
        });
        if(cohort&&course){
            text('[data-enrollment-heading]',course.name);
            text('[data-enrollment-description]',course.summary);
            text('[data-enrollment-hero-label]',`目前招生｜${course.name} ↓`);
            document.querySelectorAll('[data-course-cta="beginner_lp"]').forEach(link=>{link.href=enrollmentUrl(cohort,course);if(new URL(link.href).origin===location.origin){link.removeAttribute('target');link.removeAttribute('rel');}else{link.target='_blank';link.rel='noopener noreferrer';}link.textContent=open?`查看本期${course.shortName}完整資訊`:`查看${course.shortName}課程資訊`;});
        }
        if(empty&&managed){text('[data-enrollment-heading]',fields.courseName);text('[data-enrollment-description]',status);text('[data-enrollment-hero-label]','招生資訊｜請洽官方 LINE');document.querySelectorAll('[data-course-cta="beginner_lp"]').forEach(link=>{link.href=data.lineUrl;link.textContent='加入官方 LINE 詢問課程';link.target='_blank';link.rel='noopener noreferrer';});}
        const schemaNode=document.getElementById('beginner-course-schema')||document.getElementById('enrollment-schema');
        if(schemaNode){
            const schema={'@context':'https://schema.org','@type':'Course',name:fields.courseName,description:course?.summary||'從零建立紫微斗數解盤判斷方式，不靠死背星曜答案',provider:{'@type':'Person',name:'大寶老師',url:'https://dabao.life/'},url:'https://dabao.life/'+(document.getElementById('beginner-course-schema')?'ziwei-beginner-course.html':'course-enrollment.html'),inLanguage:'zh-TW',timeRequired:`PT${data.sessions*data.hoursPerSession}H`};
            if(empty)delete schema.timeRequired;
            if(!empty){schema.offers={'@type':'Offer',category:'Paid',price:data.price,priceCurrency:'TWD',availability:open?'https://schema.org/InStock':'https://schema.org/OutOfStock',url:schema.url};if(open&&data.startDate){schema.hasCourseInstance={'@type':'CourseInstance',courseMode:'online',startDate:`${data.startDate}T${data.startTime||'00:00'}:00+08:00`,location:{'@type':'VirtualLocation',name:cohort?.platform||'Google Meet'}};if(data.registrationDeadline)schema.offers.validThrough=data.registrationDeadline;}}
            if(document.getElementById('enrollment-schema')&&cohort){schema.url+='?cohort='+encodeURIComponent(cohort.id);if(schema.offers)schema.offers.url=schema.url;document.querySelector('link[rel="canonical"]').href=schema.url;document.title=fields.courseName+'｜大寶課程招生資訊';document.querySelector('meta[name="description"]').content=course.summary;}
            schemaNode.textContent=JSON.stringify(schema);
        }
        const other=document.getElementById('other-enrollments');
        if(other&&snapshot){
            other.replaceChildren();
            snapshot.cohorts.filter(c=>c.open&&c.id!==cohort?.id).forEach(c=>{
                const info=snapshot.courses.find(x=>x.id===c.courseId),row=document.createElement('div'),copy=document.createElement('div'),heading=document.createElement('h3'),details=document.createElement('p'),link=document.createElement('a');
                row.className='cms-enrollment-row';heading.textContent=c.name;details.textContent=`${money(c.price)}｜${c.startDate?date(c.startDate)+' 開課':'日期待確認'}`;link.href=enrollmentUrl(c,info);link.textContent='查看招生資訊 →';link.dataset.courseCta='beginner_lp';link.dataset.location='other-enrollment';copy.append(heading,details);row.append(copy,link);other.append(row);
            });
        }
        const home=document.getElementById('home-cms-enrollment');
        if(home){home.hidden=!managed;home.replaceChildren();const title=document.createElement('span'),price=document.createElement('strong');title.textContent=empty?status:data.courseName;price.textContent=empty?'':fields.price;home.append(title,price);if(!open&&!empty){const note=document.createElement('small');note.textContent=status;home.append(note);}}
        const overview=document.querySelector('.path-overview');
        const stages=document.querySelector('.stage-details');
        if(snapshot&&overview&&stages&&JSON.stringify(snapshot.courses)!==previousCourses){
            previousCourses=JSON.stringify(snapshot.courses);
            const openStages=new Set([...stages.children].filter(node=>node.open).map(node=>node.dataset.courseId));
            overview.replaceChildren();stages.replaceChildren();
            snapshot.courses.forEach((c,index)=>{
                const li=document.createElement('li'),number=document.createElement('span'),name=document.createElement('strong'),position=document.createElement('small');number.textContent=String(index+1).padStart(2,'0');name.textContent=stageTemplates.has(c.id)?(c.level||c.shortName).replace(/班$/,''):c.level||c.shortName;position.textContent=c.position;li.append(number,name,position);overview.append(li);
                const detail=stageTemplates.get(c.id)?.cloneNode(true)||document.createElement('details');
                detail.dataset.courseId=c.id;detail.open=openStages.has(c.id);
                if(!detail.querySelector('summary')){const summary=document.createElement('summary');summary.append(document.createElement('span'),document.createElement('strong'));const content=document.createElement('div');content.className='stage-content';detail.append(summary,content);}
                detail.querySelector('summary span').textContent=number.textContent;detail.querySelector('summary strong').textContent=`${name.textContent}｜${c.position}`;
                const content=detail.querySelector('.stage-content'),outcome=content.children[2]?.cloneNode(true);content.replaceChildren();
                for(const [label,value] of [['適合誰',c.audience],['學什麼',c.summary]]){const p=document.createElement('p'),b=document.createElement('b');b.textContent=label;p.append(b,document.createTextNode(value));content.append(p);}if(outcome)content.append(outcome);stages.append(detail);
            });
            const count=snapshot.courses.length;
            const stagesLabel=count===4?'四階段學習路徑':`${count} 階段學習路徑`;
            text('#learning-path .eyebrow',stagesLabel);overview.setAttribute('aria-label',stagesLabel);
            text('[data-course-cta="learning_path"]',`看看${stagesLabel}`);
            overview.style.gridTemplateColumns=`repeat(${Math.min(4,Math.max(1,snapshot.courses.length))}, minmax(0,1fr))`;
        }
    }
    render(null);
    if(cms?.enabled)cms.subscribe(render);
})();
