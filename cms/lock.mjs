import fs from 'node:fs';
import path from 'node:path';

export function acquireLock(dataDir) {
    fs.mkdirSync(dataDir,{recursive:true,mode:0o700});
    const file=path.join(dataDir,'server.lock');
    for(let attempt=0;attempt<2;attempt++) {
        try {
            const fd=fs.openSync(file,'wx',0o600);
            fs.writeFileSync(fd,String(process.pid));fs.closeSync(fd);
            return ()=>{if(fs.existsSync(file)&&fs.readFileSync(file,'utf8')===String(process.pid))fs.unlinkSync(file);};
        } catch(error) {
            if(error.code!=='EEXIST')throw error;
            const pid=Number(fs.readFileSync(file,'utf8'));
            let alive=true;
            try {if(!Number.isInteger(pid)||pid<1)alive=false;else process.kill(pid,0);}catch(error){if(error.code==='ESRCH')alive=false;}
            if(alive)throw new Error('這個資料目錄正在使用中，請先停止 CMS 服務再還原或重新啟動');
            fs.unlinkSync(file);
        }
    }
    throw new Error('無法取得資料目錄鎖');
}
