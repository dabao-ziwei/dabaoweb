(() => {
    'use strict';
    const config=window.DabaoCmsConfig;
    if(!config?.enabled||config.provider!=='supabase')return;
    const base=config.apiBase.replace(/\/$/,'');
    const parsed=new URL(base);
    if(parsed.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(parsed.hostname))throw new Error('CMS API 必須使用 HTTPS');
    // Remembered sessions use a partitioned HttpOnly cookie. No passwords or
    // session tokens are written to Web Storage or URLs.
    let token='';
    const mediaBase=(config.mediaBase||parsed.origin+'/storage/v1/object/public/dabao-cms-public').replace(/\/$/,'');
    function clear(){token='';}
    async function fetchAdmin(path,options={}){
        const headers=new Headers(options.headers);
        headers.delete('X-CSRF-Token');
        if(token)headers.set('Authorization','Bearer '+token);
        if(options.body&&!(options.body instanceof FormData))headers.set('Content-Type','application/json');
        return fetch(base+'/api/admin/'+path,{...options,headers,credentials:'include',cache:'no-store',signal:AbortSignal.timeout(30000)});
    }
    function imageUrl(id,variant='full'){
        if(!/^[a-z0-9-]{1,100}$/.test(id)||!['full','thumb'].includes(variant))throw new Error('圖片路徑不正確');
        return `${mediaBase}/${id}/${variant}.webp`;
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
        image:imageUrl,
        clear
    };
    window.addEventListener('pagehide',clear);
})();
