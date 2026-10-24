// Generated from the pinned npm dependency by cms:supabase:prepare; licenses
// accompany the bundled asset. Do not fetch mutable third-party WASM at runtime.
import { createCloudHandler } from '../../../cms/supabase/handler.mjs';
import { imageProcessor, lazyImageProcessor } from '../../../cms/supabase/images.mjs';
import { supabaseServices } from '../../../cms/supabase/services.mjs';

const url = Deno.env.get('SUPABASE_URL');
const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const origins = (Deno.env.get('CMS_ALLOWED_ORIGINS') || '').split(',').map(s => s.trim()).filter(Boolean);
if (!origins.length || origins.some(s => new URL(s).origin !== s || !s.startsWith('https://'))) {
    throw new Error('Explicit HTTPS CMS_ALLOWED_ORIGINS required');
}
const images = lazyImageProcessor(async () => {
    const magick = await import('./vendor/magick.js');
    const wasm = await Deno.readFile(new URL('./vendor/magick.wasm', import.meta.url));
    await magick.initializeImageMagick(wasm);
    return imageProcessor(magick);
});
Deno.serve(createCloudHandler({
    services: supabaseServices({url, key}), images, origins
}));
