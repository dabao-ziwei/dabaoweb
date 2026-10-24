import { kinds, validate, effectiveCohort, fail } from '../validation.mjs';

export const emptyDocument = () => ({ courses:[], cohorts:[], feedback:[], settings:[], media:[] });
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
export class CloudModel {
    constructor(record, actor='') {
        this.document=structuredClone(record.document);
        this.revision=record.revision;
        this.versions=record.versions||[];
        this.recent=record.recent||[];
        this.actor=actor;
        this.audit=[];
    }
    rows(kind, deleted=false) {
        if(!kinds.includes(kind)) fail('找不到資料類型',404);
        return this.document[kind].filter(row=>deleted||!row.deleted_at);
    }
    row(kind,id) { return this.rows(kind,true).find(row=>row.id===id); }
    item(row) { return {...row.draft,id:row.id,revision:row.revision,updatedAt:row.updated_at,published:Boolean(row.published&&row.published.isVisible!==false),changed:!same(row.draft,row.published)}; }
    log(action,kind,id,before,after) { this.audit.push({action,kind,id,before:structuredClone(before??null),after:structuredClone(after??null)}); }
    update(row,draft) { row.draft=draft;row.revision++;row.updated_at=new Date().toISOString();row.updated_by=this.actor; }
    save(kind,id,input,revision) {
        const value=validate(kind,input),old=id?this.row(kind,id):null;
        if(id&&(!old||old.deleted_at))fail('資料不存在',404);
        if(old&&old.revision!==revision)fail('資料已被其他視窗修改，請重新載入後再儲存',409);
        id ||= crypto.randomUUID();value.id=id;
        if(kind==='cohorts'&&(!this.row('courses',value.courseId)||this.row('courses',value.courseId).deleted_at))fail('請先建立所屬課程');
        if(kind==='feedback'&&!this.document.media.some(m=>m.id===value.mediaId))fail('圖片不存在');
        if(kind==='feedback'&&old?.draft.legacySource)value.legacySource=old.draft.legacySource;
        if(kind==='cohorts'&&value.isFeatured)for(const row of this.rows(kind)){
            if(row.id!==id&&row.draft.isFeatured){const before=row.draft;this.update(row,{...before,isFeatured:false});this.log('save_draft',kind,row.id,before,row.draft);}
        }
        const before=old?.draft;
        const row=old||{id,revision:0,published:null,deleted_at:null};
        this.update(row,value);if(!old)this.document[kind].push(row);
        this.log('save_draft',kind,id,before,value);return this.item(row);
    }
    snapshot(draft=false) { return Object.fromEntries(kinds.map(kind=>[kind,this.rows(kind).map(r=>draft?r.draft:r.published).filter(Boolean)])); }
    assertPublishable(snapshot) {
        if(snapshot.cohorts.filter(c=>c.isFeatured&&c.isVisible).length>1)fail('只能設定一個主推班別');
        for(const c of snapshot.cohorts)if(!snapshot.courses.some(course=>course.id===c.courseId))fail('招生期別缺少所屬課程');
        for(const f of snapshot.feedback)if(!this.document.media.some(m=>m.id===f.mediaId))fail('回饋圖片不存在');
    }
    publish() {
        this.assertPublishable(this.snapshot(true));
        for(const kind of kinds)for(const row of this.rows(kind,true)){
            const after=row.deleted_at?null:row.draft;
            if(!same(row.published,after)){this.log('publish',kind,row.id,row.published,after);row.published=structuredClone(after);}
        }
        this.versionSnapshot=this.snapshot();this.reason='發布草稿';
    }
    remove(kind,id,revision,deleting=false) {
        const row=this.row(kind,id);
        if(!row||row.deleted_at)fail('資料不存在',404);
        if(row.revision!==revision)fail('資料已更新，請重新載入',409);
        if(kind==='settings')fail('不能刪除系統設定');
        if(deleting&&kind==='courses'&&this.rows('cohorts').some(c=>c.draft.courseId===id||c.published?.courseId===id))fail('此課程仍有招生期別，請改用停用');
        const before=row.draft;
        this.update(row,{...row.draft,isVisible:false});
        if(row.published)row.published={...row.published,isVisible:false};
        if(deleting)row.deleted_at=new Date().toISOString();
        this.log(deleting?'delete':'unpublish',kind,id,before,deleting?null:row.draft);
        this.versionSnapshot=this.snapshot();this.reason=deleting?'刪除項目（保留還原資料）':'取消發布';
    }
    reorder(input) {
        const a=this.row('feedback',input.id),b=this.row('feedback',input.otherId);
        if(!a||!b||a.deleted_at||b.deleted_at||a.id===b.id)fail('找不到可交換的圖片');
        if(a.revision!==input.revision||b.revision!==input.otherRevision)fail('圖片排序已更新，請重新載入',409);
        const sort=a.draft.sort;
        for(const [row,value] of [[a,b.draft.sort],[b,sort]]){const before=row.draft;this.update(row,{...before,sort:value});this.log('save_draft','feedback',row.id,before,row.draft);}
        return {ok:true};
    }
    restore(snapshot,id) {
        if(!snapshot)fail('版本不存在',404);
        this.assertPublishable(snapshot);
        for(const f of snapshot.feedback.filter(f=>f.isVisible))if(this.row('feedback',f.id)?.draft.mediaId!==f.mediaId)fail('舊版本包含已更換或遮蔽前的圖片，無法直接還原該圖片');
        for(const kind of kinds)for(const row of this.rows(kind,true)){
            const item=snapshot[kind].find(item=>item.id===row.id);
            const value=item||{...row.draft,isVisible:false,...(kind==='cohorts'?{isFeatured:false}:{})};
            this.update(row,structuredClone(value));row.published=item?structuredClone(item):null;
            if(item)row.deleted_at=null;
        }
        this.log('restore','versions',String(id),null,{restoredVersion:id});
        this.versionSnapshot=this.snapshot();this.reason=`還原版本 #${id}`;
    }
    addMedia(media) {
        const existing=this.document.media.find(m=>m.sha256===media.sha256);
        if(existing)return {...existing,duplicate:true};
        this.document.media.push(media);this.log('upload','media',media.id,null,{sha256:media.sha256,name:media.original_name});return media;
    }
    mediaActive(id) { return this.rows('feedback').some(row=>row.published?.mediaId===id&&row.published.isVisible); }
    publicData({draft=false,now=new Date()}={}) {
        const snapshot=this.snapshot(draft);
        if(!snapshot.settings.length)fail('CMS 資料尚未完成匯入',503);
        const settings=snapshot.settings[0];
        const courses=snapshot.courses.filter(c=>c.isVisible).sort((a,b)=>a.sort-b.sort).map(c=>({...c,totalHours:c.sessions!==null&&c.minutes!==null?c.sessions*c.minutes/60:null}));
        const cohorts=snapshot.cohorts.filter(c=>c.isVisible&&courses.some(course=>course.id===c.courseId)).map(c=>effectiveCohort(c,now)).sort((a,b)=>Number(b.isFeatured)-Number(a.isFeatured)||a.sort-b.sort);
        const feedback=snapshot.feedback.filter(f=>f.isVisible).sort((a,b)=>a.sort-b.sort).map(f=>{
            const media=this.document.media.find(m=>m.id===f.mediaId);
            const prefix=draft?'/api/admin':'';
            return {id:f.id,mediaId:f.mediaId,description:f.description,sort:f.sort,isFeatured:f.isFeatured,width:media.width,height:media.height,thumbnail:`${prefix}/media/${f.mediaId}/thumb`,image:`${prefix}/media/${f.mediaId}/full`};
        });
        const latest=this.versions[0];
        return {version:latest?.id||0,publishedAt:latest?.created_at||null,preview:draft,courses,cohorts,settings:{featuredDesktop:settings.featuredDesktop,featuredMobile:settings.featuredMobile,lineUrl:settings.lineUrl},feedbackCount:feedback.length,featuredFeedback:feedback.filter(f=>f.isFeatured).slice(0,Math.max(settings.featuredDesktop,settings.featuredMobile)),feedback};
    }
    adminData() {
        const data=Object.fromEntries(kinds.map(kind=>[kind,this.rows(kind).map(row=>this.item(row)).sort((a,b)=>(a.sort||0)-(b.sort||0))]));
        for(const c of data.courses)c.totalHours=c.sessions!==null&&c.minutes!==null?c.sessions*c.minutes/60:null;
        for(const f of data.feedback)f.uploadedAt=this.document.media.find(m=>m.id===f.mediaId)?.created_at;
        const publicData=this.publicData();
        return {...data,pending:kinds.reduce((n,k)=>n+this.rows(k,true).filter(r=>r.deleted_at?r.published!==null:!same(r.draft,r.published)).length,0),recent:this.recent,versions:this.versions,publicSummary:{cohorts:publicData.cohorts,courses:publicData.courses,feedbackCount:publicData.feedbackCount,publishedAt:publicData.publishedAt}};
    }
    commit(hash) { return {hash,revision:this.revision,document:this.document,audit:this.audit,...(this.versionSnapshot?{snapshot:this.versionSnapshot,reason:this.reason}:{})}; }
}
