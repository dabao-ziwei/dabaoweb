import { fail } from '../validation.mjs';
export async function sha256(bytes) {
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
}
const label = (bytes,start,end) => new TextDecoder().decode(bytes.subarray(start,end));
export function inspectSignature(bytes) {
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    if(bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
    if(bytes.length>=8&&[137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v)){
        for(let offset=8;offset+12<=bytes.length;){
            const length=view.getUint32(offset),type=label(bytes,offset+4,offset+8);
            if(type==='acTL')fail('不支援動畫圖片');
            if(length>bytes.length-offset-12)fail('PNG 圖片損壞');
            offset+=length+12;
        }
        return 'image/png';
    }
    if(bytes.length>=12&&label(bytes,0,4)==='RIFF'&&label(bytes,8,12)==='WEBP'){
        for(let offset=12;offset+8<=bytes.length;){
            const length=view.getUint32(offset+4,true),type=label(bytes,offset,offset+4);
            if(type==='ANIM'||type==='ANMF')fail('不支援動畫圖片');
            if(length>bytes.length-offset-8)fail('WebP 圖片損壞');
            offset+=8+length+(length%2);
        }
        return 'image/webp';
    }
    fail('只接受有效的 JPEG、PNG 或非動畫 WebP 圖片');
}
export function imageProcessor(magick) {
    const {ImageMagick,MagickImageInfo,MagickFormat,Drawables,MagickColor,ResourceLimits}=magick;
    ResourceLimits.memory=96n*1024n*1024n;
    ResourceLimits.disk=0n;ResourceLimits.listLength=4n;ResourceLimits.maxProfileSize=1024n*1024n;
    const encode=(image,width,quality)=>{
        if(image.width>width)image.resize(width,Math.max(1,Math.round(image.height*width/image.width)));
        image.strip();image.quality=quality;
        return image.write(MagickFormat.WebP,data=>new Uint8Array(data));
    };
    function transform(bytes,rectangles) {
        if(bytes.length>10*1024*1024)fail('每張圖片最多 10 MB',413);
        const mime=inspectSignature(bytes);
        try {
            const info=MagickImageInfo.create(bytes);
            if(![MagickFormat.Jpeg,MagickFormat.Png,MagickFormat.WebP].includes(info.format)||!info.width||!info.height||info.width*info.height>24000000)fail('圖片格式不正確或超過 2400 萬像素限制');
            return ImageMagick.read(bytes,image=>{
                image.autoOrient();
                if(rectangles){
                    if(!Array.isArray(rectangles)||!rectangles.length||rectangles.length>30)fail('請先標示需要遮蔽的範圍');
                    const drawing=new Drawables().fillColor(new MagickColor('#111111')).strokeColor(new MagickColor('#111111'));
                    for(const r of rectangles){
                        if(!r||['x','y','width','height'].some(k=>!Number.isFinite(r[k])||r[k]<0||r[k]>1)||r.width<=0||r.height<=0||r.x+r.width>1.00001||r.y+r.height>1.00001)fail('遮蔽範圍不正確');
                        drawing.rectangle(Math.floor(r.x*image.width),Math.floor(r.y*image.height),Math.ceil((r.x+r.width)*image.width),Math.ceil((r.y+r.height)*image.height));
                    }
                    drawing.draw(image);
                }
                const full=encode(image,2000,92),width=image.width,height=image.height;
                const thumb=encode(image,640,82);
                // A redacted derivative's downloadable original is also redacted.
                return {original:rectangles?full:bytes,full,thumb,width,height,mime:rectangles?'image/webp':mime};
            });
        }catch(error){if(error.status)throw error;fail('無法解析圖片，檔案可能損壞、過大或超過處理資源限制');}
    }
    return {transform};
}
