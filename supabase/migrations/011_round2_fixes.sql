-- Round-2 review fixes (28 Sep 2026) + owner decision: two devices per consultant are open
-- without a pairing code; a third device needs the manager ("Allow new phone", valid 24 h).

-- ---------------------------------------------------------------- remove pairing codes
drop function if exists public.create_pairing_code(uuid, text);
drop table if exists private.pairing_codes;

-- ---------------------------------------------------------------- failure counter per device
alter table private.code_failures add column if not exists key text;
create index if not exists code_failures_key_idx on private.code_failures(key, at);

-- ---------------------------------------------------------------- "Allow new phone" expires after 24 h
alter table public.consultants add column if not exists allow_new_device_at timestamptz;

create or replace function private.stamp_allow_new_device() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.allow_new_device and not coalesce(old.allow_new_device, false) then
    new.allow_new_device_at := now();
  elsif not new.allow_new_device then
    new.allow_new_device_at := null;
  end if;
  return new;
end $$;
drop trigger if exists consultants_allow_stamp on public.consultants;
create trigger consultants_allow_stamp before update of allow_new_device on public.consultants
for each row execute function private.stamp_allow_new_device();

-- ---------------------------------------------------------------- HTML checks: tags only
create or replace function private.html_ok(p text) returns boolean
language sql immutable set search_path = '' as $$
  select p !~* '<(?!/?(p|br|h1|h2|h3|strong|b|em|i|u|span|ol|ul|li)[\s>/])'
     and p !~* '<[^>]*[\s/"''](on[a-z]+|src|href|srcset|formaction|action|xlink:href|background|poster)\s*='
     and p !~* '<[^>]*(javascript|vbscript|data)\s*:'
     and p !~* '<[^>]*style\s*=[^>]*(url\s*\(|expression|@import|behavior)';
$$;

-- ---------------------------------------------------------------- registration
create or replace function public.register_consultant(
  p_full_name text, p_mobile text, p_team_code text default null,
  p_device_id text default null, p_pair_code text default null)   -- p_pair_code: kept for old clients, unused
returns json
language plpgsql security definer set search_path = '' as $$
declare
  s        public.app_settings;
  m        text;
  c        public.consultants;
  dev      text;
  tok      text;
  code     text;
  is_new   boolean := false;
