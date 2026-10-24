-- Review-only until the owner approves production migration. Existing public
-- tables, Auth settings, policies, buckets and monitor data are not changed.
begin;
create schema if not exists dabao_cms;
revoke all on schema dabao_cms from public, anon, authenticated;
alter default privileges in schema dabao_cms revoke all on tables from public, anon, authenticated;
alter default privileges in schema dabao_cms revoke all on functions from public, anon, authenticated;

create table if not exists dabao_cms.admins (
    user_id uuid primary key references auth.users(id),
    login_name text not null unique check (login_name = lower(login_name) and length(login_name) between 1 and 80),
    enabled boolean not null default true
);
create table if not exists dabao_cms.sessions (
    token_hash text primary key check (token_hash ~ '^[a-f0-9]{64}$'),
    user_id uuid not null references dabao_cms.admins(user_id),
    created_at timestamptz not null default now(),
    touched_at timestamptz not null default now(),
    expires_at timestamptz not null default now() + interval '8 hours'
);
create table if not exists dabao_cms.login_attempts (
    bucket text primary key,
    attempts integer not null default 1,
    started_at timestamptz not null default now()
);
create table if not exists dabao_cms.content (
    id integer primary key check (id = 1),
    revision bigint not null default 0,
    document jsonb not null default '{"courses":[],"cohorts":[],"feedback":[],"settings":[],"media":[]}'::jsonb
);
insert into dabao_cms.content(id) values (1) on conflict do nothing;
create table if not exists dabao_cms.versions (
    id bigint generated always as identity primary key,
    snapshot jsonb not null,
    actor text not null,
    reason text not null,
    created_at timestamptz not null default now()
);
create table if not exists dabao_cms.audit (
    id bigint generated always as identity primary key,
    actor text not null,
    action text not null,
    kind text not null,
    entity_id text,
    before_json jsonb,
    after_json jsonb,
    created_at timestamptz not null default now()
);
alter table dabao_cms.admins enable row level security;
alter table dabao_cms.sessions enable row level security;
alter table dabao_cms.login_attempts enable row level security;
alter table dabao_cms.content enable row level security;
alter table dabao_cms.versions enable row level security;
alter table dabao_cms.audit enable row level security;
revoke all on all tables in schema dabao_cms from public, anon, authenticated;
revoke all on all sequences in schema dabao_cms from public, anon, authenticated;

