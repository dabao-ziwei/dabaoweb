(() => {
    'use strict';
    const config=window.DabaoCmsConfig;
    if(!config?.enabled||config.provider!=='supabase')return;
    const base=config.apiBase.replace(/\/$/,'');
    const parsed=new URL(base);
    if(parsed.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(parsed.hostname))throw new Error('CMS API 必須使用 HTTPS');
    // The opaque server-validated session lives in memory, never in URLs or
    // localStorage. A read-only sandbox bridge serves draft previews.
    let token='',epoch=0;
    const media=new Map(),blobs=new Map();
    function clear(){token='';epoch++;for(const value of media.values())value.then(url=>URL.revokeObjectURL(url)).catch(()=>{});media.clear();blobs.clear();}
    async function fetchAdmin(path,options={}){
        const headers=new Headers(options.headers);
        headers.delete('X-CSRF-Token');
        if(token)headers.set('Authorization','Bearer '+token);
        if(options.body&&!(options.body instanceof FormData))headers.set('Content-Type','application/json');
        return fetch(base+'/api/admin/'+path,{...options,headers,credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(30000)});
    }
    async function imageData(id,variant='full'){
        if(!/^[a-z0-9-]{1,100}$/.test(id)||!['full','thumb'].includes(variant))throw new Error('圖片路徑不正確');
        const key=id+'/'+variant,start=epoch;
        if(!blobs.has(key))blobs.set(key,(async()=>{
            const response=await fetchAdmin('media/'+key);
            if(!response.ok)throw new Error('無法讀取管理圖片');
            const blob=await response.blob();if(start!==epoch)throw new Error('登入狀態已變更');return blob;
        })().catch(error=>{blobs.delete(key);throw error;}));
        return blobs.get(key);
    }
    window.DabaoCmsTransport={
        async request(path,options={}){
            try{
                const response=await fetchAdmin(path,options);
                const data=await response.json();
                if(!response.ok){const error=new Error(data.error||'操作失敗');error.status=response.status;if(response.status===401&&path!=='login')clear();throw error;}
                if(path==='login'){clear();token=data.token;delete data.token;}
                if(path==='password'||path==='logout')clear();
                return data;
            }catch(error){if(path==='password')clear();if(error instanceof TypeError||error.name==='TimeoutError')throw new Error('無法連線至管理服務，請稍後再試');throw error;}
        },
        async image(id,variant='full'){
            const key=id+'/'+variant;
            if(!media.has(key))media.set(key,imageData(id,variant).then(blob=>URL.createObjectURL(blob)).catch(error=>{media.delete(key);throw error;}));
            return media.get(key);
        },
        imageData,
        clear
    };
    window.addEventListener('pagehide',clear);
})();
