import fs from 'node:fs/promises';
import { sha256 } from './images.mjs';

const entry=new URL(import.meta.resolve('@imagemagick/magick-wasm'));
const packageRoot=new URL('../',entry);
const pkg=JSON.parse(await fs.readFile(new URL('package.json',packageRoot),'utf8'));
if(pkg.version!=='0.0.45')throw new Error('ImageMagick 版本與 Edge function 不一致');
const target=new URL('../../supabase/functions/dabao-cms/vendor/',import.meta.url);
await fs.mkdir(target,{recursive:true});
const sources=[
    ['magick.js',entry],
    ['magick.d.ts',new URL('dist/index.d.ts',packageRoot)],
    ['magick.wasm',new URL(import.meta.resolve('@imagemagick/magick-wasm/magick.wasm'))],
    ['LICENSE',new URL('LICENSE',packageRoot)],
    ['NOTICE',new URL('NOTICE',packageRoot)]
];
const files=[];
for(const [name,source] of sources){
    const bytes=await fs.readFile(source);await fs.writeFile(new URL(name,target),bytes);
    files.push({name,bytes:bytes.length,sha256:await sha256(bytes)});
}
const totalBytes=files.reduce((sum,file)=>sum+file.bytes,0);
if(totalBytes>=19*1024*1024)throw new Error('圖片處理資產接近 Edge 打包限制，停止準備');
const manifest={package:pkg.name,version:pkg.version,files,totalBytes};
await fs.writeFile(new URL('manifest.json',target),JSON.stringify(manifest,null,2));
console.log(JSON.stringify({prepared:true,version:pkg.version,totalBytes,notice:'僅準備本機打包資產，未部署；正式 Docker／Edge bundle 仍須核對'},null,2));
