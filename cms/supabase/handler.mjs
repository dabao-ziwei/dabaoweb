import { fail } from '../validation.mjs';
import { CloudModel } from './model.mjs';
import { sha256 } from './images.mjs';
import { validEvent, reportWithLabels } from '../../site-metrics-catalog.mjs';

const maxBody=10*1024*1024+65536;
const cookieName='__Host-dabaoCMS';
const sessionCookie=(token,days=30)=>`${cookieName}=${token}; Path=/; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=${days*86400}`;
async function readBody(request,limit) {
    const reader=request.body?.getReader();if(!reader)return new Uint8Array();
    const chunks=[];let length=0;
    try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>limit){await reader.cancel();fail('資料過大',413);}chunks.push(value);}}finally{reader.releaseLock();}
    const result=new Uint8Array(length);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.length;}return result;
}
async function input(request) {
    if(!request.headers.get('Content-Type')?.startsWith('application/json'))fail('請使用 JSON 格式',415);
    try{const data=JSON.parse(new TextDecoder().decode(await readBody(request,128*1024)));if(!data||typeof data!=='object'||Array.isArray(data))fail('JSON 必須為物件',400);return data;}catch(e){if(e.status)throw e;fail('JSON 格式錯誤',400);}
}
export function createCloudHandler({services,images,origins,metricsEnabled=false,basePath='/functions/v1/dabao-cms'}) {
    let imageJobs=0;
    const loadModel=(record,actor)=>new CloudModel(record,actor,services.publicMediaBase);
    return async request=>{
        const url=new URL(request.url),origin=request.headers.get('Origin');
        const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow','Vary':'Origin'};
        if(origin&&origins.includes(origin))Object.assign(headers,{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Credentials':'true','Access-Control-Allow-Headers':'Authorization, Content-Type, If-None-Match','Access-Control-Allow-Methods':'GET, POST, PUT, DELETE, OPTIONS','Access-Control-Expose-Headers':'ETag'});
        const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{...headers,'Content-Type':'application/json; charset=utf-8'}});
        try{
            if(origin&&!origins.includes(origin))fail('不允許此來源',403);
            if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
            // Hosted Edge Gateway removes /functions/v1 before forwarding.
            const prefix=[basePath,basePath.replace(/^\/functions\/v1/,'')].find(path=>url.pathname.startsWith(path+'/'));
            if(!prefix)fail('找不到 API',404);
            const route=url.pathname.slice(prefix.length),method=request.method;
            const admin=route.startsWith('/api/admin/');
            const cookie=request.headers.get('Cookie')?.split(';').map(part=>part.trim()).find(part=>part.startsWith(cookieName+'='))?.slice(cookieName.length+1)||'';
            const token=(request.headers.get('Authorization')||'').replace(/^Bearer /,'')||cookie;
            const hash=/^[a-f0-9]{64}$/.test(token)?await sha256(new TextEncoder().encode(token)):'';
            const requireSession=async()=>{if(!hash)fail('請重新登入',401);return services.rpc('session',{hash});};
            if(route==='/healthz'&&method==='GET')return json({ok:true});
            if(route==='/api/public/metrics'&&method==='POST'){
                if(!metricsEnabled)return json({enabled:false},503);
                if(!origin)fail('統計請求缺少來源',403);
                let event;
                try{event=JSON.parse(new TextDecoder().decode(await readBody(request,512)));}catch(error){if(error.status)throw error;fail('統計格式不正確',400);}
                if(!validEvent(event))fail('統計格式不正確',400);
                await services.metrics('collect',event);
                return new Response(null,{status:204,headers});
            }
            if(route==='/api/admin/metrics'&&method==='GET'){
                if(!hash)fail('請重新登入',401);
                if(!metricsEnabled){await requireSession();return json({enabled:false});}
                const days=Number(url.searchParams.get('days')||0);
                if(![0,1,7,30].includes(days))fail('統計區間不正確',400);
                return json(reportWithLabels(await services.metrics('report',{hash,days})));
            }
            if(route==='/api/admin/session'&&method==='GET'){
                if(!hash)return json({authenticated:false});
                try{const {record,...session}=await services.rpc('session_bundle',{hash});return json({...session,state:loadModel(record,session.username).adminData()});}catch(e){if(e.status===401){headers['Set-Cookie']=sessionCookie('',0);return json({authenticated:false});}throw e;}
            }
            if(route==='/api/admin/login'&&method==='POST'){
                if(!origin)fail('登入請求缺少來源',403);
                const data=await input(request);
                if(typeof data.username!=='string'||data.username.length>80||typeof data.password!=='string'||data.password.length>128)fail('帳號或密碼錯誤',401);
                const name=data.username.trim().toLowerCase();
                const ip=request.headers.get('x-forwarded-for')?.split(',')[0].trim()||'unknown';
                if(data.remember!==undefined&&typeof data.remember!=='boolean')fail('登入設定不正確',400);
                const account=await sha256(new TextEncoder().encode('account:'+name));
                const preparation=await services.rpc('login_prepare',{name,account,ip:await sha256(new TextEncoder().encode('ip:'+ip))});
                if(!preparation.allowed){headers['Retry-After']=String(preparation.retrySeconds);fail(`登入嘗試過多，請 ${preparation.retrySeconds} 秒後再試`,429);}
                const member=preparation.member;
                if(!member)fail('帳號或密碼錯誤',401);
                const verified=await services.signIn(member.email,data.password);
                if(verified.user.id!==member.userId)fail('帳號或密碼錯誤',401);
                const access=[...crypto.getRandomValues(new Uint8Array(32))].map(b=>b.toString(16).padStart(2,'0')).join('');
                const {record,...session}=await services.rpc('login_finish',{userId:member.userId,hash:await sha256(new TextEncoder().encode(access)),remember:data.remember===true,account});
                headers['Set-Cookie']=data.remember?sessionCookie(access):sessionCookie('',0);
                return json({...session,token:access,state:loadModel(record,session.username).adminData()});
            }
            const mediaRoute=route.match(/^\/(api\/admin\/)?media\/([a-z0-9-]{1,100})\/(full|thumb|original)$/);
            if(mediaRoute&&method==='GET'){
                const [,privatePrefix,id,variant]=mediaRoute;
                // Compatibility for old links only. New pages use Storage URLs
                // directly: no Edge invocation or database lookup per image.
                if(variant!=='original'){
                    return new Response(null,{status:302,headers:{...headers,Location:`${services.publicMediaBase}/${id}/${variant}.webp`}});
                }
                if(!privatePrefix)fail('找不到圖片',404);
                await requireSession();
                const bytes=await services.getObject(id,'original');
                return new Response(bytes,{headers:{...headers,'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="original.bin"'}});
            }
            let session;
            if(admin){session=await requireSession();if(!['GET','HEAD'].includes(method)&&!origin)fail('管理請求缺少來源',403);}
            if(route==='/api/admin/logout'&&method==='POST'){const result=await services.rpc('logout',{hash});headers['Set-Cookie']=sessionCookie('',0);return json(result);}
            if(route==='/api/admin/password'&&method==='POST'){
                const data=await input(request);
                if(typeof data.password!=='string'||data.password.length<10||data.password.length>128)fail('新密碼須為 10～128 個字元');
                if(typeof data.current!=='string'||data.current.length>128)fail('目前密碼錯誤',401);
                await services.changePassword(await services.emailForUser(session.userId),data.current,data.password,session.userId,()=>services.rpc('revoke',{hash}));
                headers['Set-Cookie']=sessionCookie('',0);
                return json({ok:true,loginRequired:true});
            }
            const model=loadModel(await services.rpc('read'),session?.username);
            if(route==='/api/admin/state'&&method==='GET')return json(model.adminData());
            if(route==='/api/admin/history'&&method==='GET'){
                const rows=await services.rpc('history');return json(rows.map(row=>({...row,before_json:row.before_json===null?null:JSON.stringify(row.before_json),after_json:row.after_json===null?null:JSON.stringify(row.after_json)})));
            }
            if(route==='/api/admin/preview'&&method==='GET')return json(model.publicData({draft:true}));
            if(route.startsWith('/api/public/')&&method==='GET'){
                const data=model.publicData();let result;
                if(route==='/api/public/content'){const {feedback,...content}=data;result={...content,metrics:{enabled:metricsEnabled,version:1}};}
                else if(route==='/api/public/feedback'){
                    const offset=Number(url.searchParams.get('offset')||0),limit=Number(url.searchParams.get('limit')||24);
                    if(!Number.isInteger(offset)||offset<0||offset>100000||!Number.isInteger(limit)||limit<1||limit>60)fail('分頁參數不正確');
                    result={version:data.version,total:data.feedbackCount,items:data.feedback.slice(offset,offset+limit),next:offset+limit<data.feedbackCount?offset+limit:null};
                }else fail('找不到 API',404);
                const raw=JSON.stringify(result),etag='"'+await sha256(new TextEncoder().encode(raw))+'"';
                const publicHeaders={...headers,'ETag':etag,'Cache-Control':'no-cache, must-revalidate','Content-Type':'application/json; charset=utf-8'};
                const candidates=(request.headers.get('If-None-Match')||'').split(',').map(value=>value.trim().replace(/^W\//,''));
                if(candidates.includes(etag)||candidates.includes('*'))return new Response(null,{status:304,headers:publicHeaders});
                return new Response(raw,{headers:publicHeaders});
            }
            // This guard is independent of CORS and applies to every write path.
            if(!admin||!session)fail('找不到 API',404);
            const commit=()=>services.rpc('commit',model.commit(hash));
            if(route==='/api/admin/dashboard-settings'&&method==='PUT'){
                const data=await input(request),settings=model.saveDashboardSettings(data.data,data.revision);
                await commit();return json(settings);
            }
            if(route==='/api/admin/publish'&&method==='POST'){
                if((await input(request)).confirm!=='publish')fail('請確認發布');model.publish();return json(await commit());
            }
            const restore=route.match(/^\/api\/admin\/versions\/(\d+)\/restore$/);
            if(restore&&method==='POST'){
                if((await input(request)).confirm!=='restore')fail('請確認版本還原');
                model.restore(await services.rpc('version',{id:Number(restore[1])}),Number(restore[1]));return json(await commit());
            }
            const redact=route.match(/^\/api\/admin\/media\/([a-z0-9-]{1,100})\/redact$/);
            if((route==='/api/admin/upload'||redact)&&method==='POST'){
                if(imageJobs)fail('圖片正在處理，請稍後再試',429);imageJobs++;
                let newId,commitAttempted=false;
                try{
                    let bytes,name,rectangles;
                    if(redact){
                        if(!model.document.media.some(m=>m.id===redact[1]))fail('圖片不存在',404);
                        rectangles=(await input(request)).rectangles;
                        if(!rectangles)fail('請先標示需要遮蔽的範圍');
                        bytes=await services.getObject(redact[1],'full');name='redacted.webp';
                    }else{
                        const limited=await readBody(request,maxBody);
                        let form;try{form=await new Request(request.url,{method:'POST',headers:{'Content-Type':request.headers.get('Content-Type')||''},body:limited}).formData();}catch{fail('圖片上傳格式不正確',400);}
                        const file=form.get('file');if(!file||typeof file.arrayBuffer!=='function')fail('請選擇圖片');
                        bytes=new Uint8Array(await file.arrayBuffer());name=file.name;
                    }
                    const transformed=await images.transform(bytes,rectangles),digest=await sha256(transformed.full);
                    const sourceHash=await sha256(bytes);
                    let image=model.document.media.find(m=>m.sha256===digest||(!redact&&m.source_sha256===sourceHash));
                    if(!image){
                        const id=crypto.randomUUID();newId=id;
                        for(const variant of ['original','full','thumb'])await services.putObject(id,variant,transformed[variant]);
                        image=model.addMedia({id,sha256:digest,source_sha256:await sha256(transformed.original),width:transformed.width,height:transformed.height,original_mime:transformed.mime,bytes:transformed.original.length,original_name:String(name).split(/[\\/]/).pop().replace(/[\x00-\x1f]/g,'').slice(0,200),source_url:null,created_at:new Date().toISOString(),created_by:session.username});
                    }
                    if(redact){model.log('redact','media',image.id,{mediaId:redact[1]},{mediaId:image.id,rectangles});commitAttempted=true;await commit();newId=null;return json(image,201);}
                    const existing=model.rows('feedback').find(r=>r.draft.mediaId===image.id);
                    if(existing&&!newId)return json({duplicate:true,item:model.item(existing)});
                    const item=model.save('feedback',null,{mediaId:image.id,description:'',sort:model.rows('feedback',true).length+1,isVisible:false,isFeatured:false});
                    commitAttempted=true;await commit();newId=null;return json({duplicate:false,item},201);
                }catch(error){if(newId&&(!commitAttempted||error.status===409))try{await services.deleteObjects(newId);}catch{}throw error;}
                finally{imageJobs--;}
            }
            if(route==='/api/admin/feedback/reorder'&&method==='POST'){const result=model.reorder(await input(request));await commit();return json(result);}
            const entity=route.match(/^\/api\/admin\/(courses|cohorts|feedback|settings)(?:\/([a-z0-9-]{1,100}))?(?:\/(unpublish))?$/);
            if(entity){
                const [,kind,id,action]=entity;
                if(method==='PUT'&&!action){const data=await input(request);const result=model.save(kind,id||null,data.data,data.revision);await commit();return json(result);}
                if((method==='DELETE'&&!action)||(method==='POST'&&action==='unpublish')){
                    const data=await input(request);if(data.confirm!==id)fail('請確認此操作');model.remove(kind,id,data.revision,method==='DELETE');return json(await commit());
                }
            }
            return json({error:'找不到 API'},404);
        }catch(error){return json({error:error.status?error.message:'雲端服務暫時無法使用，請稍後再試'},error.status||503);}
    };
}
