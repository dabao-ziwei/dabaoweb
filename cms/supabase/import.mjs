import fs from 'node:fs/promises';
import path from 'node:path';
import { verifyPackage } from './migration.mjs';
import { supabaseServices } from './services.mjs';
import { sha256 } from './images.mjs';

// Never called by npm install, startup or a Git push. Production mutation needs
// an explicit owner-approved project confirmation and a private service secret.
const [directory,confirmation]=process.argv.slice(2);
const url=process.env.CMS_SUPABASE_URL,key=process.env.CMS_SUPABASE_SERVICE_ROLE_KEY;
if(!directory||!url||!key||confirmation!==`--confirm-project=${new URL(url).hostname.split('.')[0]}`)throw new Error('需要已核准的遷移包、私有環境變數與 --confirm-project=專案ID');
const {manifest,payload}=await verifyPackage(directory);
const services=supabaseServices({url,key});
const existing=await services.rpc('read');
if(existing.revision!==0)throw new Error('目標 CMS 已有資料，拒絕覆蓋或重複匯入');
for(const image of payload.document.media){
    for(const variant of ['original','full','thumb']){
        const name=variant==='original'?'original.bin':variant+'.webp';
        const bytes=new Uint8Array(await fs.readFile(path.join(directory,'media',image.id,name)));
        let existing;
        try{existing=await services.getObject(image.id,variant);}catch(error){if(error.status!==404)throw error;}
        if(existing){if(await sha256(existing)!==await sha256(bytes))throw new Error('雲端已有不同內容的圖片，拒絕覆蓋：'+image.id+'/'+name);}
        else await services.putObject(image.id,variant,bytes);
    }
}
await services.rpc('import',payload);
console.log(JSON.stringify({imported:true,counts:manifest.counts,notice:'尚未啟用正式前台，也未建立管理員'},null,2));