begin
  -- GET requests run read-only: refuse them, or wrong codes could be tried without being counted.
  if current_setting('transaction_read_only')::boolean then raise exception 'post_required'; end if;

  if length(coalesce(p_device_id, '')) < 16 then raise exception 'device_required'; end if;
  dev := private.hash_token(p_device_id);
  m := public.normalize_mobile(p_mobile);
  if m is null then raise exception 'invalid_mobile'; end if;
  if length(btrim(coalesce(p_full_name, ''))) < 2 then raise exception 'invalid_name'; end if;

  select * into c from public.consultants where mobile = m for update;

  -- Returning on a device already linked to this number: always allowed, never throttled.
  if found and exists (select 1 from public.consultant_devices d
                        where d.consultant_id = c.id and d.device_hash = dev) then
    delete from public.consultant_devices where consultant_id = c.id and device_hash = dev;  -- one token per device
    tok := private.new_token();
    insert into public.consultant_devices (consultant_id, token_hash, device_hash)
    values (c.id, private.hash_token(tok), dev);
    return json_build_object('consultant_id', c.id, 'full_name', c.full_name, 'mobile', c.mobile,
                             'device_token', tok, 'is_new', false);
  end if;

  -- Wrong-code throttling: per device, plus a global backstop.
  if (select count(*) from private.code_failures where key = dev and at > now() - interval '10 minutes') >= 10
     or (select count(*) from private.code_failures where at > now() - interval '10 minutes') >= 300 then
    return json_build_object('error', 'rate_limited');
  end if;

  select * into s from public.app_settings where id = 1;
  if s.access_mode <> 'none' then
    code := translate(btrim(coalesce(p_team_code, '')), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789');
    if s.team_code is null or code <> s.team_code then
      insert into private.code_failures (key) values (dev);
      return json_build_object('error', 'invalid_team_code');
    end if;
  end if;

  -- A device belongs to one consultant.
  if exists (select 1 from public.consultant_devices d
              where d.device_hash = dev and d.consultant_id is distinct from c.id) then
    raise exception 'device_bound_other';
  end if;

  if c.id is null then
    if (select count(*) from public.consultants where created_at > now() - interval '1 day') >= 30 then
      raise exception 'rate_limited';
    end if;
    if pg_database_size(current_database()) > 420 * 1024 * 1024 then raise exception 'storage_full'; end if;
    insert into public.consultants (full_name, mobile)
    values (left(btrim(p_full_name), 100), m)
    on conflict (mobile) do nothing
    returning * into c;
    is_new := found;
    if not is_new then
      select * into c from public.consultants where mobile = m for update;  -- registered a moment ago
    end if;
  end if;

  if not is_new then
    -- A new device for an existing number: open up to 2 devices; more only if the manager
    -- allowed a new phone in the last 24 hours.
    if c.allow_new_device and c.allow_new_device_at > now() - interval '24 hours' then
      update public.consultants set allow_new_device = false where id = c.id;
    elsif private.device_count(c.id) >= 2 then
      raise exception 'device_limit';
    end if;
  end if;

  tok := private.new_token();
  insert into public.consultant_devices (consultant_id, token_hash, device_hash)
  values (c.id, private.hash_token(tok), dev);

  return json_build_object('consultant_id', c.id, 'full_name', c.full_name, 'mobile', c.mobile,
                           'device_token', tok, 'is_new', is_new);
end $$;

-- Name only; the phone gets back the current name and mobile (the manager may have changed it).
create or replace function public.update_my_details(p_consultant_id uuid, p_device_token text, p_full_name text, p_mobile text)
returns json
language plpgsql security definer set search_path = '' as $$
declare c public.consultants;
begin
  if not private.check_device(p_consultant_id, p_device_token) then
    raise exception 'device_not_recognized';
  end if;
  if length(btrim(coalesce(p_full_name, ''))) < 2 then raise exception 'invalid_name'; end if;
  update public.consultants set full_name = left(btrim(p_full_name), 100)
   where id = p_consultant_id
  returning * into c;
  return json_build_object('consultant_id', c.id, 'full_name', c.full_name, 'mobile', c.mobile);
end $$;

-- Links a legacy token to this device, and tells the phone the current name/mobile.
drop function if exists public.bind_device(uuid, text, text);
create function public.bind_device(p_consultant_id uuid, p_device_token text, p_device_id text)
returns json
language plpgsql security definer set search_path = '' as $$
declare
  dev text;
  c   public.consultants;
begin
  if length(coalesce(p_device_id, '')) < 16 then raise exception 'device_required'; end if;
  dev := private.hash_token(p_device_id);
  if exists (select 1 from public.consultant_devices
              where device_hash = dev and consultant_id <> p_consultant_id) then
    raise exception 'device_bound_other';
  end if;
  update public.consultant_devices set device_hash = dev
   where consultant_id = p_consultant_id and token_hash = private.hash_token(p_device_token)
     and device_hash is null;
  if not exists (select 1 from public.consultant_devices
                  where consultant_id = p_consultant_id and token_hash = private.hash_token(p_device_token)) then
    return json_build_object('status', 'unknown');
  end if;
  select * into c from public.consultants where id = p_consultant_id;
  return json_build_object('status', 'ok', 'full_name', c.full_name, 'mobile', c.mobile);
end $$;
revoke execute on function public.bind_device(uuid, text, text) from public;
grant execute on function public.bind_device(uuid, text, text) to anon, authenticated;

-- ---------------------------------------------------------------- submission limits
create or replace function public.submit_report(
  p_report_id          uuid,
  p_consultant_id      uuid,
  p_device_token       text,
  p_project_type       text,
  p_project_id         uuid,
  p_project_other_name text,
  p_body_html          text,
  p_body_text          text,
  p_photos_expected    integer)
returns json
language plpgsql security definer set search_path = '' as $$
declare
  s          public.app_settings;
  c          public.consultants;
  r          public.reports;
  today_from timestamptz;
  n_today    int;
  existed    boolean := false;
begin
  select * into s from public.app_settings where id = 1;
  select * into c from public.consultants where id = p_consultant_id;
  if not found then raise exception 'unknown_consultant'; end if;
  if not private.check_device(p_consultant_id, p_device_token) then
    raise exception 'device_not_recognized';
  end if;

  select * into r from public.reports where id = p_report_id;
  if found then
    if r.consultant_id <> p_consultant_id then raise exception 'report_conflict'; end if;
    existed := true;
  else
    if p_project_type is null or p_project_type not in ('UGC', 'S/S', 'OHTL') then
      raise exception 'invalid_project_type';
    end if;
    if p_project_id is not null then
      if not exists (select 1 from public.projects
                      where id = p_project_id and is_active and type = p_project_type) then
        raise exception 'invalid_project';
      end if;
      p_project_other_name := null;
    elsif length(btrim(coalesce(p_project_other_name, ''))) = 0 then
      raise exception 'invalid_project';
    end if;
    if length(coalesce(p_body_html, '')) = 0 or length(private.html_to_text(p_body_html)) = 0 then
      raise exception 'empty_report';
    end if;
    if octet_length(p_body_html) > 30000 then raise exception 'too_long'; end if;
    if not private.html_ok(p_body_html) then raise exception 'bad_html'; end if;
    if coalesce(p_photos_expected, 0) not between 0 and 20 then
      raise exception 'too_many_photos';
    end if;

    today_from := (date_trunc('day', now() at time zone 'Asia/Riyadh')) at time zone 'Asia/Riyadh';
    select count(*) into n_today from public.reports
     where consultant_id = p_consultant_id and submitted_at >= today_from;
    if n_today >= s.max_reports_per_day then raise exception 'daily_limit'; end if;
    if (select count(*) from public.reports where submitted_at > now() - interval '1 hour') >= 200 then
      raise exception 'rate_limited';
    end if;
    if pg_database_size(current_database()) > 420 * 1024 * 1024 then raise exception 'storage_full'; end if;

    insert into public.reports (
      id, consultant_id, consultant_name_snapshot, consultant_mobile_snapshot,
      project_type, project_id, project_other_name, body_html, body_text, photos_expected)
    values (
      p_report_id, c.id, c.full_name, c.mobile,
      p_project_type, p_project_id, nullif(left(btrim(p_project_other_name), 150), ''),
      p_body_html, left(private.html_to_text(p_body_html), 30000), coalesce(p_photos_expected, 0))
    on conflict (id) do nothing
    returning * into r;
    if not found then
      select * into r from public.reports where id = p_report_id;
      if r.consultant_id <> p_consultant_id then raise exception 'report_conflict'; end if;
      existed := true;
    end if;
  end if;

  return json_build_object('report_id', r.id, 'submitted_at', r.submitted_at,
                           'folder', private.report_folder(r.id, r.submitted_at),
                           'photos_expected', r.photos_expected, 'existed', existed);
end $$;

-- ---------------------------------------------------------------- staff: consultant deletion
create or replace function public.consultant_object_names(p_consultant_id uuid)
returns table (name text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_staff() then raise exception 'forbidden'; end if;
  return query
    select o.name
      from public.reports r
      join storage.objects o
        on o.bucket_id = 'report-photos'
       and o.name like private.report_folder(r.id, r.submitted_at) || '/%'
     where r.consultant_id = p_consultant_id
     order by o.name;
end $$;

create or replace function public.delete_consultant(p_consultant_id uuid)
returns json
language plpgsql security definer set search_path = '' as $$
declare n_reports int;
begin
  if not public.is_staff() then raise exception 'forbidden'; end if;
  if exists (select 1 from public.reports
              where consultant_id = p_consultant_id
                and submitted_at >= (date_trunc('day', now() at time zone 'Asia/Riyadh') at time zone 'Asia/Riyadh')) then
    raise exception 'has_reports_today';
  end if;
  delete from public.reports where consultant_id = p_consultant_id;
  get diagnostics n_reports = row_count;
  delete from public.consultants where id = p_consultant_id;
  if not found then raise exception 'unknown_consultant'; end if;
  return json_build_object('reports_deleted', n_reports);
end $$;

-- ---------------------------------------------------------------- audit trail (admin only)
create table if not exists private.audit (
  at     timestamptz not null default now(),
  actor  uuid default auth.uid(),
  action text not null,
  detail text
);
create index if not exists audit_at_idx on private.audit(at desc);

create or replace function private.audit_reports() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into private.audit (action, detail)
  select 'delete_reports',
         count(*) || ' report(s): ' || string_agg(distinct consultant_name_snapshot, ', ')
           || ' · ' || to_char(min(submitted_at) at time zone 'Asia/Riyadh', 'YYYY-MM-DD')
           || ' → ' || to_char(max(submitted_at) at time zone 'Asia/Riyadh', 'YYYY-MM-DD')
    from old_rows
  having count(*) > 0;
  return null;
end $$;
drop trigger if exists reports_audit on public.reports;
create trigger reports_audit after delete on public.reports
referencing old table as old_rows for each statement execute function private.audit_reports();

create or replace function private.audit_row() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into private.audit (action, detail)
  values ('delete_' || tg_table_name,
          case tg_table_name
            when 'consultants' then old.full_name || ' (' || old.mobile || ')'
            when 'projects' then old.name || ' (' || old.type || ')'
          end);
  return null;
end $$;
drop trigger if exists consultants_audit on public.consultants;
create trigger consultants_audit after delete on public.consultants
for each row execute function private.audit_row();
drop trigger if exists projects_audit on public.projects;
create trigger projects_audit after delete on public.projects
for each row execute function private.audit_row();

create or replace function public.get_audit()
returns table (at timestamptz, who text, action text, detail text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  return query
    select a.at, coalesce(p.display_name, u.email::text, 'system'), a.action, a.detail
      from private.audit a
      left join public.profiles p on p.user_id = a.actor
      left join auth.users u on u.id = a.actor
     order by a.at desc
     limit 200;
end $$;

revoke execute on function private.stamp_allow_new_device() from public, anon, authenticated;
revoke execute on function private.audit_reports() from public, anon, authenticated;
revoke execute on function private.audit_row() from public, anon, authenticated;
revoke execute on function public.get_audit() from public, anon;
grant execute on function public.get_audit() to authenticated;
