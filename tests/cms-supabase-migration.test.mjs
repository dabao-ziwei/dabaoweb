import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createCms } from '../cms/server.mjs';
import { configuration } from '../cms/config.mjs';
import { exportPackage, verifyPackage } from '../cms/supabase/migration.mjs';
import { sha256 } from '../cms/supabase/images.mjs';
import { supabaseServices } from '../cms/supabase/services.mjs';

test('read-only SQLite export preserves data, versions and every media variant; excludes credentials',async()=>{
    const parent=await fs.mkdtemp(path.join(os.tmpdir(),'dabao-cloud-export-')),source=path.join(parent,'source'),destination=path.join(parent,'export');
    const app=createCms(configuration({CMS_DATA_DIR:source,CMS_PORT:'4988'}));
    try{
        await app.auth.addAdmin('private-admin','DoNotExportThisPassword123!');
        const image=await app.media.add(await sharp({create:{width:200,height:300,channels:3,background:'#aaddbb'}}).png().toBuffer(),'private-source.png','fixture');
        app.store.save('feedback',null,{mediaId:image.id,description:'migration fixture',sort:1,isVisible:true,isFeatured:true},null,'fixture');app.store.publish('fixture');
        const before=JSON.stringify(app.store.publicData());
        const manifest=await exportPackage(source,destination);
        const {payload}=await verifyPackage(destination);
        assert.equal(manifest.files.length,4);assert.equal(manifest.counts.feedback,1);assert.equal(manifest.counts.versions,2);
        const raw=JSON.stringify(payload);assert(!raw.includes('password_hash'));assert(!raw.includes('DoNotExportThisPassword123!'));assert(!Object.hasOwn(payload.document,'admins'));assert(!Object.hasOwn(payload.document,'sessions'));
        assert.equal(JSON.stringify(app.store.publicData()),before);
        for(const name of ['original.bin','full.webp','thumb.webp'])assert.equal(await sha256(await fs.readFile(path.join(source,'media',image.id,name))),await sha256(await fs.readFile(path.join(destination,'media',image.id,name))));
        await assert.rejects(()=>exportPackage(source,destination),/EEXIST/);
        const stateFile=path.join(destination,'state.json');await fs.appendFile(stateFile,' ');await assert.rejects(()=>verifyPackage(destination),/SHA-256/);
    }finally{app.server.emit('close');app.store.close();await fs.rm(parent,{recursive:true,force:true});}
});

test('Supabase REST adapter: secrets stay server-side, provider errors sanitized, paths explicit',async()=>{
    const calls=[];
    const service=supabaseServices({url:'https://local-test.invalid',key:'server-only-secret',fetcher:async(url,options)=>{
        calls.push({url,options});
        if(url.includes('/token?'))return Response.json({user:{id:'user-id'},access_token:'provider-token',refresh_token:'provider-refresh'});
        if(url.includes('/admin/users/'))return Response.json({email:'admin@example.invalid'});
        if(url.includes('/user'))return Response.json({id:'user-id'});
        if(url.includes('/rest/'))return Response.json({ok:true});
        if(url.includes('/authenticated/'))return new Response(new Uint8Array([1,2,3]));
        return Response.json({ok:true});
    }});
    await service.rpc('read');assert.equal(calls[0].options.headers.apikey,'server-only-secret');
    assert.deepEqual(JSON.parse(calls[0].options.body),{p_operation:'read',p_payload:{}});
    const session=await service.signIn('admin@example.invalid','test-password');assert.equal(session.user.id,'user-id');
    await service.changePassword('admin@example.invalid','test-password','1234567890','user-id',async()=>{calls.push({event:'revoke'});});
    const update=calls.find(c=>c.options?.method==='PUT');assert.equal(update.options.headers.Authorization,'Bearer provider-token');assert(!update.options.body.includes('server-only-secret'));
    assert(calls.findIndex(c=>c.event==='revoke')<calls.findIndex(c=>c.options?.method==='PUT'));
    await service.putObject('media-id','thumb',new Uint8Array([1]));await service.getObject('media-id','full');
    assert(calls.some(c=>c.url?.endsWith('/storage/v1/object/authenticated/dabao-cms-media/media-id/full.webp')));
    const failing=supabaseServices({url:'https://local-test.invalid',key:'secret',fetcher:async()=>Response.json({message:'SQL PRIVATE TABLE SECRET DETAILS'},{status:500})});
    await assert.rejects(()=>failing.rpc('read'),e=>e.status===503&&!e.message.includes('PRIVATE'));
    const conflict=supabaseServices({url:'https://local-test.invalid',key:'secret',fetcher:async()=>Response.json({message:'CMS_CONFLICT'},{status:400})});
    await assert.rejects(()=>conflict.rpc('commit'),e=>e.status===409);
});
