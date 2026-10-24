import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { emptyDocument, CloudModel } from './model.mjs';
import { validate, kinds } from '../validation.mjs';
import { sha256 } from './images.mjs';

const root=path.resolve(fileURLToPath(new URL('../../',import.meta.url)));
export async function exportPackage(source,destination){
    source=await fs.realpath(source);destination=path.resolve(destination);
    const parent=await fs.realpath(path.dirname(destination));destination=path.join(parent,path.basename(destination));
    if(destination===root||destination.startsWith(root+path.sep)||destination===source||destination.startsWith(source+path.sep))throw new Error('遷移包須存放在網站與來源資料目錄之外');
    await fs.mkdir(destination,{mode:0o700});
    const db=new DatabaseSync(path.join(source,'cms.sqlite'),{readOnly:true});
    const payload={document:emptyDocument(),versions:[],audit:[]};
    try{
        db.exec('BEGIN');
        for(const kind of kinds)payload.document[kind]=db.prepare('select * from '+kind).all().map(row=>({id:row.id,draft:JSON.parse(row.draft_json),published:row.published_json?JSON.parse(row.published_json):null,revision:row.revision,deleted_at:row.deleted_at,updated_at:row.updated_at,updated_by:row.updated_by}));
        payload.document.media=db.prepare('select * from media').all();
        payload.versions=db.prepare('select * from versions order by id').all().map(row=>({id:row.id,snapshot:JSON.parse(row.snapshot_json),actor:row.actor,reason:row.reason,created_at:row.created_at}));
        payload.audit=db.prepare('select * from audit_log order by id').all().map(row=>({...row,before_json:row.before_json?JSON.parse(row.before_json):null,after_json:row.after_json?JSON.parse(row.after_json):null}));
        db.exec('COMMIT');
    }finally{db.close();}
    const files=[];
    async function write(relative,bytes){const target=path.join(destination,relative);await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});await fs.writeFile(target,bytes,{mode:0o600,flag:'wx'});files.push({path:relative,bytes:bytes.length,sha256:await sha256(bytes)});}
    await write('state.json',new TextEncoder().encode(JSON.stringify(payload)));
    for(const image of payload.document.media){
        if(!/^[a-z0-9-]{1,100}$/.test(image.id))throw new Error('圖片 ID 不正確');
        for(const name of ['original.bin','full.webp','thumb.webp'])await write('media/'+image.id+'/'+name,await fs.readFile(path.join(source,'media',image.id,name)));
    }
    const counts={courses:payload.document.courses.length,cohorts:payload.document.cohorts.length,feedback:payload.document.feedback.length,media:payload.document.media.length,versions:payload.versions.length,audit:payload.audit.length};
    const manifest={format:'dabao-cms-supabase-v1',createdAt:new Date().toISOString(),counts,files};
    await fs.writeFile(path.join(destination,'manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600,flag:'wx'});
    await verifyPackage(destination);
    return manifest;
}
export async function verifyPackage(directory){
    directory=await fs.realpath(directory);
    const manifest=JSON.parse(await fs.readFile(path.join(directory,'manifest.json'),'utf8'));
    if(manifest.format!=='dabao-cms-supabase-v1'||!Array.isArray(manifest.files))throw new Error('遷移包格式不正確');
    const seen=new Set();
    for(const file of manifest.files){
        if(typeof file.path!=='string'||!/^state\.json$|^media\/[a-z0-9-]{1,100}\/(original\.bin|full\.webp|thumb\.webp)$/.test(file.path)||seen.has(file.path))throw new Error('遷移包路徑不正確');
        seen.add(file.path);const target=await fs.realpath(path.join(directory,file.path));
        if(!target.startsWith(directory+path.sep))throw new Error('不允許符號連結離開遷移包');
        const bytes=await fs.readFile(target);if(bytes.length!==file.bytes||await sha256(bytes)!==file.sha256)throw new Error('遷移包 SHA-256 驗證失敗：'+file.path);
    }
    if(!seen.has('state.json'))throw new Error('遷移包缺少資料');
    const payload=JSON.parse(await fs.readFile(path.join(directory,'state.json'),'utf8'));
    for(const kind of kinds){
        if(!Array.isArray(payload.document[kind]))throw new Error('遷移包缺少資料類型');
        const ids=new Set();
        for(const row of payload.document[kind]){
            if(!/^[a-z0-9-]{1,100}$/.test(row.id)||ids.has(row.id)||!Number.isInteger(row.revision)||row.revision<1)throw new Error('遷移資料 ID 或 revision 不正確');
            ids.add(row.id);validate(kind,row.draft);if(row.published)validate(kind,row.published);
        }
    }
    const mediaIds=new Set();
    for(const image of payload.document.media){
        if(!/^[a-z0-9-]{1,100}$/.test(image.id)||mediaIds.has(image.id))throw new Error('圖片 ID 不正確');mediaIds.add(image.id);
        for(const name of ['original.bin','full.webp','thumb.webp'])if(!seen.has('media/'+image.id+'/'+name))throw new Error('遷移包缺少圖片檔');
    }
    if(payload.document.feedback.some(r=>!mediaIds.has(r.draft.mediaId)||(r.published&&!mediaIds.has(r.published.mediaId))))throw new Error('遷移包回饋缺少圖片');
    const model=new CloudModel({document:payload.document});model.assertPublishable(model.snapshot(true));model.assertPublishable(model.snapshot());
    return {manifest,payload};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
    const [operation,source,destination]=process.argv.slice(2);
    if(operation==='export'&&source&&destination){const manifest=await exportPackage(source,destination);console.log(JSON.stringify({output:path.resolve(destination),counts:manifest.counts,verifiedFiles:manifest.files.length},null,2));}
    else if(operation==='verify'&&source){const {manifest}=await verifyPackage(source);console.log(JSON.stringify({valid:true,counts:manifest.counts,verifiedFiles:manifest.files.length},null,2));}
    else throw new Error('使用方式：export 私有資料目錄 新的私有輸出目錄，或 verify 遷移包目錄');
}
