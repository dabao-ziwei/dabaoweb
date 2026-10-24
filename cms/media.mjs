import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fail } from './validation.mjs';
const digest = value => createHash('sha256').update(value).digest('hex');
const imageOptions = { limitInputPixels:24000000, animated:false, failOn:'warning' };
export class Media {
    constructor(store) { this.store=store; this.directory=path.join(store.config.dataDir,'media'); }
    file(id, variant='full') {
        if (!/^[a-z0-9-]{1,100}$/.test(id) || !['original','full','thumb'].includes(variant)) fail('找不到圖片',404);
        return path.join(this.directory,id,variant==='original'?'original.bin':`${variant}.webp`);
    }
    async add(buffer,name,actor,sourceUrl=null) {
        if (buffer.length>this.store.config.maxUpload) fail('每張圖片最多 10 MB',413);
        const jpeg=buffer.subarray(0,3).equals(Buffer.from([0xff,0xd8,0xff]));
        const png=buffer.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
        const webp=buffer.subarray(0,4).toString()==='RIFF'&&buffer.subarray(8,12).toString()==='WEBP';
        if(!jpeg&&!png&&!webp)fail('只接受有效的 JPEG、PNG 或非動畫 WebP 圖片');
        let metadata,full,thumb;
        try {
            const image=sharp(buffer,imageOptions);
            metadata=await image.metadata();
            if (!['jpeg','png','webp'].includes(metadata.format)||metadata.pages>1||!metadata.width||!metadata.height) fail('只接受有效的 JPEG、PNG 或非動畫 WebP 圖片');
            full=await image.clone().rotate().resize({width:2000,withoutEnlargement:true}).webp({quality:92}).toBuffer();
            thumb=await sharp(full,imageOptions).resize({width:640,withoutEnlargement:true}).webp({quality:82}).toBuffer();
        } catch (error) { if(error.status) throw error; fail('無法解析圖片內容，檔案可能損壞或超過像素限制'); }
        const sha=digest(full);
        const existing=this.store.db.prepare('SELECT * FROM media WHERE sha256=?').get(sha);
        if (existing) return {...existing,duplicate:true};
        const id=randomUUID();
        await fs.mkdir(path.dirname(this.file(id)),{recursive:true,mode:0o700});
        try {
            await fs.writeFile(this.file(id,'original'),buffer,{mode:0o600});
            await fs.writeFile(this.file(id,'full'),full,{mode:0o600});
            await fs.writeFile(this.file(id,'thumb'),thumb,{mode:0o600});
            const dimensions=await sharp(full).metadata();
            this.store.db.prepare('INSERT INTO media(id,sha256,source_sha256,width,height,original_mime,bytes,original_name,source_url,created_at,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
                .run(id,sha,digest(buffer),dimensions.width,dimensions.height,`image/${metadata.format}`,buffer.length,path.basename(name).replace(/[\x00-\x1f]/g,'').slice(0,200),sourceUrl,new Date().toISOString(),actor);
            this.store.audit(actor,'upload','media',id,null,{sha256:sha,name:path.basename(name)});
            return this.store.db.prepare('SELECT * FROM media WHERE id=?').get(id);
        } catch(error) {
            await fs.rm(path.dirname(this.file(id)),{recursive:true,force:true});
            const duplicate=this.store.db.prepare('SELECT * FROM media WHERE sha256=?').get(sha);
            if(duplicate)return {...duplicate,duplicate:true};
            throw error;
        }
    }
    async redact(id,rectangles,actor) {
        const row=this.store.db.prepare('SELECT * FROM media WHERE id=?').get(id);
        if(!row) fail('圖片不存在',404);
        if(!Array.isArray(rectangles)||!rectangles.length||rectangles.length>30) fail('請先標示需要遮蔽的範圍');
        const rectanglesSvg=rectangles.map(rect=>{
            if(!rect||['x','y','width','height'].some(k=>typeof rect[k]!=='number'||!Number.isFinite(rect[k])||rect[k]<0||rect[k]>1)||rect.width<=0||rect.height<=0||rect.x+rect.width>1.00001||rect.y+rect.height>1.00001) fail('遮蔽範圍不正確');
            return `<rect x="${Math.floor(rect.x*row.width)}" y="${Math.floor(rect.y*row.height)}" width="${Math.ceil(rect.width*row.width)}" height="${Math.ceil(rect.height*row.height)}" fill="#111111"/>`;
        }).join('');
        const overlay=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${row.width}" height="${row.height}">${rectanglesSvg}</svg>`);
        const buffer=await sharp(this.file(id)).composite([{input:overlay}]).png().toBuffer();
        const result=await this.add(buffer,'redacted.png',actor);
        this.store.audit(actor,'redact','media',result.id,{mediaId:id},{mediaId:result.id,rectangles});
        return result;
    }
}
