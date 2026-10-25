import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PGlite } from '@electric-sql/pglite';
import * as magick from '@imagemagick/magick-wasm';
import sharp from 'sharp';
import { createCms } from '../../cms/server.mjs';
import { configuration } from '../../cms/config.mjs';
import { emptyDocument } from '../../cms/supabase/model.mjs';
import { imageProcessor, sha256 } from '../../cms/supabase/images.mjs';
import { createCloudHandler } from '../../cms/supabase/handler.mjs';
import { fail } from '../../cms/validation.mjs';
import { verifyPackage } from '../../cms/supabase/migration.mjs';

export async function sandbox({origins=['http://localhost:4283'],port=4283,fixtures=6,packageDirectory,accessMigration=true,publicMediaBase='http://localhost:4284/storage/v1/object/public/dabao-cms-public'}={}) {
    const pg=new PGlite();
    // This is a disposable Postgres engine. Only Supabase-owned Auth/Storage
    // infrastructure is stubbed; the actual migration and RPC execute verbatim.
    await pg.exec(`create role anon; create role authenticated; create role service_role;
        create schema auth; create table auth.users(id uuid primary key,email text);
        create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`);
    const migration=await fs.readFile(new URL('../../supabase/migrations/202610240001_dabao_cms.sql',import.meta.url),'utf8');
    await pg.exec(migration);
    if(accessMigration)await pg.exec(await fs.readFile(new URL('../../supabase/migrations/202610250001_cms_access_performance.sql',import.meta.url),'utf8'));
    await pg.exec(await fs.readFile(new URL('../../supabase/migrations/202610250002_public_feedback_media.sql',import.meta.url),'utf8'));
    const rpc=async(operation,payload={})=>{
        try{return (await pg.query('select public.dabao_cms_backend($1,$2::jsonb) as data',[operation,JSON.stringify(payload)])).rows[0].data;}
        catch(e){if(e.message.includes('CMS_UNAUTHORIZED'))fail('請重新登入',401);if(e.message.includes('CMS_CONFLICT'))fail('資料已更新，請重新載入後再儲存',409);if(e.message.includes('CMS_FORBIDDEN'))fail('沒有後台權限',403);throw e;}
    };
    const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'dabao-cloud-seed-'));
    const local=createCms(configuration({CMS_DATA_DIR:dataDir,CMS_PORT:'4989'}));
    const document=emptyDocument();
    for(const kind of ['courses','cohorts','feedback','settings'])document[kind]=local.store.rows(kind,true).map(row=>({id:row.id,draft:JSON.parse(row.draft_json),published:row.published_json?JSON.parse(row.published_json):null,revision:row.revision,updated_at:row.updated_at,updated_by:row.updated_by,deleted_at:row.deleted_at}));
    local.server.emit('close');local.store.close();await fs.rm(dataDir,{recursive:true,force:true});
    const wasm=await fs.readFile(new URL(import.meta.resolve('@imagemagick/magick-wasm/magick.wasm')));
    await magick.initializeImageMagick(wasm);
    const images=imageProcessor(magick),objects=new Map();
    for(let n=0;n<fixtures;n++){
        const id=crypto.randomUUID();
        const bytes=await sharp({create:{width:480,height:640,channels:3,background:{r:150+n*10,g:200-n*10,b:180}}}).png().toBuffer();
        const result=images.transform(bytes);
        const media={id,sha256:await sha256(result.full),source_sha256:await sha256(result.original),width:result.width,height:result.height,original_mime:result.mime,bytes:bytes.length,original_name:`synthetic-${n}.png`,source_url:null,created_at:new Date().toISOString(),created_by:'sandbox'};
        document.media.push(media);
        for(const variant of ['original','full','thumb'])objects.set(id+'/'+variant,result[variant]);
        const item={id:crypto.randomUUID(),mediaId:id,description:`隔離測試圖片 ${n+1}（非客戶回饋）`,sort:n+1,isFeatured:true,isVisible:true};
        document.feedback.push({id:item.id,draft:item,published:structuredClone(item),revision:1,updated_at:new Date().toISOString(),updated_by:'sandbox',deleted_at:null});
    }
    const snapshot=Object.fromEntries(['courses','cohorts','feedback','settings'].map(k=>[k,document[k].map(r=>r.published).filter(Boolean)]));
    if(packageDirectory){
        const {payload}=await verifyPackage(packageDirectory);
        for(const media of payload.document.media)for(const variant of ['original','full','thumb'])objects.set(media.id+'/'+variant,new Uint8Array(await fs.readFile(path.join(packageDirectory,'media',media.id,variant==='original'?'original.bin':variant+'.webp'))));
        await rpc('import',payload);
    }else await rpc('import',{document,snapshot});
    const userId='4c1c1647-a1f1-4a91-a731-f97706191b56';
    let password='Cloud-local-QA-12345!';
    await pg.query('insert into auth.users(id,email) values($1,$2)',[userId,'local-admin@example.invalid']);
    await pg.query('insert into dabao_cms.admins(user_id,login_name) values($1,$2)',[userId,'admin']);
    const services={rpc,async emailForUser(){return 'local-admin@example.invalid';},async signIn(email,value){if(email!=='local-admin@example.invalid'||value!==password)fail('帳號或密碼錯誤',401);return {user:{id:userId},access_token:'test-auth-token'};},async changePassword(email,current,next,id,beforeChange=async()=>{}){if(id!==userId)fail('沒有權限',403);await this.signIn(email,current);await beforeChange();password=next;},async putObject(id,variant,bytes){objects.set(id+'/'+variant,bytes);},async getObject(id,variant){const bytes=objects.get(id+'/'+variant);if(!bytes)fail('找不到圖片',404);return bytes;},async deleteObjects(id){for(const variant of ['original','full','thumb'])objects.delete(id+'/'+variant);}};
    services.publicMediaBase=publicMediaBase;
    const storage=async request=>{
        const match=new URL(request.url).pathname.match(/^\/storage\/v1\/object\/public\/dabao-cms-public\/([a-z0-9-]{1,100})\/(full|thumb)\.webp$/);
        if(!match||!['GET','HEAD'].includes(request.method))return new Response(null,{status:404});
        const bytes=objects.get(match[1]+'/'+match[2]);if(!bytes)return new Response(null,{status:404});
        const headers={'Content-Type':'image/webp','Access-Control-Allow-Origin':'*','Cache-Control':'public, max-age=86400','ETag':'"'+await sha256(bytes)+'"'};
        if(request.headers.get('If-None-Match')===headers.ETag)return new Response(null,{status:304,headers});
        return new Response(request.method==='HEAD'?null:bytes,{headers});
    };
    const handler=createCloudHandler({services,images,origins});
    return {pg,rpc,services,images,objects,storage,handler,userId,password,port,async close(){await pg.close();}};
}
