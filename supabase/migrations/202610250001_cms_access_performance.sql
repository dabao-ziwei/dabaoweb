-- Local review only. Deploy this migration together with the Edge update.
begin;
alter table dabao_cms.sessions add column remembered boolean not null default false;
alter function public.dabao_cms_backend(text,jsonb) rename to dabao_cms_backend_legacy;
revoke all on function public.dabao_cms_backend_legacy(text,jsonb) from public,anon,authenticated,service_role;

create function public.dabao_cms_backend(p_operation text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
    member dabao_cms.admins%rowtype;
    session_row dabao_cms.sessions%rowtype;
    attempt dabao_cms.login_attempts%rowtype;
    entry record;
    allowed boolean := true;
    retry_seconds integer := 0;
    email text;
    result jsonb;
begin
    if p_operation='login_prepare' then
        delete from dabao_cms.login_attempts where started_at<=now()-interval '1 minute';
        -- Always acquire the two buckets in stable order; reserve before Auth
        -- so concurrent invalid requests cannot bypass the attempt limit.
        for entry in select * from (values(p_payload->>'account',5),(p_payload->>'ip',30)) b(bucket,limit_count) order by bucket loop
            insert into dabao_cms.login_attempts(bucket) values(entry.bucket)
            on conflict(bucket) do update set attempts=dabao_cms.login_attempts.attempts+1
            returning * into attempt;
            if attempt.attempts>entry.limit_count then
                allowed:=false;
                retry_seconds:=greatest(retry_seconds,ceil(extract(epoch from attempt.started_at+interval '1 minute'-now()))::integer);
            end if;
        end loop;
        if not allowed then return jsonb_build_object('allowed',false,'retrySeconds',greatest(1,retry_seconds)); end if;
        select a.* into member from dabao_cms.admins a where a.login_name=p_payload->>'name' and a.enabled;
        if not found then return jsonb_build_object('allowed',true,'member',null); end if;
        select u.email into email from auth.users u where u.id=member.user_id;
        return jsonb_build_object('allowed',true,'member',jsonb_build_object('userId',member.user_id,'email',email));
    elsif p_operation='login_finish' then
        select * into member from dabao_cms.admins where user_id=(p_payload->>'userId')::uuid and enabled for share;
        if not found then raise exception 'CMS_FORBIDDEN'; end if;
        delete from dabao_cms.sessions where expires_at<=now() or (not remembered and touched_at<=now()-interval '30 minutes');
        insert into dabao_cms.sessions(token_hash,user_id,remembered,expires_at)
        values(p_payload->>'hash',member.user_id,coalesce((p_payload->>'remember')::boolean,false),
            now()+case when (p_payload->>'remember')::boolean then interval '30 days' else interval '8 hours' end);
        delete from dabao_cms.login_attempts where bucket=p_payload->>'account';
        insert into dabao_cms.audit(actor,action,kind,entity_id) values(member.login_name,'login','auth',member.user_id::text);
        return jsonb_build_object('authenticated',true,'username',member.login_name,'record',public.dabao_cms_backend_legacy('read'));
    elsif p_operation in ('session','session_bundle','logout','revoke','commit') then
            select s.* into session_row from dabao_cms.sessions s join dabao_cms.admins a on a.user_id=s.user_id
            where s.token_hash=p_payload->>'hash' and s.expires_at>now()
            and (s.remembered or s.touched_at>now()-interval '30 minutes') and a.enabled for update of s;
            if not found then raise exception 'CMS_UNAUTHORIZED'; end if;
            select * into member from dabao_cms.admins where user_id=session_row.user_id;
            update dabao_cms.sessions set touched_at=now() where token_hash=session_row.token_hash;
        if p_operation='session_bundle' then
            return jsonb_build_object('authenticated',true,'username',member.login_name,'record',public.dabao_cms_backend_legacy('read'));
        end if;
        -- The legacy transaction repeats authorization; touched_at was updated
        -- above only after the remembered/ordinary session passed validation.
        return public.dabao_cms_backend_legacy(p_operation,p_payload);
    end if;
    return public.dabao_cms_backend_legacy(p_operation,p_payload);
end;
$$;
revoke all on function public.dabao_cms_backend(text,jsonb) from public,anon,authenticated;
grant execute on function public.dabao_cms_backend(text,jsonb) to service_role;
commit;
