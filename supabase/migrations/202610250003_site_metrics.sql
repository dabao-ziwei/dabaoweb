-- Apply only after local review and separate production approval.
begin;
create table dabao_cms.metric_started (
    id boolean primary key default true check(id),
    started_at timestamptz not null default now()
);
create table dabao_cms.metric_daily (
    day date not null,
    page text not null check(page ~ '^[a-z_]{1,40}$'),
    action text not null check(action in ('view','click')),
    target text not null check(target ~ '^[a-z_]{1,40}$'),
    location text not null check(location ~ '^[a-z_]{1,40}$'),
    hits bigint not null default 1 check(hits>0),
    primary key(day,page,action,target,location)
);
alter table dabao_cms.metric_daily enable row level security;
alter table dabao_cms.metric_started enable row level security;
revoke all on dabao_cms.metric_daily,dabao_cms.metric_started from public,anon,authenticated,service_role;

create function public.dabao_cms_metrics(p_operation text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
    today date := timezone('Asia/Taipei',now())::date;
    range_days integer;
    range_start date;
    result jsonb;
begin
    if p_operation='collect' then
        insert into dabao_cms.metric_started(id) values(true) on conflict do nothing;
        insert into dabao_cms.metric_daily(day,page,action,target,location)
        values(today,p_payload->>'page',p_payload->>'action',p_payload->>'target',p_payload->>'location')
        on conflict(day,page,action,target,location) do update set hits=dabao_cms.metric_daily.hits+1;
        return jsonb_build_object('ok',true);
    elsif p_operation='report' then
        -- Reuse the existing CMS session validation, including idle/remembered
        -- expiry and enabled-admin checks; never load the content document.
        perform public.dabao_cms_backend('session',jsonb_build_object('hash',p_payload->>'hash'));
        range_days := (p_payload->>'days')::integer;
        if range_days is null or range_days not in (0,1,7,30) then raise exception 'CMS_METRICS_RANGE'; end if;
        range_start := case when range_days=0 then
            coalesce((select timezone('Asia/Taipei',started_at)::date from dabao_cms.metric_started where id),today)
            else today-(range_days-1) end;
        select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) into result from (
            select page,action,target,location,sum(hits) as hits
            from dabao_cms.metric_daily where day between range_start and today
            group by page,action,target,location order by page,action,target,location
        ) t;
        return jsonb_build_object('enabled',true,'days',range_days,'from',range_start,'to',today,
            'startedAt',(select started_at from dabao_cms.metric_started where id),
            'updatedAt',now(),'rows',result);
    end if;
    raise exception 'CMS_METRICS_OPERATION';
end;
$$;
revoke all on function public.dabao_cms_metrics(text,jsonb) from public,anon,authenticated;
grant execute on function public.dabao_cms_metrics(text,jsonb) to service_role;
commit;
