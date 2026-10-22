import { DatabaseSync, backup } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { kinds, validate, effectiveCohort, fail } from './validation.mjs';

const timestamp = () => new Date().toISOString();
export class Store {
    constructor(config) {
        this.config = config;
        fs.mkdirSync(config.dataDir, { recursive:true, mode:0o700 });
        const realData=fs.realpathSync(config.dataDir),realRoot=fs.realpathSync(config.root);
        if(realData===realRoot||realData.startsWith(realRoot+path.sep))throw new Error('CMS 資料不能透過符號連結放入網站目錄');
        fs.chmodSync(config.dataDir,0o700);
        this.db = new DatabaseSync(path.join(config.dataDir, 'cms.sqlite'));
        fs.chmodSync(path.join(config.dataDir, 'cms.sqlite'), 0o600);
        this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
        this.db.exec(fs.readFileSync(new URL('./migrations/001-initial.sql', import.meta.url), 'utf8'));
        if(!this.db.prepare('SELECT version FROM schema_migrations WHERE version=2').get())this.db.exec(fs.readFileSync(new URL('./migrations/002-remove-feedback-consent.sql',import.meta.url),'utf8'));
    }
    close() { this.db.close(); }
    transaction(fn) {
        this.db.exec('BEGIN IMMEDIATE');
        try { const result = fn(); this.db.exec('COMMIT'); return result; }
        catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    table(kind) { if (!kinds.includes(kind)) fail('找不到資料類型',404); return kind; }
    rows(kind, includeDeleted = false) { return this.db.prepare(`SELECT * FROM ${this.table(kind)} ${includeDeleted ? '' : 'WHERE deleted_at IS NULL'}`).all(); }
    row(kind, id) { return this.db.prepare(`SELECT * FROM ${this.table(kind)} WHERE id=?`).get(id); }
    item(row) { return { ...JSON.parse(row.draft_json), id:row.id, revision:row.revision, updatedAt:row.updated_at, published:Boolean(row.published_json && JSON.parse(row.published_json).isVisible !== false), changed:row.draft_json !== row.published_json }; }
    adminData() {
        const data = {};
        for (const kind of kinds) data[kind] = this.rows(kind).map(row => this.item(row)).sort((a,b) => (a.sort||0)-(b.sort||0));
        for(const item of data.courses)item.totalHours=item.sessions!==null&&item.minutes!==null?item.sessions*item.minutes/60:null;
        for(const item of data.feedback)item.uploadedAt=this.db.prepare('SELECT created_at FROM media WHERE id=?').get(item.mediaId)?.created_at;
        data.pending = kinds.reduce((n,k) => n+this.rows(k,true).filter(r => r.draft_json !== r.published_json).length,0);
        data.recent = this.db.prepare('SELECT id,actor,action,kind,entity_id,created_at FROM audit_log ORDER BY id DESC LIMIT 15').all();
        data.versions = this.db.prepare('SELECT id,actor,created_at,reason FROM versions ORDER BY id DESC LIMIT 30').all();
        const published=this.publicData();
        data.publicSummary={cohorts:published.cohorts,courses:published.courses,feedbackCount:published.feedbackCount,publishedAt:published.publishedAt};
        return data;
    }
    audit(actor, action, kind, id, before, after) {
        this.db.prepare('INSERT INTO audit_log(actor,action,kind,entity_id,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?)')
            .run(actor,action,kind,id,before == null ? null : JSON.stringify(before),after == null ? null : JSON.stringify(after),timestamp());
    }
    save(kind, id, input, revision, actor) {
        const value = validate(kind,input);
        const old = id ? this.row(kind,id) : null;
        if (id && (!old || old.deleted_at)) fail('資料不存在',404);
        if (old && revision !== old.revision) fail('資料已被其他視窗修改，請重新載入後再儲存',409);
        id ||= randomUUID();
        value.id = id;
        if (kind === 'cohorts' && (!this.row('courses',value.courseId) || this.row('courses',value.courseId).deleted_at)) fail('請先建立所屬課程');
        if (kind === 'feedback') {
            if (!this.db.prepare('SELECT id FROM media WHERE id=?').get(value.mediaId)) fail('圖片不存在');
            const previous = old ? JSON.parse(old.draft_json) : {};
            if (previous.legacySource) value.legacySource = previous.legacySource;
        }
        return this.transaction(() => {
            if (kind === 'cohorts' && value.isFeatured) {
                for (const other of this.rows('cohorts')) {
                    const data = JSON.parse(other.draft_json);
                    if (other.id === id || !data.isFeatured) continue;
                    data.isFeatured = false;
                    this.db.prepare('UPDATE cohorts SET draft_json=?,revision=revision+1,updated_at=?,updated_by=? WHERE id=?').run(JSON.stringify(data),timestamp(),actor,other.id);
                    this.audit(actor,'save_draft','cohorts',other.id,JSON.parse(other.draft_json),data);
                }
            }
            if (old) {
                const extra = kind === 'cohorts' ? ',course_id=?' : kind === 'feedback' ? ',media_id=?' : '';
                const args = [JSON.stringify(value),timestamp(),actor];
                if (extra) args.push(value.courseId || value.mediaId);
                args.push(id);
                this.db.prepare(`UPDATE ${kind} SET draft_json=?,revision=revision+1,updated_at=?,updated_by=?${extra} WHERE id=?`).run(...args);
            } else {
                const extra = kind === 'cohorts' ? ',course_id' : kind === 'feedback' ? ',media_id' : '';
                const args = [id,JSON.stringify(value),timestamp(),actor];
                if (extra) args.push(value.courseId || value.mediaId);
                this.db.prepare(`INSERT INTO ${kind}(id,draft_json,updated_at,updated_by${extra}) VALUES(${args.map(()=>'?').join(',')})`).run(...args);
            }
            this.audit(actor,'save_draft',kind,id,old ? JSON.parse(old.draft_json) : null,value);
            return this.item(this.row(kind,id));
        });
    }
    snapshot(draft = false) {
        const result = {};
        for (const kind of kinds) result[kind] = this.rows(kind).flatMap(row => {
            const raw = draft ? row.draft_json : row.published_json;
            return raw ? [JSON.parse(raw)] : [];
        });
        return result;
    }
    assertPublishable(snapshot) {
        if (snapshot.cohorts.filter(c => c.isFeatured && c.isVisible).length > 1) fail('只能設定一個主推班別');
        for (const c of snapshot.cohorts) if (!snapshot.courses.some(course => course.id === c.courseId)) fail('招生期別缺少所屬課程');
    }
    version(actor, reason) {
        const result = this.db.prepare('INSERT INTO versions(snapshot_json,actor,created_at,reason) VALUES(?,?,?,?)').run(JSON.stringify(this.snapshot()),actor,timestamp(),reason);
        return Number(result.lastInsertRowid);
    }
    publish(actor) {
        const snapshot = this.snapshot(true);
        this.assertPublishable(snapshot);
        return this.transaction(() => {
            for (const kind of kinds) for (const row of this.rows(kind,true)) {
                const after = row.deleted_at ? null : row.draft_json;
                if (after === row.published_json) continue;
                this.db.prepare(`UPDATE ${kind} SET published_json=? WHERE id=?`).run(after,row.id);
                this.audit(actor,'publish',kind,row.id,row.published_json ? JSON.parse(row.published_json) : null,after ? JSON.parse(after) : null);
            }
            return this.version(actor,'發布草稿');
        });
    }
    remove(kind, id, actor, revision, deleting = false) {
        const row = this.row(kind,id);
        if (!row || row.deleted_at) fail('資料不存在',404);
        if (row.revision !== revision) fail('資料已更新，請重新載入',409);
        if (kind === 'settings') fail('不能刪除系統設定');
        if (deleting && kind === 'courses' && this.rows('cohorts').some(c => JSON.parse(c.draft_json).courseId === id || (c.published_json && JSON.parse(c.published_json).courseId === id))) fail('此課程仍有招生期別，請改用停用');
        const draft = { ...JSON.parse(row.draft_json), isVisible:false };
        const published = row.published_json ? { ...JSON.parse(row.published_json), isVisible:false } : null;
        return this.transaction(() => {
            this.db.prepare(`UPDATE ${kind} SET draft_json=?,published_json=?,deleted_at=?,revision=revision+1,updated_at=?,updated_by=? WHERE id=?`)
                .run(JSON.stringify(draft),published ? JSON.stringify(published) : null,deleting ? timestamp() : null,timestamp(),actor,id);
            this.audit(actor,deleting ? 'delete' : 'unpublish',kind,id,JSON.parse(row.draft_json),deleting ? null : draft);
            return this.version(actor,deleting ? '刪除項目（保留還原資料）' : '取消發布');
        });
    }
    reorderFeedback(input,actor) {
        const first=this.row('feedback',input.id),second=this.row('feedback',input.otherId);
        if(!first||!second||first.deleted_at||second.deleted_at||first.id===second.id)fail('找不到可交換的圖片');
        if(first.revision!==input.revision||second.revision!==input.otherRevision)fail('圖片排序已更新，請重新載入',409);
        const a=JSON.parse(first.draft_json),b=JSON.parse(second.draft_json);
        return this.transaction(()=>{
            for(const [row,before,sort] of [[first,a,b.sort],[second,b,a.sort]]) {
                const after={...before,sort};
                this.db.prepare('UPDATE feedback SET draft_json=?,revision=revision+1,updated_at=?,updated_by=? WHERE id=?').run(JSON.stringify(after),timestamp(),actor,row.id);
                this.audit(actor,'save_draft','feedback',row.id,before,after);
            }
            return {ok:true};
        });
    }
    restore(versionId, actor) {
        const version = this.db.prepare('SELECT * FROM versions WHERE id=?').get(versionId);
        if (!version) fail('版本不存在',404);
        const snapshot = JSON.parse(version.snapshot_json);
        this.assertPublishable(snapshot);
        for (const f of snapshot.feedback.filter(f => f.isVisible)) {
            const row = this.row('feedback',f.id);
            const current = row && JSON.parse(row.draft_json);
            if (!current || current.mediaId !== f.mediaId) fail('舊版本包含已更換或遮蔽前的圖片，無法直接還原該圖片');
        }
        return this.transaction(() => {
            for (const kind of kinds) for (const row of this.rows(kind,true)) {
                const item = snapshot[kind].find(item => item.id === row.id);
                if (item) {
                    const extra=kind==='cohorts'?',course_id=?':kind==='feedback'?',media_id=?':'';
                    const values=[JSON.stringify(item),JSON.stringify(item),timestamp(),actor];
                    if(extra)values.push(item.courseId||item.mediaId);
                    values.push(row.id);
                    this.db.prepare(`UPDATE ${kind} SET draft_json=?,published_json=?,deleted_at=NULL,revision=revision+1,updated_at=?,updated_by=?${extra} WHERE id=?`).run(...values);
                } else {
                    const draft={...JSON.parse(row.draft_json),isVisible:false};
                    if(kind==='cohorts')draft.isFeatured=false;
                    this.db.prepare(`UPDATE ${kind} SET draft_json=?,published_json=NULL,revision=revision+1,updated_at=?,updated_by=? WHERE id=?`).run(JSON.stringify(draft),timestamp(),actor,row.id);
                }
            }
            this.audit(actor,'restore','versions',String(versionId),null,{ restoredVersion:versionId });
            return this.version(actor,`還原版本 #${versionId}`);
        });
    }
    publicData({ draft = false, now = new Date() } = {}) {
        const snapshot = this.snapshot(draft);
        const settings = snapshot.settings[0] || { featuredDesktop:6,featuredMobile:3,lineUrl:'https://lin.ee/y2XVa6h' };
        const courses = snapshot.courses.filter(c => c.isVisible).sort((a,b)=>a.sort-b.sort).map(c=>({...c,totalHours:c.sessions!==null&&c.minutes!==null?c.sessions*c.minutes/60:null}));
        const cohorts = snapshot.cohorts.filter(c => c.isVisible && courses.some(course => course.id === c.courseId)).map(c => effectiveCohort(c,now)).sort((a,b)=>Number(b.isFeatured)-Number(a.isFeatured)||a.sort-b.sort);
        const feedback = snapshot.feedback.filter(f => f.isVisible).sort((a,b)=>a.sort-b.sort).map(f => {
            const image = this.db.prepare('SELECT width,height FROM media WHERE id=?').get(f.mediaId);
            return { id:f.id,mediaId:f.mediaId,description:f.description,sort:f.sort,isFeatured:f.isFeatured,...image,
                thumbnail:`${draft ? '/api/admin' : ''}/media/${f.mediaId}/thumb`,image:`${draft ? '/api/admin' : ''}/media/${f.mediaId}/full` };
        });
        const latest = this.db.prepare('SELECT id,created_at FROM versions ORDER BY id DESC LIMIT 1').get();
        return { version:latest?.id || 0,publishedAt:latest?.created_at || null,preview:draft,courses,cohorts,
            settings:{featuredDesktop:settings.featuredDesktop,featuredMobile:settings.featuredMobile,lineUrl:settings.lineUrl},
            feedbackCount:feedback.length,featuredFeedback:feedback.filter(f=>f.isFeatured).slice(0,Math.max(settings.featuredDesktop,settings.featuredMobile)),feedback };
    }
    async backup(destination) { fs.mkdirSync(destination,{recursive:true,mode:0o700}); await backup(this.db,path.join(destination,'cms.sqlite')); }
    publicMediaActive(id) {
        return Boolean(this.db.prepare("SELECT 1 FROM feedback WHERE deleted_at IS NULL AND json_extract(published_json,'$.mediaId')=? AND json_extract(published_json,'$.isVisible')=1 LIMIT 1").get(id));
    }
}
