(() => {
    'use strict';
    const config=window.DabaoCmsConfig||{enabled:false};
    const preview=Boolean(window.DabaoCmsPreview);
    const base=(config.apiBase||location.origin).replace(/\/$/,'');
    let snapshot,tag='',signature='',busy=null;
    const listeners=new Set();
    const absolute=value=>value?new URL(value.startsWith('/')?base+value:value,base+'/').href:'';
    const cloudPreview=preview&&config.provider==='supabase';
    let previewSequence=0;
    const previewPending=new Map(),previewImages=new Map();
    window.addEventListener('message',event=>{
        if(!cloudPreview||event.source!==parent||event.origin!==location.origin||event.data?.type!=='dabao-preview-response')return;
        const pending=previewPending.get(event.data.id);if(!pending)return;
        clearTimeout(pending.timer);previewPending.delete(event.data.id);
        if(event.data.error)pending.reject(new Error(event.data.error));else pending.resolve(event.data.data);
    });
    const previewRequest=(action,extra={})=>new Promise((resolve,reject)=>{
        if(parent===window){reject(new Error('請從管理後台開啟草稿預覽'));return;}
        const id=++previewSequence;
        const timer=setTimeout(()=>{previewPending.delete(id);reject(new Error('草稿預覽連線逾時，請重新開啟'));},30000);
        previewPending.set(id,{resolve,reject,timer});
        parent.postMessage({type:'dabao-preview-request',id,action,...extra},location.origin);
    });
    const image=async value=>{
        if(!cloudPreview)return absolute(value);
        const match=new URL(value,base+'/').pathname.match(/\/api\/admin\/media\/([a-z0-9-]+)\/(full|thumb)$/);
        if(!match)throw new Error('預覽圖片路徑不正確');
        const key=match[1]+'/'+match[2];
        if(!previewImages.has(key))previewImages.set(key,previewRequest('image',{mediaId:match[1],variant:match[2]}).then(data=>URL.createObjectURL(new Blob([data.bytes],{type:data.mime}))).catch(error=>{previewImages.delete(key);throw error;}));
        return previewImages.get(key);
    };
    const normalizeItems=items=>Promise.all(items.map(async f=>({...f,image:absolute(f.image),thumbnail:cloudPreview?await image(f.thumbnail):absolute(f.thumbnail)})));
    const normalize=async data=>({...data,featuredFeedback:await normalizeItems(data.featuredFeedback||[]),...(data.feedback?{feedback:data.feedback.map(f=>({...f,image:absolute(f.image),thumbnail:absolute(f.thumbnail)}))}:{})});
    const previewLinks=()=>{if(preview)document.querySelectorAll('a[href]').forEach(link=>{const url=new URL(link.href);if(url.origin===location.origin&&url.pathname.endsWith('.html')&&!url.pathname.startsWith('/admin/')){url.searchParams.set('cms-preview','1');link.href=url.href;}});};
    async function read(path,headers={}){
        const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),5000);
        try{
            if(cloudPreview&&path==='/api/admin/preview')return new Response(JSON.stringify(await previewRequest('preview')),{headers:{'Content-Type':'application/json'}});
            return await fetch(base+path,{credentials:preview?'include':'omit',cache:'no-cache',headers,signal:controller.signal});
        }finally{clearTimeout(timer);}
    }
    async function refresh(){
        if(!config.enabled)return null;
        if(busy)return busy;
        busy=(async()=>{
            try{
                const response=await read(preview?'/api/admin/preview':'/api/public/content',tag&&!preview?{'If-None-Match':tag}:{});
                if(response.status===304)return snapshot;
                if(!response.ok)throw new Error('CMS unavailable');
                const payload=await response.json(),nextSignature=JSON.stringify(payload);
                tag=response.headers.get('ETag')||'';
                // Focus refreshes must not rebuild an unchanged gallery and
                // close the image that the user has just opened.
                if(snapshot&&nextSignature===signature){previewLinks();return snapshot;}
                snapshot=await normalize(payload);signature=nextSignature;
                document.querySelectorAll('[data-cms-line]').forEach(link=>{link.href=snapshot.settings.lineUrl;});
            }catch{snapshot=null;tag='';signature='';}
            listeners.forEach(listener=>listener(snapshot));
            previewLinks();
            return snapshot;
        })();
        try{return await busy;}finally{busy=null;}
    }
    window.DabaoCMS={enabled:config.enabled,preview,absolute,image,refresh,subscribe(listener){listeners.add(listener);if(snapshot!==undefined)listener(snapshot);return()=>listeners.delete(listener);},async feedback(offset=0){
        if(preview){const data=snapshot?.feedback||[];return{items:await normalizeItems(data.slice(offset,offset+24)),total:data.length,next:offset+24<data.length?offset+24:null};}
        const response=await read(`/api/public/feedback?offset=${offset}&limit=24`);
        if(!response.ok)throw new Error('回饋暫時無法載入，請稍後再試');
        const data=await response.json();return{...data,items:data.items.map(f=>({...f,image:absolute(f.image),thumbnail:absolute(f.thumbnail)}))};
    }};
    if(preview){
        const banner=document.createElement('div');banner.className='cms-preview-banner';banner.textContent='草稿預覽｜尚未發布';banner.setAttribute('role','status');document.body.prepend(banner);
        const robots=document.createElement('meta');robots.name='robots';robots.content='noindex, nofollow';document.head.append(robots);
    }
    window.DabaoCMS.ready=config.enabled?refresh():Promise.resolve(null);
    if(config.enabled){
        window.setInterval(()=>{if(!document.hidden)refresh();},Math.max(15,config.pollSeconds||60)*1000);
        document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
        window.addEventListener('focus',refresh);
        if('BroadcastChannel'in window)new BroadcastChannel('dabao-cms').addEventListener('message',refresh);
    }
})();
