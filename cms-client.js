(() => {
    'use strict';
    const config=window.DabaoCmsConfig||{enabled:false};
    const preview=Boolean(window.DabaoCmsPreview);
    const base=(config.apiBase||location.origin).replace(/\/$/,'');
    let snapshot,tag='',busy=null;
    const listeners=new Set();
    const absolute=value=>value?new URL(value,base+'/').href:'';
    const normalize=data=>({...data,featuredFeedback:(data.featuredFeedback||[]).map(f=>({...f,image:absolute(f.image),thumbnail:absolute(f.thumbnail)})),...(data.feedback?{feedback:data.feedback.map(f=>({...f,image:absolute(f.image),thumbnail:absolute(f.thumbnail)}))}:{})});
    const previewLinks=()=>{if(preview)document.querySelectorAll('a[href]').forEach(link=>{const url=new URL(link.href);if(url.origin===location.origin&&url.pathname.endsWith('.html')&&!url.pathname.startsWith('/admin/')){url.searchParams.set('cms-preview','1');link.href=url.href;}});};
    async function read(path,headers={}){
        const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),5000);
        try{return await fetch(base+path,{credentials:preview?'include':'omit',cache:'no-cache',headers,signal:controller.signal});}finally{clearTimeout(timer);}
    }
    async function refresh(){
        if(!config.enabled)return null;
        if(busy)return busy;
        busy=(async()=>{
            try{
                const response=await read(preview?'/api/admin/preview':'/api/public/content',tag&&!preview?{'If-None-Match':tag}:{});
                if(response.status===304)return snapshot;
                if(!response.ok)throw new Error('CMS unavailable');
                snapshot=normalize(await response.json());tag=response.headers.get('ETag')||'';
                document.querySelectorAll('[data-cms-line]').forEach(link=>{link.href=snapshot.settings.lineUrl;});
            }catch{snapshot=null;tag='';}
            listeners.forEach(listener=>listener(snapshot));
            previewLinks();
            return snapshot;
        })();
        try{return await busy;}finally{busy=null;}
    }
    window.DabaoCMS={enabled:config.enabled,preview,absolute,refresh,subscribe(listener){listeners.add(listener);if(snapshot!==undefined)listener(snapshot);return()=>listeners.delete(listener);},async feedback(offset=0){
        if(preview){const data=snapshot?.feedback||[];return{items:data.slice(offset,offset+24),total:data.length,next:offset+24<data.length?offset+24:null};}
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
