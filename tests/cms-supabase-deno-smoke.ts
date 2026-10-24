import * as magick from '../supabase/functions/dabao-cms/vendor/magick.js';
import { imageProcessor } from '../cms/supabase/images.mjs';
import { createCloudHandler } from '../cms/supabase/handler.mjs';

Deno.test('Deno runtime loads prepared WASM and processes an actual image', async () => {
    await magick.initializeImageMagick(await Deno.readFile(new URL('../supabase/functions/dabao-cms/vendor/magick.wasm',import.meta.url)));
    const source = magick.MagickImage.create(new magick.MagickColor('#348b6e'),32,48);
    const bytes = source.write(magick.MagickFormat.Png, (data: Uint8Array) => new Uint8Array(data));
    source.dispose();
    const images = imageProcessor(magick);
    const result = images.transform(bytes);
    if(result.width!==32||result.height!==48||!result.full.length||!result.thumb.length)throw new Error('Image transform failed');
    const handler = createCloudHandler({services:{},images,origins:['https://dabao.life']});
    const response = await handler(new Request('https://local.invalid/functions/v1/dabao-cms/healthz'));
    if(response.status!==200)throw new Error('Handler did not start');
});
