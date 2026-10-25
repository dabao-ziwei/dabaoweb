import {sha256} from './images.mjs';

// One-time release step, not a visitor request or a publication/consent gate.
// All administrator uploads are authorized for public display.
export async function copyExistingPublicMedia(services){
    const {document}=await services.rpc('read');
    const pending=[...document.media];
    let copied=0,existing=0;
    await Promise.all(Array.from({length:Math.min(4,pending.length)},async()=>{
        while(pending.length){
            const media=pending.shift();
            for(const variant of ['full','thumb']){
                let current;try{current=await services.getObject(media.id,variant);}catch(error){if(error.status!==404)throw error;}
                let bytes;try{bytes=await services.getLegacyDerivative(media.id,variant);}catch(error){if(error.status!==404||!current)throw error;}
                if(current){
                    const expected=bytes?await sha256(bytes):(variant==='full'?media.sha256:null);
                    if(expected&&await sha256(current)!==expected)throw new Error('Existing public image differs; refusing to overwrite: '+media.id+'/'+variant);
                    existing++;
                }else{await services.putObject(media.id,variant,bytes);copied++;}
            }
        }
    }));
    return {images:document.media.length,copied,existing,originalsCopied:0};
}
