import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { HttpError, fail } from './validation.mjs';
const scrypt = promisify(scryptCallback);
const token = () => randomBytes(32).toString('base64url');
export const hash = value => createHash('sha256').update(value).digest('hex');
export async function passwordHash(password) {
    if (typeof password !== 'string' || password.length < 10 || password.length > 128) fail('密碼須為 10～128 字元');
    const salt = randomBytes(16).toString('hex');
    const derived = await scrypt(password,salt,64,{N:65536,r:8,p:1,maxmem:128*1024*1024});
    return `scrypt:65536:${salt}:${derived.toString('hex')}`;
}
export async function verifyPassword(password, stored) {
    const parts=stored.split(':');
    const [salt,expected]=parts[0]==='scrypt'?parts.slice(2):parts;
    const N=parts[0]==='scrypt'?Number(parts[1]):16384;
    if(![16384,65536].includes(N)||!/^[a-f0-9]{32}$/.test(salt)||!/^[a-f0-9]{128}$/.test(expected))return false;
    const actual = await scrypt(password,salt,64,{N,r:8,p:1,maxmem:128*1024*1024});
    return timingSafeEqual(actual,Buffer.from(expected,'hex'));
}
export const cookies = request => Object.fromEntries((request.headers.cookie||'').split(';').map(s=>s.trim()).filter(Boolean).map(s=>{const p=s.indexOf('=');return[s.slice(0,p),s.slice(p+1)];}));
export function cookie(config, name, value, age) { return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${config.production ? '; Secure' : ''}`; }
export class Auth {
    constructor(store) { this.store=store; this.db=store.db; this.config=store.config; this.inflight=0; }
    origin(request) {
        if (request.headers.origin !== this.config.origin) throw new HttpError(403,'請從管理後台進行操作');
        if (request.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403,'不允許跨網站操作');
    }
    session(request) {
        const raw=cookies(request)[this.config.cookie];
        if (!raw || raw.length>200) return null;
        const row=this.db.prepare('SELECT s.*,a.username,a.disabled FROM sessions s JOIN admins a ON a.id=s.admin_id WHERE token_hash=?').get(hash(raw));
        const now=Date.now();
        if (!row || row.disabled || row.expires_at<now || row.last_seen<now-this.config.idleMinutes*60000) return null;
        this.db.prepare('UPDATE sessions SET last_seen=? WHERE token_hash=?').run(now,row.token_hash);
        return row;
    }
    require(request, mutation = false) {
        const session=this.session(request);
        if (!session) throw new HttpError(401,'請先登入管理後台');
        if (mutation) {
            this.origin(request);
            if (request.headers['x-csrf-token'] !== session.csrf) throw new HttpError(403,'安全驗證已失效，請重新整理');
        }
        return session;
    }
    bootstrap(request,response) {
        const session=this.session(request);
        if (session) return {authenticated:true,username:session.username,csrf:session.csrf};
        const challenge=token(),csrf=token();
        this.db.prepare('DELETE FROM login_challenges WHERE expires_at<?').run(Date.now());
        this.db.prepare('INSERT INTO login_challenges VALUES(?,?,?)').run(hash(challenge),hash(csrf),Date.now()+900000);
        response.setHeader('Set-Cookie',cookie(this.config,'cms_login',challenge,900));
        return {authenticated:false,csrf};
    }
    async login(request,response,input) {
        if(this.inflight>=2)throw new HttpError(429,'登入要求過多，請稍後再試');
        this.inflight++;
        try{return await this.loginChecked(request,response,input);}finally{this.inflight--;}
    }
    async loginChecked(request,response,input) {
        this.origin(request);
        const challenge=cookies(request).cms_login;
        const record=challenge && this.db.prepare('SELECT * FROM login_challenges WHERE token_hash=?').get(hash(challenge));
        if (!record || record.expires_at<Date.now() || record.csrf_hash!==hash(request.headers['x-csrf-token']||'')) throw new HttpError(403,'登入安全驗證已失效，請重新整理');
        const username=typeof input.username==='string'?input.username.trim():'';
        const password=typeof input.password==='string'?input.password:'';
        if (!username || username.length>80 || password.length>128) throw new HttpError(401,'帳號或密碼錯誤');
        const key=hash((request.socket.remoteAddress||'')+':'+username.toLowerCase());
        const ipKey=hash('ip:'+(request.socket.remoteAddress||''));
        const attempt=this.db.prepare('SELECT * FROM login_attempts WHERE key=?').get(key);
        const ipAttempt=this.db.prepare('SELECT * FROM login_attempts WHERE key=?').get(ipKey);
        if ((attempt?.expires_at>Date.now()&&attempt.failures>=5)||(ipAttempt?.expires_at>Date.now()&&ipAttempt.failures>=20)) throw new HttpError(429,'登入失敗次數過多，請於 15 分鐘後再試');
        const admin=this.db.prepare('SELECT * FROM admins WHERE username=? AND disabled=0').get(username);
        const dummy='scrypt:65536:00000000000000000000000000000000:'+ '0'.repeat(128);
        if (!(await verifyPassword(password,admin?.password_hash||dummy)) || !admin) {
            for (const k of [key,ipKey]) this.db.prepare('INSERT INTO login_attempts VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET failures=CASE WHEN expires_at<? THEN 1 ELSE failures+1 END,expires_at=CASE WHEN expires_at<? THEN excluded.expires_at ELSE expires_at END').run(k,Date.now()+900000,Date.now(),Date.now());
            this.store.audit('anonymous','login_failed','auth',null,null,{username});
            throw new HttpError(401,'帳號或密碼錯誤');
        }
        const raw=token(),csrf=token(),now=Date.now();
        if(!admin.password_hash.startsWith('scrypt:65536:'))this.db.prepare('UPDATE admins SET password_hash=? WHERE id=?').run(await passwordHash(password),admin.id);
        this.db.prepare('DELETE FROM sessions WHERE expires_at<?').run(now);
        this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?)').run(hash(raw),admin.id,csrf,now,now+this.config.sessionHours*3600000,now);
        this.db.prepare('DELETE FROM login_challenges WHERE token_hash=?').run(record.token_hash);
        this.db.prepare('DELETE FROM login_attempts WHERE key=?').run(key);
        response.setHeader('Set-Cookie',[cookie(this.config,this.config.cookie,raw,this.config.sessionHours*3600),cookie(this.config,'cms_login','',0)]);
        this.store.audit(username,'login','auth',admin.id,null,null);
        return {authenticated:true,username,csrf};
    }
    logout(request,response) {
        const session=this.require(request,true);
        this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(session.token_hash);
        response.setHeader('Set-Cookie',cookie(this.config,this.config.cookie,'',0));
        this.store.audit(session.username,'logout','auth',session.admin_id,null,null);
    }
    async addAdmin(username,password) {
        if (!/^[a-zA-Z0-9_.@-]{3,80}$/.test(username)) fail('帳號須為 3～80 個英文、數字或 _.@-');
        const id=randomUUID();
        this.db.prepare('INSERT INTO admins(id,username,password_hash,created_at) VALUES(?,?,?,?)').run(id,username,await passwordHash(password),new Date().toISOString());
        this.store.audit('cli','create_admin','auth',id,null,{username});
        return id;
    }
}
