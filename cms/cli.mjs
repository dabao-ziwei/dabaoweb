import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { configuration } from './config.mjs';
import { Store } from './database.mjs';
import { Auth } from './auth.mjs';
import { Media } from './media.mjs';
import { seed } from './seed.mjs';
import { acquireLock } from './lock.mjs';

const config=configuration();
const args=process.argv.slice(2),command=args.shift();
const option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
async function backupStore(store,destination) {
    destination=path.resolve(destination);
    await fs.mkdir(destination,{recursive:true,mode:0o700});
    const real=await fs.realpath(destination),root=await fs.realpath(config.root);
    if(real===root||real.startsWith(root+path.sep))throw new Error('備份必須放在網站目錄外，避免公開私人資料');
    await store.backup(destination);
    const snapshot=new DatabaseSync(path.join(destination,'cms.sqlite'),{readOnly:true});
    const images=snapshot.prepare('SELECT * FROM media').all();snapshot.close();
    const manifest=[];
    for(const image of images) {
        const target=path.join(destination,'media',image.id);await fs.mkdir(target,{recursive:true,mode:0o700});
        for(const file of ['original.bin','full.webp','thumb.webp']) {
            const buffer=await fs.readFile(path.join(config.dataDir,'media',image.id,file));
            await fs.writeFile(path.join(target,file),buffer,{mode:0o600});
            manifest.push({file:`media/${image.id}/${file}`,sha256:createHash('sha256').update(buffer).digest('hex')});
        }
    }
    const database=await fs.readFile(path.join(destination,'cms.sqlite'));
    manifest.push({file:'cms.sqlite',sha256:createHash('sha256').update(database).digest('hex')});
    await fs.writeFile(path.join(destination,'manifest.json'),JSON.stringify({createdAt:new Date().toISOString(),files:manifest},null,2),{mode:0o600});
    return destination;
}
async function main() {
    process.umask(0o077);
    if(command==='restore') {
        const source=option('--from');
        if(!source||!args.includes('--confirm-replace'))throw new Error('請先停止 CMS，再使用 --from 備份目錄 --confirm-replace');
        const manifest=JSON.parse(await fs.readFile(path.join(source,'manifest.json'),'utf8'));
        for(const file of manifest.files) {
            if(file.file.includes('..')||path.isAbsolute(file.file))throw new Error('備份路徑不正確');
            const buffer=await fs.readFile(path.join(source,file.file));
            if(createHash('sha256').update(buffer).digest('hex')!==file.sha256)throw new Error(`備份驗證失敗：${file.file}`);
        }
        const old=new Store(config);
        const rescue=path.join(config.dataDir,'backups',`before-restore-${Date.now()}`);
        await backupStore(old,rescue);old.close();
        await fs.cp(path.join(source,'media'),path.join(config.dataDir,'media'),{recursive:true,force:true}).catch(error=>{if(error.code!=='ENOENT')throw error;});
        const temporary=path.join(config.dataDir,'restore.sqlite.tmp');
        await fs.copyFile(path.join(source,'cms.sqlite'),temporary);
        for(const file of ['cms.sqlite-wal','cms.sqlite-shm'])await fs.rm(path.join(config.dataDir,file),{force:true});
        await fs.rename(temporary,path.join(config.dataDir,'cms.sqlite'));
        const restored=new Store(config);restored.db.exec('DELETE FROM sessions; DELETE FROM login_challenges;');restored.audit('cli','restore_backup','system',null,null,{source});restored.close();
        console.log(`備份已還原；還原前備份：${rescue}`);return;
    }
    const store=new Store(config);seed(store);
    try {
        if(command==='admin') {
            const username=option('--username')||'admin';let password;
            if(args.includes('--generate'))password=randomBytes(24).toString('base64url');
            else {
                if(!stdin.isTTY)throw new Error('請從互動終端建立管理員；測試帳號可用 --generate');
                let muted=false;
                const sink=new Writable({write(chunk,encoding,callback){if(!muted)stdout.write(chunk);callback();}});
                const prompt=createInterface({input:stdin,output:sink,terminal:true});
                stdout.write('管理員密碼（至少 10 字元，不會顯示）：');muted=true;password=await prompt.question('');muted=false;stdout.write('\n');
                stdout.write('再次輸入密碼：');muted=true;const repeat=await prompt.question('');prompt.close();stdout.write('\n');
                if(password!==repeat)throw new Error('兩次密碼不一致');
            }
            await new Auth(store).addAdmin(username,password);
            if(args.includes('--generate')) {
                const file=path.join(config.dataDir,`local-login-${username}.txt`);
                await fs.writeFile(file,`本機 CMS 登入資料，勿提交至 Git 或公開分享\n網址：${config.origin}/admin/\n帳號：${username}\n密碼：${password}\n登入後可於系統設定變更密碼\n`,{mode:0o600});
                console.log(`管理員已建立，登入資料只保存在：${file}`);
            } else console.log('管理員已建立');
        } else if(command==='backup') {
            const destination=path.resolve(option('--to')||path.join(config.dataDir,'backups',`backup-${Date.now()}`));
            console.log('已備份至：'+await backupStore(store,destination));
        } else if(command==='import') {
            const actor='migration';
            const media=new Media(store);
            const backup=path.join(config.dataDir,'backups',`before-migration-${Date.now()}`);
            await backupStore(store,backup);
            const selected=new Set(['002','003','004','014','021','033']);
            const items=[];
            const files=(await fs.readdir(path.join(config.root,'images'))).filter(name=>/^\d{3}\.jpeg$/.test(name)).sort();
            for(const file of files)items.push({name:file,buffer:await fs.readFile(path.join(config.root,'images',file)),source:`images/${file}`,featured:selected.has(file.slice(0,3))});
            if(args.includes('--legacy-cloud')) {
                const legacy=JSON.parse(await fs.readFile(new URL('./legacy-source.json',import.meta.url),'utf8'));
                const response=await fetch(`${legacy.url}/rest/v1/feedbacks?select=image_url,created_at&order=created_at.desc`,{headers:{apikey:legacy.publishableKey,Authorization:`Bearer ${legacy.publishableKey}`}});
                if(!response.ok)throw new Error(`舊回饋清單讀取失敗 HTTP ${response.status}`);
                const records=await response.json();
                const cloud=[];
                for(const record of records) {
                    const url=new URL(record.image_url);
                    if(url.origin!==legacy.url||!url.pathname.startsWith('/storage/v1/object/public/feedback_images/'))throw new Error('舊回饋含非預期的來源，已停止匯入');
                    const image=await fetch(url,{redirect:'error'});
                    if(!image.ok)throw new Error('舊圖片讀取失敗');
                    const size=Number(image.headers.get('content-length')||0);if(size>config.maxUpload)throw new Error('舊圖片超過上限');
                    const chunks=[];let bytes=0;for await(const chunk of image.body){bytes+=chunk.length;if(bytes>config.maxUpload)throw new Error('舊圖片超過上限');chunks.push(chunk);}
                    cloud.push({name:path.basename(url.pathname),buffer:Buffer.concat(chunks),source:url.href,featured:false});
                }
                items.unshift(...cloud);
            }
            const sourceManifest=[];
            await fs.mkdir(path.join(backup,'legacy-sources'),{recursive:true,mode:0o700});
            for(const [index,item] of items.entries()){
                const file=`legacy-sources/${String(index+1).padStart(4,'0')}.bin`;
                await fs.writeFile(path.join(backup,file),item.buffer,{mode:0o600});
                sourceManifest.push({file,source:item.source,sha256:createHash('sha256').update(item.buffer).digest('hex')});
            }
            await fs.writeFile(path.join(backup,'legacy-sources.json'),JSON.stringify(sourceManifest,null,2),{mode:0o600});
            const backupManifest=JSON.parse(await fs.readFile(path.join(backup,'manifest.json'),'utf8'));
            backupManifest.files.push(...sourceManifest.map(({file,sha256})=>({file,sha256})));
            const sourceList=await fs.readFile(path.join(backup,'legacy-sources.json'));
            backupManifest.files.push({file:'legacy-sources.json',sha256:createHash('sha256').update(sourceList).digest('hex')});
            await fs.writeFile(path.join(backup,'manifest.json'),JSON.stringify(backupManifest,null,2),{mode:0o600});
            const manifest=[];
            for(const [index,item] of items.entries()) {
                const image=await media.add(item.buffer,item.name,actor,item.source);
                let row=store.rows('feedback',true).find(row=>JSON.parse(row.draft_json).mediaId===image.id);
                if(!row) {
                    const data=store.save('feedback',null,{mediaId:image.id,description:`真實諮詢回饋 ${item.name}`,sort:index+1,isVisible:false,isFeatured:item.featured},null,actor);
                    const draft={...data};delete draft.revision;delete draft.changed;delete draft.published;delete draft.updatedAt;
                    draft.legacySource=item.source;
                    store.db.prepare('UPDATE feedback SET draft_json=? WHERE id=?').run(JSON.stringify(draft),data.id);
                    row=store.row('feedback',data.id);
                }
                manifest.push({id:row.id,source:item.source,sourceSha256:image.source_sha256,mediaId:image.id,featured:item.featured});
            }
            const file=path.join(config.dataDir,`migration-${Date.now()}.json`);
            await fs.writeFile(file,JSON.stringify({backup,createdAt:new Date().toISOString(),count:manifest.length,items:manifest},null,2),{mode:0o600});
            console.log(`已盤點 ${manifest.length} 張圖片；保留原圖、排序與精選，未發布。清單：${file}`);
        } else throw new Error('用法：cms:admin / cms:import / cms:backup / cms:restore');
    } finally {store.close();}
}
let unlock=()=>{};
try {if(command==='restore')unlock=acquireLock(config.dataDir);await main();}catch(error){console.error(error.message);process.exitCode=1;}finally{unlock();}