-- Service-only gateway. Browser clients cannot call it with anon/user keys.
-- Session verification is repeated inside the write transaction, not just in JS.
create or replace function public.dabao_cms_backend(p_operation text, p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    member dabao_cms.admins%rowtype;
    session_row dabao_cms.sessions%rowtype;
    content_row dabao_cms.content%rowtype;
    item jsonb;
    result jsonb;
    counter integer;
    version_id bigint;
begin
    if p_operation = 'attempt' then
        delete from dabao_cms.login_attempts where started_at < now() - interval '15 minutes';
        insert into dabao_cms.login_attempts(bucket) values(p_payload->>'bucket')
        on conflict(bucket) do update set attempts = dabao_cms.login_attempts.attempts + 1
        returning attempts into counter;
        return jsonb_build_object('allowed', counter <= (p_payload->>'limit')::integer);
    elsif p_operation = 'lookup' then
        select * into member from dabao_cms.admins where login_name = p_payload->>'name' and enabled;
        return case when found then jsonb_build_object('userId', member.user_id) else 'null'::jsonb end;
    elsif p_operation = 'login' then
        select * into member from dabao_cms.admins where user_id = (p_payload->>'userId')::uuid and enabled;
        if not found then raise exception 'CMS_FORBIDDEN'; end if;
        delete from dabao_cms.sessions where expires_at < now() or touched_at < now() - interval '30 minutes';
        insert into dabao_cms.sessions(token_hash,user_id) values(p_payload->>'hash',member.user_id);
        insert into dabao_cms.audit(actor,action,kind,entity_id) values(member.login_name,'login','auth',member.user_id::text);
        return jsonb_build_object('authenticated',true,'username',member.login_name);
    elsif p_operation in ('session','logout','revoke','commit') then
        select s.* into session_row from dabao_cms.sessions s join dabao_cms.admins a on a.user_id=s.user_id
        where s.token_hash=p_payload->>'hash' and s.expires_at > now()
        and s.touched_at > now() - interval '30 minutes' and a.enabled for update of s;
        if not found then raise exception 'CMS_UNAUTHORIZED'; end if;
        select * into member from dabao_cms.admins where user_id=session_row.user_id;
        if p_operation='logout' then
            delete from dabao_cms.sessions where token_hash=session_row.token_hash;
            return '{"ok":true}'::jsonb;
        elsif p_operation='revoke' then
            delete from dabao_cms.sessions where user_id=session_row.user_id;
            insert into dabao_cms.audit(actor,action,kind,entity_id) values(member.login_name,'password_sessions_revoked','auth',member.user_id::text);
            return '{"ok":true}'::jsonb;
        end if;
        update dabao_cms.sessions set touched_at=now() where token_hash=session_row.token_hash;
        if p_operation='session' then
            return jsonb_build_object('authenticated',true,'username',member.login_name,'userId',member.user_id);
        end if;
    elsif p_operation='read' then
        select * into content_row from dabao_cms.content where id=1;
        return jsonb_build_object('revision',content_row.revision,'document',content_row.document,
            'versions',(select coalesce(jsonb_agg(v),'[]'::jsonb) from (select id,actor,reason,created_at from dabao_cms.versions order by id desc limit 30) v),
            'recent',(select coalesce(jsonb_agg(a),'[]'::jsonb) from (select id,actor,action,kind,entity_id,created_at from dabao_cms.audit order by id desc limit 15) a));
    elsif p_operation='history' then
        return (select coalesce(jsonb_agg(a),'[]'::jsonb) from (select * from dabao_cms.audit order by id desc limit 200) a);
    elsif p_operation='version' then
        return (select snapshot from dabao_cms.versions where id=(p_payload->>'id')::bigint);
    elsif p_operation='import' then
        select * into content_row from dabao_cms.content where id=1 for update;
        if content_row.revision<>0 then raise exception 'CMS_ALREADY_IMPORTED'; end if;
        if jsonb_typeof(p_payload->'document') <> 'object' then raise exception 'CMS_INVALID'; end if;
        update dabao_cms.content set revision=1,document=p_payload->'document' where id=1;
        for item in select * from jsonb_array_elements(coalesce(p_payload->'versions','[]'::jsonb)) loop
            insert into dabao_cms.versions(id,snapshot,actor,reason,created_at) overriding system value
            values((item->>'id')::bigint,item->'snapshot',item->>'actor',item->>'reason',(item->>'created_at')::timestamptz);
        end loop;
        perform pg_catalog.setval('dabao_cms.versions_id_seq', greatest(1,(select coalesce(max(id),0) from dabao_cms.versions)), exists(select 1 from dabao_cms.versions));
        for item in select * from jsonb_array_elements(coalesce(p_payload->'audit','[]'::jsonb)) loop
            insert into dabao_cms.audit(actor,action,kind,entity_id,before_json,after_json,created_at)
            values(item->>'actor',item->>'action',item->>'kind',item->>'entity_id',item->'before_json',item->'after_json',(item->>'created_at')::timestamptz);
        end loop;
        insert into dabao_cms.audit(actor,action,kind) values('migration','import','system');
        if p_payload ? 'snapshot' and not exists(select 1 from dabao_cms.versions) then
            insert into dabao_cms.versions(snapshot,actor,reason) values(p_payload->'snapshot','migration','匯入既有 CMS 公開資料');
        end if;
        return '{"ok":true}'::jsonb;
    else
        raise exception 'CMS_INVALID';
    end if;

    -- Only the 'commit' branch reaches this point.
    select * into content_row from dabao_cms.content where id=1 for update;
    if content_row.revision <> (p_payload->>'revision')::bigint then raise exception 'CMS_CONFLICT'; end if;
    if jsonb_typeof(p_payload->'document') <> 'object' or pg_column_size(p_payload->'document') > 5242880 then raise exception 'CMS_INVALID'; end if;
    update dabao_cms.content set document=p_payload->'document',revision=revision+1 where id=1;
    for item in select * from jsonb_array_elements(coalesce(p_payload->'audit','[]'::jsonb)) loop
        insert into dabao_cms.audit(actor,action,kind,entity_id,before_json,after_json)
        values(member.login_name,item->>'action',item->>'kind',item->>'id',item->'before',item->'after');
    end loop;
    if p_payload ? 'snapshot' then
        insert into dabao_cms.versions(snapshot,actor,reason)
        values(p_payload->'snapshot',member.login_name,p_payload->>'reason') returning id into version_id;
    end if;
    return jsonb_build_object('revision',content_row.revision+1,'version',version_id);
end;
$$;
revoke all on function public.dabao_cms_backend(text,jsonb) from public, anon, authenticated;
grant execute on function public.dabao_cms_backend(text,jsonb) to service_role;

-- No anon/authenticated object policies: originals, drafts and derived files
-- are only served through the Edge handler after publication/session checks.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('dabao-cms-media','dabao-cms-media',false,10485760,array['application/octet-stream','image/webp'])
on conflict(id) do nothing;
do $$ begin
    if (select public from storage.buckets where id='dabao-cms-media') then
        raise exception 'CMS bucket must be private; inspect the existing bucket before proceeding';
    end if;
end $$;
commit;
