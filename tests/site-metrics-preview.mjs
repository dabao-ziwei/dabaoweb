import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomBytes} from 'node:crypto';
import {previewServer} from './cms-supabase-preview.mjs';

const password=randomBytes(8).toString('base64url').slice(0,10);
const app=await previewServer({port:4290,apiPort:4291,password,metricsEnabled:true});
const privateDir=path.join(os.homedir(),'Library','Application Support','DabaoCMS-Supabase-Local-Review');
await fs.mkdir(privateDir,{recursive:true,mode:0o700});
const credentials=path.join(privateDir,'site-metrics-preview.txt');
await fs.writeFile(credentials,`僅本機統計驗收，不是正式站帳密\nURL: ${app.origin}/admin/\n帳號: admin\n密碼: ${password}\n本機計數來自此預覽的實際操作；重啟即清除，不寫入正式 Supabase\n`,{mode:0o600});
console.log(`本機統計預覽 ${app.origin}/admin/\n登入資料 ${credentials}`);
const stop=async()=>{await app.close();process.exit(0);};
process.once('SIGINT',stop);process.once('SIGTERM',stop);
