(() => {
    'use strict';
    const $=selector=>document.querySelector(selector);
    if(!window.DabaoCmsConfig?.enabled){$('#login-error').textContent='管理服務尚未啟用，請使用已啟動的本機 CMS 或已核准的管理服務';$('#login-form button').disabled=true;return;}
    const cloud=window.DabaoCmsConfig.provider==='supabase';
    const transport=cloud?window.DabaoCmsTransport:null;
    $('#remember-option').hidden=!cloud;
    if(!cloud&&new URL(window.DabaoCmsConfig.apiBase).origin!==location.origin){location.replace(new URL('/admin/',window.DabaoCmsConfig.apiBase));return;}
    const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const money=value=>`NT$${Number(value).toLocaleString('en-US')}`;
    const time=value=>value?new Intl.DateTimeFormat('zh-TW',{timeZone:'Asia/Taipei',dateStyle:'short',timeStyle:'short'}).format(new Date(value)):'';
    const localEnvironment=['localhost','127.0.0.1','[::1]'].includes(location.hostname);
    const labels={dashboard:'儀表板',courses:'課程管理',cohorts:'招生期別',feedback:'諮詢回饋',history:'發布紀錄',settings:'系統設定'};
    const statuses={not_open:'尚未開放',open:'招生中',almost_full:'即將額滿',full:'已額滿',closed:'招生結束',paused:'暫停招生'};
    let csrf='',state=null,page='dashboard',editing=null,filter='',feedbackPage=0;
    let metricsDays=0,metricsGeneration=0;
    const notice=(message,error=false)=>{ $('#notice').textContent=message;$('#notice').classList.toggle('error',error); };
    async function api(url,options={}) {
        if(cloud){try{return await transport.request(url,options);}catch(error){if(error.status===401||url==='password'){showLogin();$('#login-error').textContent=error.message;}throw error;}}
        const response=await fetch('/api/admin/'+url,{credentials:'same-origin',...options,headers:{...(options.body instanceof FormData?{}:{'Content-Type':'application/json'}),'X-CSRF-Token':csrf,...options.headers}});
        const data=await response.json();
        if(!response.ok) {if(response.status===401){const fresh=await fetch('/api/admin/session',{credentials:'same-origin'}).then(r=>r.json());csrf=fresh.csrf;if(!fresh.authenticated)showLogin();}throw new Error(data.error||'操作失敗');}
        return data;
    }
    const request=(url,method,data)=>api(url,{method,body:JSON.stringify(data)});
    function showLogin(){ metricsGeneration++;document.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close());$('#workspace').hidden=true;$('#login-screen').hidden=false;state=null; }
    async function bootstrap(initial){const session=initial||await api('session');csrf=session.csrf;if(session.authenticated){const next=session.state||await api('state');state=next;$('#account').textContent=`${session.username} · ${localEnvironment?'本機 CMS':'管理環境'} · Asia/Taipei`;$('#login-screen').hidden=true;$('#workspace').hidden=false;render();}else showLogin();}
    async function refresh(){state=await api('state');render();}
    async function confirm(message){$('#confirm-message').textContent=message;const dialog=$('#confirm-dialog');dialog.returnValue='';dialog.showModal();return new Promise(resolve=>dialog.addEventListener('close',()=>resolve(dialog.returnValue==='confirm'),{once:true}));}
    const badge=item=>`<span class="status ${item.changed?'pending':item.published?'good':''}">${item.changed?'有未發布草稿':item.published?'已發布':'草稿'}</span>`;
    const actions=(kind,item)=>`<div class="row-actions"><button type="button" data-edit="${kind}" data-id="${item.id}">編輯</button><button type="button" data-unpublish="${kind}" data-id="${item.id}" ${!item.published?'disabled':''}>取消發布</button><button type="button" data-delete="${kind}" data-id="${item.id}" class="danger">刪除</button></div>`;
    const mediaSource=(id,variant)=>`${cloud?' crossorigin="anonymous"':''} src="${escape(cloud?transport.image(id,variant):`/api/admin/media/${id}/${variant}`)}"`;
    function render(){
        if(!state)return;
        $('#page-title').textContent=labels[page];$('#publish').textContent=`發布${state.pending?`（${state.pending}）`:''}`;$('#publish').disabled=!state.pending;
        document.querySelectorAll('[data-page]').forEach(button=>button.setAttribute('aria-current',button.dataset.page===page?'page':'false'));
        if(page==='dashboard'){
            renderDashboard();
        } else if(page==='courses') {
            $('#content').innerHTML=`<div class="section-actions"><h2>課程種類</h2><button type="button" class="primary" data-new="courses">新增課程</button></div><div class="table-wrap"><table><thead><tr><th>課程</th><th>堂數／時間</th><th>排序／公開</th><th>發布狀態</th><th>操作</th></tr></thead><tbody>${state.courses.map(c=>`<tr><td><strong>${escape(c.name)}</strong><br><span class="muted">${escape(c.position)}</span></td><td>${c.sessions??'—'} 堂 · ${c.minutes??'—'} 分鐘${c.totalHours!==null?`<br>共 ${c.totalHours} 小時`:''}</td><td>${c.sort} · ${c.isVisible?'公開':'停用'}</td><td>${badge(c)}</td><td>${actions('courses',c)}</td></tr>`).join('')}</tbody></table></div>`;
        } else if(page==='cohorts') {
            $('#content').innerHTML=`<div class="section-actions"><h2>招生期別</h2><button type="button" class="primary" data-new="cohorts">新增期別</button></div><div class="table-wrap"><table><thead><tr><th>期別／課程</th><th>狀態</th><th>價格</th><th>日期</th><th>操作</th></tr></thead><tbody>${state.cohorts.map(c=>`<tr><td><strong>${escape(c.name)}</strong>${c.isFeatured?' <span class="status good">主推</span>':''}<br>${escape(state.courses.find(x=>x.id===c.courseId)?.name||'')}<br>${badge(c)}</td><td>${statuses[c.status]}</td><td>${money(c.regularPrice)}${c.earlyBirdEnabled?`<br>早鳥 ${money(c.earlyBirdPrice)}`:''}</td><td>${escape(c.startDate||'日期待確認')}<br><small>${escape(c.registrationDeadline||'未設截止')} 截止</small></td><td>${actions('cohorts',c)}</td></tr>`).join('')}</tbody></table></div>`;
        } else if(page==='feedback') renderFeedback();
        else if(page==='history') renderHistory();
        else if(page==='settings')renderSettings();
    }
    async function renderDashboard(){
        const generation=++metricsGeneration;
        const cards=[['views','頁面瀏覽次數'],['clicks','功能點擊次數'],['line','LINE 點擊次數'],['booking','開啟預約系統次數']];
        $('#content').innerHTML=`<div class="section-actions"><h2>網站使用統計</h2><label class="metrics-range">統計區間<select id="metrics-days">${[[0,'累計'],[1,'今日'],[7,'近 7 天'],[30,'近 30 天']].map(([days,label])=>`<option value="${days}" ${days===metricsDays?'selected':''}>${label}</option>`).join('')}</select></label></div><p class="muted" id="metrics-period">Asia/Taipei</p><div class="metrics traffic-metrics">${cards.map(([key,label])=>`<div class="metric"><p>${label}</p><strong data-total="${key}">—</strong></div>`).join('')}</div><div id="metrics-result" role="status" aria-busy="true"><p class="muted">正在載入統計…</p></div><p class="muted metrics-note">從新版啟用後開始累計，不包含 GA4 歷史資料<br>數字為瀏覽／點擊次數，不是人數；LINE 點擊不代表已加好友，開啟預約系統不代表已完成預約</p>`;
        try{
            const data=cloud?await api('metrics?days='+metricsDays):{enabled:false};
            if(generation!==metricsGeneration||page!=='dashboard'||!state)return;
            const result=$('#metrics-result');result.setAttribute('aria-busy','false');
            if(!data.enabled){result.innerHTML='<p class="muted">網站統計尚未啟用，啟用後才會開始累計</p>';return;}
            const number=value=>Number(value).toLocaleString('zh-TW');
            cards.forEach(([key])=>{document.querySelector(`[data-total="${key}"]`).textContent=number(data.totals[key]);});
            $('#metrics-period').textContent=`${data.from} ～ ${data.to} · Asia/Taipei · ${data.startedAt?'開始累計 '+time(data.startedAt):'尚無累計資料'} · 更新 ${time(data.updatedAt)}`;
            const table=rows=>`<div class="table-wrap"><table><thead><tr><th>項目</th><th class="numeric">次數</th></tr></thead><tbody>${rows.map(row=>`<tr><td>${escape(row.label)}</td><td class="numeric">${number(row.hits)}</td></tr>`).join('')}</tbody></table></div>`;
            const countTable=(title,rows,foldZero=false)=>{
                const visible=foldZero?rows.filter(row=>row.hits>0):rows,zero=foldZero?rows.filter(row=>row.hits===0):[];
                return `<section class="metrics-section"><h3>${title}</h3>${visible.length?table(visible):'<p class="muted">所選區間尚無點擊</p>'}${zero.length?`<details class="metrics-zero"><summary>尚無點擊的功能（${zero.length}）</summary>${table(zero)}</details>`:''}</section>`;
            };
            const sorted=rows=>[...rows].sort((a,b)=>b.hits-a.hits);
            const sources=sorted(data.rows.filter(row=>row.action==='click'&&['line','booking_system','beginner','enrollment','course','course_signup'].includes(row.target)));
            result.innerHTML=`${!data.startedAt?'<p class="muted">尚無累計資料，網站啟用後有瀏覽或點擊才會出現數字</p>':''}<div class="metrics-tables">${countTable('各頁面瀏覽',sorted(data.pages))}${countTable('功能與聯繫點擊',sorted(data.targets),true)}</div><section class="metrics-section"><h3>聯繫與課程入口來源</h3>${sources.length?`<div class="table-wrap"><table><thead><tr><th>來源頁面</th><th>位置</th><th>點擊目的</th><th class="numeric">次數</th></tr></thead><tbody>${sources.map(row=>`<tr><td>${escape(row.pageLabel)}</td><td>${escape(row.locationLabel)}</td><td>${escape(row.targetLabel)}</td><td class="numeric">${number(row.hits)}</td></tr>`).join('')}</tbody></table></div>`:'<p class="muted">所選區間尚無相關點擊</p>'}</section>`;
        }catch(error){
            if(generation!==metricsGeneration||page!=='dashboard'||!state)return;
            $('#metrics-result').setAttribute('aria-busy','false');
            $('#metrics-result').innerHTML='<p class="error">統計目前無法載入，請按「重新整理」再試；其他管理功能仍可使用</p>';
        }
    }
    function renderFeedback(){
        const items=state.feedback.filter(f=>!filter||f.description.includes(filter));
        const start=feedbackPage*24,visible=items.slice(start,start+24);
        $('#content').innerHTML=`<div class="section-actions"><h2>諮詢回饋 <small class="muted">${state.feedback.length}</small></h2><button type="button" id="upload-picker" class="primary">批次上傳圖片</button><input id="feedback-upload" type="file" accept="image/jpeg,image/png,image/webp" multiple hidden></div><div class="filters"><input id="feedback-search" type="search" aria-label="搜尋圖片說明" value="${escape(filter)}" placeholder="搜尋圖片說明"></div><div class="feedback-grid">${visible.map(f=>`<article class="feedback-item">${cloud?`<button class="image-trigger" type="button" data-open-media="${f.mediaId}" aria-label="查看完整圖片">`:`<a href="/api/admin/media/${f.mediaId}/full" target="_blank" rel="noopener noreferrer">`}<img class="feedback-image" data-media-id="${f.mediaId}" data-variant="thumb"${mediaSource(f.mediaId,'thumb')} loading="lazy" alt="${escape(f.description||'待編輯圖片說明')}">${cloud?'</button>':'</a>'}<p>${escape(f.description||'尚未填寫說明')}</p><div class="feedback-flags">${badge(f)}${f.isFeatured?'<span class="status">首頁精選</span>':''}</div><small>排序 ${f.sort} · 上傳 ${time(f.uploadedAt)}</small>${actions('feedback',f)}<div class="row-actions"><button type="button" data-move="-1" data-id="${f.id}" aria-label="向上移動圖片" title="向上移動圖片">↑</button><button type="button" data-move="1" data-id="${f.id}" aria-label="向下移動圖片" title="向下移動圖片">↓</button></div></article>`).join('')}</div>${!items.length?'<p class="empty">目前沒有回饋圖片</p>':''}<div class="pager"><button type="button" data-feedback-page="${feedbackPage-1}" ${feedbackPage===0?'disabled':''}>上一頁</button><span>${feedbackPage+1} / ${Math.max(1,Math.ceil(items.length/24))}</span><button type="button" data-feedback-page="${feedbackPage+1}" ${start+24>=items.length?'disabled':''}>下一頁</button></div>`;
    }
    async function renderHistory(){
        $('#content').innerHTML=`<section class="band"><h2>已發布版本</h2><div class="table-wrap"><table><thead><tr><th>版本</th><th>時間</th><th>操作者</th><th>原因</th><th>操作</th></tr></thead><tbody>${state.versions.map(v=>`<tr><td>#${v.id}</td><td>${time(v.created_at)}</td><td>${escape(v.actor)}</td><td>${escape(v.reason)}</td><td><button type="button" data-restore="${v.id}">還原此版本</button></td></tr>`).join('')}</tbody></table></div></section><section><h2>操作紀錄</h2><div id="audit-log"></div></section>`;
        try{const logs=await api('history');if(page!=='history')return;$('#audit-log').innerHTML=logs.map(log=>`<details><summary>${time(log.created_at)} · ${escape(log.actor)} · ${escape(log.action)} · ${escape(log.kind)}</summary><pre>${escape(JSON.stringify({before:log.before_json&&JSON.parse(log.before_json),after:log.after_json&&JSON.parse(log.after_json)},null,2))}</pre></details>`).join('');}catch(error){notice(error.message,true);}
    }
    const field=(name,label,type,value,options={})=>{
        const id='field-'+name;
        if(type==='checkbox')return `<label class="checkbox ${options.full?'full':''}" for="${id}"><input id="${id}" name="${name}" type="checkbox" ${value?'checked':''}>${label}</label>`;
        if(type==='select')return `<label for="${id}">${label}<select id="${id}" name="${name}">${options.items.map(([v,t])=>`<option value="${escape(v)}" ${String(v)===String(value)?'selected':''}>${escape(t)}</option>`).join('')}</select></label>`;
        if(type==='textarea')return `<label class="full" for="${id}">${label}<textarea id="${id}" name="${name}" maxlength="${options.max||3000}">${escape(value)}</textarea></label>`;
        return `<label class="${options.full?'full':''}" for="${id}">${label}<input id="${id}" name="${name}" type="${type}" value="${escape(value)}" ${options.required?'required':''} ${type==='number'?`min="${options.min??0}" max="${options.max??1000000}" step="1"`:''} ${options.maxLength?`maxlength="${options.maxLength}"`:''}></label>`;
    };
    function edit(kind,id){
        const data=id?state[kind].find(x=>x.id===id):kind==='courses'?{name:'',shortName:'',summary:'',position:'',audience:'',sessions:null,minutes:null,level:'',sort:state.courses.length+1,isVisible:false,introUrl:''}:{courseId:state.courses[0]?.id,name:'',status:'not_open',regularPrice:0,earlyBirdPrice:null,earlyBirdEnabled:false,earlyBirdStart:null,earlyBirdEnd:null,startDate:null,endDate:null,registrationDeadline:null,weekday:1,startTime:'19:00',endTime:'21:00',sessions:12,minutes:120,platform:'Google Meet',capacity:null,enrolled:null,signupUrl:state.settings[0].lineUrl,notes:'',isFeatured:false,isVisible:false,sort:state.cohorts.length+1};
        editing={kind,id,data};$('#editor-title').textContent=`${id?'編輯':'新增'}${kind==='courses'?'課程':kind==='cohorts'?'招生期別':'回饋圖片'}`;$('#form-error').textContent='';
        const f=(n,l,t='text',o={})=>field(n,l,t,data[n],o);
        let html='';
        if(kind==='courses')html=f('name','課程名稱','text',{required:true})+f('shortName','課程簡稱','text',{required:true})+f('position','課程定位')+f('level','課程階序')+f('summary','課程簡介','textarea',{max:1500})+f('audience','適合對象','textarea',{max:1500})+f('sessions','課程堂數','number',{min:1,max:500})+f('minutes','每堂分鐘','number',{min:15,max:1440})+f('introUrl','相關介紹頁網址','text',{full:true})+f('sort','顯示排序','number',{max:10000})+f('isVisible','公開顯示此課程','checkbox');
        if(kind==='cohorts')html=f('courseId','所屬課程','select',{items:state.courses.map(c=>[c.id,c.name])})+f('name','招生期別名稱','text',{required:true})+f('status','招生狀態','select',{items:Object.entries(statuses)})+f('regularPrice','正式報名費（NT$）','number',{required:true})+f('earlyBirdEnabled','啟用公開早鳥優惠','checkbox')+f('earlyBirdPrice','早鳥報名費（NT$）','number')+f('earlyBirdStart','早鳥開始（台北時間，可留空）','datetime-local')+f('earlyBirdEnd','早鳥截止（留空時由管理員關閉）','datetime-local')+f('startDate','預計開課日期','date')+f('endDate','課程結束日期','date')+f('registrationDeadline','報名截止日期','date')+f('weekday','上課星期','select',{items:[['','待確認'],...['日','一','二','三','四','五','六'].map((s,i)=>[i,'星期'+s])]})+f('startTime','上課開始','time')+f('endTime','上課結束','time')+f('sessions','課程堂數','number',{required:true,min:1,max:500})+f('minutes','每堂分鐘','number',{required:true,min:15,max:1440})+f('platform','授課平台','text',{required:true})+f('capacity','招生人數上限（可留空）','number',{min:1,max:100000})+f('enrolled','目前報名人數（可留空）','number',{max:100000})+f('signupUrl','報名入口（HTTPS）','text',{required:true,full:true})+f('notes','補充說明','textarea')+f('sort','顯示排序','number',{max:10000})+f('isFeatured','設為主要推薦班別','checkbox')+f('isVisible','公開顯示此期別','checkbox');
        if(kind==='feedback')html=`<div class="full"><img id="editor-image" class="editor-image" data-media-id="${data.mediaId}"${mediaSource(data.mediaId,'full')} alt="${escape(data.description)}"><button type="button" id="open-redactor">遮蔽敏感資訊</button><input name="mediaId" type="hidden" value="${data.mediaId}"></div>`+f('description','圖片說明','textarea',{max:500})+f('sort','顯示排序','number',{max:100000})+f('isFeatured','首頁精選','checkbox')+f('isVisible','發布後公開顯示','checkbox');
        $('#editor-fields').innerHTML=html;$('#editor').showModal();
    }
    function formData(form){const data={};for(const input of form.querySelectorAll('[name]'))data[input.name]=input.type==='checkbox'?input.checked:input.type==='number'||input.name==='weekday'?(input.value===''?null:Number(input.value)):input.value;return data;}
    function renderSettings(){const settings=state.settings[0];$('#content').innerHTML=`<section class="band"><h2>公開網站設定</h2><form id="settings-form" class="settings-form">${field('featuredDesktop','首頁桌面精選數量','number',settings.featuredDesktop,{required:true,min:1,max:24})}${field('featuredMobile','首頁手機精選數量','number',settings.featuredMobile,{required:true,min:1,max:24})}${field('lineUrl','官方 LINE 網址','url',settings.lineUrl,{required:true})}<button class="primary" type="submit">儲存設定草稿</button></form></section><section><h2>變更登入密碼</h2><form id="password-form" class="settings-form"><label>目前密碼<input type="password" name="current" autocomplete="current-password" required></label><label>新密碼<input type="password" name="password" minlength="10" maxlength="128" autocomplete="new-password" required></label><label>再次輸入新密碼<input type="password" name="confirm" minlength="10" maxlength="128" autocomplete="new-password" required></label><button type="submit">變更密碼並重新登入</button></form></section>`;}
    $('#login-form').addEventListener('submit',async event=>{event.preventDefault();const button=event.submitter,label=button.textContent;button.disabled=true;button.textContent='登入中...';event.target.setAttribute('aria-busy','true');$('#login-error').textContent='';try{const data=Object.fromEntries(new FormData(event.target));if(cloud)data.remember=event.target.elements.remember.checked;const session=await request('login','POST',data);csrf=session.csrf;event.target.reset();await bootstrap(cloud?session:undefined);}catch(error){$('#login-error').textContent=error.message;}finally{button.disabled=false;button.textContent=label;event.target.removeAttribute('aria-busy');}});
    let mediaGeneration=0;
    $('#content').addEventListener('click',async event=>{
        const trigger=event.target.closest('[data-open-media]');if(!trigger)return;
        const generation=++mediaGeneration,dialog=$('#media-viewer'),image=$('#media-viewer-image');
        image.removeAttribute('src');$('#media-viewer-status').textContent='圖片載入中...';dialog.showModal();
        try{image.onload=()=>{if(generation===mediaGeneration&&dialog.open)$('#media-viewer-status').textContent='';};image.onerror=()=>{if(generation===mediaGeneration&&dialog.open)$('#media-viewer-status').textContent='圖片載入失敗，請稍後再試';};image.src=transport.image(trigger.dataset.openMedia,'full');}
        catch(error){if(generation===mediaGeneration&&dialog.open)$('#media-viewer-status').textContent=error.message;}
    });
    $('#media-viewer').addEventListener('close',()=>{mediaGeneration++;$('#media-viewer-image').removeAttribute('src');});
    document.querySelectorAll('[data-page]').forEach(button=>button.addEventListener('click',()=>{page=button.dataset.page;feedbackPage=0;notice('');render();}));
    $('#refresh').addEventListener('click',()=>(page==='dashboard'?renderDashboard():refresh()).then(()=>notice('已重新載入')).catch(error=>notice(error.message,true)));
    $('#preview-target').addEventListener('change',event=>{$('#preview-link').href='/'+event.target.value+'?cms-preview=1';});
    let previewGeneration=0;
    $('#preview-link').addEventListener('click',event=>{if(!cloud)return;event.preventDefault();previewGeneration++;$('#preview-frame').src=$('#preview-link').href;$('#preview-dialog').showModal();});
    $('#preview-dialog').addEventListener('close',()=>{previewGeneration++;$('#preview-frame').removeAttribute('src');});
    window.addEventListener('message',async event=>{
        const frame=$('#preview-frame'),message=event.data,generation=previewGeneration;
        if(!cloud||!$('#preview-dialog').open||event.source!==frame.contentWindow||event.origin!=='null'||message?.type!=='dabao-preview-request'||!Number.isSafeInteger(message.id))return;
        let data,error;
        try{
            if(message.action==='preview'){
                data=await transport.request('preview');
            }else throw new Error('不允許此預覽操作');
        }catch(e){error=e.message;if(e.status===401)showLogin();}
        if(generation!==previewGeneration||!$('#preview-dialog').open)return;
        // Opaque sandbox origin requires '*'; only the exact active iframe can
        // request data, and the bridge never exposes tokens or write methods.
        frame.contentWindow.postMessage({type:'dabao-preview-response',id:message.id,data,error},'*');
    });
    $('#logout').addEventListener('click',()=>request('logout','POST',{}).then(()=>bootstrap()).catch(error=>notice(error.message,true)));
    $('#publish').addEventListener('click',async()=>{const button=$('#publish');button.disabled=true;try{if(!await confirm(`確定發布 ${state.pending} 項草稿？公開網站的課程與回饋將更新。`))return;await request('publish','POST',{confirm:'publish'});const channel=new BroadcastChannel('dabao-cms');channel.postMessage('published');channel.close();await refresh();notice(localEnvironment?'本機發布成功，本機預覽已使用新資料':'發布成功，公開網站已使用新資料');}catch(error){notice(error.message,true);}finally{button.disabled=!state?.pending;}});
    document.addEventListener('click',async event=>{
        const button=event.target.closest('button');if(!button)return;
        if(button.dataset.close){$('#'+button.dataset.close).close();return;}
        if(button.dataset.new){edit(button.dataset.new);return;}
        if(button.dataset.edit){edit(button.dataset.edit,button.dataset.id);return;}
        if(button.dataset.feedbackPage!==undefined){feedbackPage=Number(button.dataset.feedbackPage);renderFeedback();return;}
        if(button.id==='upload-picker'){$('#feedback-upload').click();return;}
        if(button.id==='open-redactor'){await openRedactor();return;}
        try{
            if(button.dataset.unpublish||button.dataset.delete){const kind=button.dataset.unpublish||button.dataset.delete;const item=state[kind].find(x=>x.id===button.dataset.id);const deleting=Boolean(button.dataset.delete);if(!await confirm(`${deleting?'刪除':'取消發布'}「${item.name||item.description||'此圖片'}」？${deleting?'會保留還原紀錄與原始檔':'不會刪除圖片原始檔'}`))return;await request(`${kind}/${item.id}${deleting?'':'/unpublish'}`,deleting?'DELETE':'POST',{confirm:item.id,revision:item.revision});await refresh();new BroadcastChannel('dabao-cms').postMessage('published');notice(deleting?'已刪除並取消公開':'已取消發布');}
            if(button.dataset.restore){if(!await confirm(`還原版本 #${button.dataset.restore}？將恢復該版本的公開內容，對應草稿亦會被取代。`))return;await request(`versions/${button.dataset.restore}/restore`,'POST',{confirm:'restore'});await refresh();new BroadcastChannel('dabao-cms').postMessage('published');notice('版本已還原並發布');}
            if(button.dataset.move){const index=state.feedback.findIndex(x=>x.id===button.dataset.id),other=state.feedback[index+Number(button.dataset.move)];if(!other)return;const item=state.feedback[index];await request('feedback/reorder','POST',{id:item.id,revision:item.revision,otherId:other.id,otherRevision:other.revision});await refresh();notice('排序草稿已儲存，發布後生效');}
        }catch(error){notice(error.message,true);}
    });
    $('#edit-form').addEventListener('submit',async event=>{event.preventDefault();const button=event.submitter;button.disabled=true;try{const data=formData(event.target);await request(`${editing.kind}${editing.id?'/'+editing.id:''}`,'PUT',{data,revision:editing.data.revision});$('#editor').close();await refresh();notice('草稿已儲存，公開網站尚未改變');}catch(error){$('#form-error').textContent=error.message;}finally{button.disabled=false;}});
    $('#content').addEventListener('input',event=>{if(event.target.id==='feedback-search'){filter=event.target.value;feedbackPage=0;const caret=event.target.selectionStart;renderFeedback();$('#feedback-search').focus();$('#feedback-search').setSelectionRange(caret,caret);}});
    $('#content').addEventListener('change',async event=>{if(event.target.id!=='feedback-upload')return;const files=[...event.target.files];if(files.length>30){notice('每批最多 30 張圖片',true);return;}let done=0,duplicates=0;try{for(const file of files){notice(`正在處理圖片 ${done+1} / ${files.length}`);const form=new FormData();form.set('file',file);const result=await api('upload',{method:'POST',body:form});done++;if(result.duplicate)duplicates++;}await refresh();notice(`已處理 ${done} 張圖片${duplicates?`，${duplicates} 張重複圖片未新增`:''}，新圖片均保留為未發布草稿`);}catch(error){await refresh();notice(`已處理 ${done} 張，${error.message}`,true);}});
    $('#content').addEventListener('change',event=>{if(event.target.id==='metrics-days'){metricsDays=Number(event.target.value);renderDashboard();}});
    $('#content').addEventListener('submit',async event=>{event.preventDefault();try{if(event.target.id==='settings-form'){await request('settings/site','PUT',{data:formData(event.target),revision:state.settings[0].revision});await refresh();notice('設定草稿已儲存');}if(event.target.id==='password-form'){const data=Object.fromEntries(new FormData(event.target));if(data.password!==data.confirm)throw new Error('兩次新密碼不一致');await request('password','POST',data);await bootstrap();$('#login-error').textContent='密碼已更新，請重新登入';}}catch(error){notice(error.message,true);}});
    let rectangles=[],drawing=null,image=null;
    const canvas=$('#redact-canvas'),ctx=canvas.getContext('2d');
    const draw=()=>{if(!image)return;ctx.drawImage(image,0,0,canvas.width,canvas.height);ctx.fillStyle='#111';for(const r of [...rectangles,...(drawing?[drawing]:[])])ctx.fillRect(r.x*canvas.width,r.y*canvas.height,r.width*canvas.width,r.height*canvas.height);};
    async function openRedactor(){image=new Image();image.crossOrigin='anonymous';image.src=$('#editor-image').src;await image.decode();canvas.width=Math.min(1400,image.naturalWidth);canvas.height=Math.round(image.naturalHeight*canvas.width/image.naturalWidth);rectangles=[];drawing=null;draw();$('#redact-error').textContent='';$('#redactor').showModal();}
    const point=event=>{const r=canvas.getBoundingClientRect();return{x:Math.max(0,Math.min(1,(event.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(event.clientY-r.top)/r.height))};};
    let start=null;
    canvas.addEventListener('pointerdown',event=>{start=point(event);canvas.setPointerCapture(event.pointerId);});
    canvas.addEventListener('pointermove',event=>{if(!start)return;const end=point(event);drawing={x:Math.min(start.x,end.x),y:Math.min(start.y,end.y),width:Math.abs(end.x-start.x),height:Math.abs(end.y-start.y)};draw();});
    canvas.addEventListener('pointerup',()=>{if(drawing&&drawing.width>0.002&&drawing.height>0.002)rectangles.push(drawing);drawing=null;start=null;draw();});
    $('#redact-undo').addEventListener('click',()=>{rectangles.pop();draw();});
    $('#redact-save').addEventListener('click',async()=>{const button=$('#redact-save');button.disabled=true;try{const form=$('#edit-form');const result=await request(`media/${form.elements.mediaId.value}/redact`,'POST',{rectangles});form.elements.mediaId.value=result.id;$('#editor-image').src=cloud?await transport.image(result.id,'full'):`/api/admin/media/${result.id}/full`;$('#redactor').close();$('#form-error').textContent='已產生遮蔽圖片，請儲存草稿後發布';}catch(error){$('#redact-error').textContent=error.message;}finally{button.disabled=false;}});
    bootstrap().catch(error=>{$('#login-error').textContent=error.message;});
})();
