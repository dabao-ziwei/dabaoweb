-- Owner-approved public derivatives; no change to the original backup bucket.
begin;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('dabao-cms-public','dabao-cms-public',true,10485760,array['image/webp'])
on conflict(id) do nothing;
do $$ begin
    if not (select public from storage.buckets where id='dabao-cms-public') then
        raise exception 'Inspect existing dabao-cms-public bucket: expected public derivatives';
    end if;
    if (select public from storage.buckets where id='dabao-cms-media') then
        raise exception 'Original backup bucket must remain private';
    end if;
end $$;
-- Public downloads need no object policy. No anon/authenticated write policy
-- is added; uploads and edits still go through the authenticated admin API.
commit;
