import {supabaseServices} from './services.mjs';
import {copyExistingPublicMedia} from './public-media.mjs';
const url=process.env.CMS_SUPABASE_URL,key=process.env.CMS_SUPABASE_SERVICE_ROLE_KEY;
if(!url||!key||process.argv[2]!==`--confirm-project=${new URL(url).hostname.split('.')[0]}`)throw new Error('需明確核准專案、私有環境變數與 --confirm-project=專案ID');
console.log(JSON.stringify(await copyExistingPublicMedia(supabaseServices({url,key}))));
