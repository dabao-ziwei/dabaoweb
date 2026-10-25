import { fail } from '../validation.mjs';
export function supabaseServices({url,key,fetcher=fetch}) {
    if(!url?.startsWith('https://')||!key)throw new Error('Supabase server secrets missing');
    async function request(path,options={}) {
        const response=await fetcher(url+path,{...options,headers:{apikey:key,Authorization:`Bearer ${key}`,...options.headers},signal:AbortSignal.timeout(15000)});
        if(!response.ok){
            let data={};try{data=await response.json();}catch{}
            const message=data.message||data.msg||'';
            if(message.includes('CMS_UNAUTHORIZED'))fail('請重新登入',401);
            if(message.includes('CMS_FORBIDDEN'))fail('沒有後台權限',403);
            if(message.includes('CMS_CONFLICT'))fail('資料已更新，請重新載入後再儲存',409);
            if(response.status===404||(path.startsWith('/storage/v1/object/')&&response.status===400&&String(data.statusCode)==='404'&&data.code==='NoSuchKey'))fail('找不到資料',404);
            // Never forward provider response bodies, stack traces or SQL to clients.
            fail('雲端服務暫時無法使用，請稍後再試',503);
        }
        return response;
    }
    const json=async(path,method,data,headers={})=>(await request(path,{method,headers:{'Content-Type':'application/json',...headers},...(data?{body:JSON.stringify(data)}:{})})).json();
    const mediaPath=(id,variant)=>{
        if(!/^[a-z0-9-]{1,100}$/.test(id)||!['original','full','thumb'].includes(variant))throw new Error('Invalid media path');
        return `${variant==='original'?'dabao-cms-media':'dabao-cms-public'}/${id}/${variant==='original'?'original.bin':variant+'.webp'}`;
    };
    return {
        publicMediaBase:url+'/storage/v1/object/public/dabao-cms-public',
        rpc:(operation,payload={})=>json('/rest/v1/rpc/dabao_cms_backend','POST',{p_operation:operation,p_payload:payload}),
        async emailForUser(id){const user=await json(`/auth/v1/admin/users/${encodeURIComponent(id)}`,'GET');return user.email;},
        async signIn(email,password){
            const response=await fetcher(url+'/auth/v1/token?grant_type=password',{method:'POST',headers:{apikey:key,'Content-Type':'application/json'},body:JSON.stringify({email,password}),signal:AbortSignal.timeout(15000)});
            if(response.status===429)fail('登入驗證服務暫時限制請求，請稍後再試',429);
            if(response.status>=500)fail('登入驗證服務暫時無法使用，請稍後再試',503);
            if(!response.ok)fail('帳號或密碼錯誤',401);
            const result=await response.json();
            if(!result.user?.id||!result.access_token)fail('登入驗證失敗',401);
            return result;
        },
        async changePassword(email,current,password,id,beforeChange=async()=>{}){
            const session=await this.signIn(email,current);
            if(session.user.id!==id)fail('帳號或密碼錯誤',401);
            // Auth and our Postgres transaction cannot commit atomically.
            // Revoke first so a provider/network failure never leaves old CMS
            // sessions usable after a password change that might have succeeded.
            await beforeChange();
            await json('/auth/v1/user','PUT',{password},{Authorization:`Bearer ${session.access_token}`});
        },
        async putObject(id,variant,bytes){
            await request('/storage/v1/object/'+mediaPath(id,variant),{method:'POST',headers:{'Content-Type':variant==='original'?'application/octet-stream':'image/webp','x-upsert':'false','Cache-Control':variant==='original'?'no-store':'max-age=86400'},body:bytes});
        },
        async getObject(id,variant){
            return new Uint8Array(await (await request('/storage/v1/object/authenticated/'+mediaPath(id,variant))).arrayBuffer());
        },
        async getLegacyDerivative(id,variant){
            if(!['full','thumb'].includes(variant))throw new Error('Only display derivatives can be copied');
            mediaPath(id,variant);
            return new Uint8Array(await (await request(`/storage/v1/object/authenticated/dabao-cms-media/${id}/${variant}.webp`)).arrayBuffer());
        },
        async deleteObjects(id){
            mediaPath(id,'original');
            await json('/storage/v1/object/dabao-cms-public','DELETE',{prefixes:['full.webp','thumb.webp'].map(name=>id+'/'+name)});
            await json('/storage/v1/object/dabao-cms-media','DELETE',{prefixes:[id+'/original.bin']});
        }
    };
}
