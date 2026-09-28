-- Round 3 (28 Sep 2026): field-use and stability review.

-- ---------------------------------------------------------------- 9. "Report for: today / yesterday"
alter table public.reports add column if not exists report_date date;
update public.reports set report_date = (submitted_at at time zone 'Asia/Riyadh')::date where report_date is null;
alter table public.reports alter column report_date set not null;
alter table public.reports alter column report_date set default ((now() at time zone 'Asia/Riyadh')::date);
create index if not exists reports_report_date_idx on public.reports(report_date desc);

-- ---------------------------------------------------------------- merge support in the guard
create or replace function private.reports_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.submitted_at is distinct from old.submitted_at
     or new.consultant_name_snapshot is distinct from old.consultant_name_snapshot
     or new.consultant_mobile_snapshot is distinct from old.consultant_mobile_snapshot
     or new.body_html is distinct from old.body_html
     or new.report_date is distinct from old.report_date
     or (new.consultant_id is distinct from old.consultant_id
         and coalesce(current_setting('dcr.merge', true), '') <> 'on') then
    raise exception 'reports_immutable';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------- 1. devices unused for 30 days don't count
create or replace function private.device_count(p_consultant uuid) returns int
language sql stable security definer set search_path = '' as $$
  select count(distinct device_hash)::int from public.consultant_devices
   where consultant_id = p_consultant and device_hash is not null
     and coalesce(last_used_at, created_at) > now() - interval '30 days';
$$;

-- ---------------------------------------------------------------- 2. "Allow new phone": fresh 24 h on every allow
create or replace function private.stamp_allow_new_device() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.allow_new_device then
    new.allow_new_device_at := now();
  else
    new.allow_new_device_at := null;
  end if;
  return new;
end $$;
update public.consultants set allow_new_device = false where allow_new_device and allow_new_device_at is null;

-- Allow a new device for every active consultant for 24 h (after holidays, iPhone data wipes).
create function public.allow_new_device_all()
returns integer
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if not public.is_staff() then raise exception 'forbidden'; end if;
  update public.consultants set allow_new_device = true where is_active;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------- 23. server date for the dashboard
create or replace function public.get_public_config() returns json
language sql stable security definer set search_path = '' as $$
  select json_build_object('access_mode', access_mode,
                           'today', (now() at time zone 'Asia/Riyadh')::date,
                           'hour', extract(hour from now() at time zone 'Asia/Riyadh')::int)
    from public.app_settings where id = 1;
$$;

-- ---------------------------------------------------------------- 15. mobile numbers with +9660 / 009660 / hidden marks
create or replace function public.normalize_mobile(p text) returns text
language plpgsql immutable set search_path = '' as $$
declare d text;
begin
  d := translate(coalesce(p, ''), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789');
  d := regexp_replace(d, '[\s\-\(\)\.‎‏‪-‮⁦-⁩]', '', 'g');
  if d ~ '^05[0-9]{8}$' then return '+966' || substr(d, 2);
  elsif d ~ '^5[0-9]{8}$' then return '+966' || d;
  elsif d ~ '^\+9665[0-9]{8}$' then return d;
  elsif d ~ '^\+96605[0-9]{8}$' then return '+966' || substr(d, 6);
  elsif d ~ '^9665[0-9]{8}$' then return '+' || d;
  elsif d ~ '^009665[0-9]{8}$' then return '+' || substr(d, 3);
  elsif d ~ '^0096605[0-9]{8}$' then return '+966' || substr(d, 7);
  end if;
  return null;
end $$;

-- ---------------------------------------------------------------- registration: case-insensitive code, cleanup, 30-day devices
create or replace function public.register_consultant(
  p_full_name text, p_mobile text, p_team_code text default null,
  p_device_id text default null, p_pair_code text default null)
returns json
language plpgsql security definer set search_path = '' as $$
declare
  s        public.app_settings;
  m        text;
  c        public.consultants;
  dev      text;
  tok      text;
  code     text;
  pair     text;
  n_dev    int;
  is_new   boolean := false;
begin
  if current_setting('transaction_read_only')::boolean then raise exception 'post_required'; end if;

  if length(coalesce(p_device_id, '')) < 16 then raise exception 'device_required'; end if;
  dev := private.hash_token(p_device_id);
  m := public.normalize_mobile(p_mobile);
  if m is null then raise exception 'invalid_mobile'; end if;
  if length(btrim(coalesce(p_full_name, ''))) < 2 then raise exception 'invalid_name'; end if;

  delete from private.code_failures where at < now() - interval '1 hour';   -- keep the table small

  select * into c from public.consultants where mobile = m for update;

  if found and exists (select 1 from public.consultant_devices d
                        where d.consultant_id = c.id and d.device_hash = dev) then
    delete from public.consultant_devices where consultant_id = c.id and device_hash = dev;
    tok := private.new_token();
    insert into public.consultant_devices (consultant_id, token_hash, device_hash, last_used_at)
    values (c.id, private.hash_token(tok), dev, now());
    return json_build_object('consultant_id', c.id, 'full_name', c.full_name, 'mobile', c.mobile,
                             'device_token', tok, 'is_new', false);
  end if;

  if (select count(*) from private.code_failures where key = dev and at > now() - interval '10 minutes') >= 10
     or (select count(*) from private.code_failures where at > now() - interval '10 minutes') >= 300 then
    return json_build_object('error', 'rate_limited');
  end if;

  select * into s from public.app_settings where id = 1;
  if s.access_mode <> 'none' then
    code := translate(btrim(coalesce(p_team_code, '')), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789');
    if s.team_code is null or lower(code) <> lower(s.team_code) then
      insert into private.code_failures (key) values (dev);
      return json_build_object('error', 'invalid_team_code');
    end if;
  end if;

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
      select * into c from public.consultants where mobile = m for update;
    end if;
  end if;

  if not is_new then
    n_dev := private.device_count(c.id);
    if c.allow_new_device and c.allow_new_device_at > now() - interval '24 hours' then
      update public.consultants set allow_new_device = false where id = c.id;
    elsif n_dev = 0 then
      null;
    elsif n_dev >= 2 then
      raise exception 'device_limit';
    else
      pair := translate(btrim(coalesce(p_pair_code, '')), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789');
      if pair = '' then
        return json_build_object('error', 'pair_code_needed');
      end if;
      delete from private.pairing_codes
       where consultant_id = c.id and expires_at > now() and code_hash = private.hash_token(pair);
      if not found then
        insert into private.code_failures (key) values (dev);
        return json_build_object('error', 'invalid_pair_code');
      end if;
    end if;
  end if;

  tok := private.new_token();
  insert into public.consultant_devices (consultant_id, token_hash, device_hash, last_used_at)
  values (c.id, private.hash_token(tok), dev, now());

  return json_build_object('consultant_id', c.id, 'full_name', c.full_name, 'mobile', c.mobile,
                           'device_token', tok, 'is_new', is_new);
end $$;

-- Visiting the app counts as using the device (keeps it inside the 30-day window).
create or replace function public.bind_device(p_consultant_id uuid, p_device_token text, p_device_id text)
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
  update public.consultant_devices set device_hash = coalesce(device_hash, dev), last_used_at = now()
   where consultant_id = p_consultant_id and token_hash = private.hash_token(p_device_token);
  if not found then
    return json_build_object('status', 'unknown');
  end if;
  select * into c from public.consultants where id = p_consultant_id;
  return json_build_object('status', 'ok', 'full_name', c.full_name, 'mobile', c.mobile);
end $$;

-- 18. Signing out frees this phone when the consultant never sent anything (a mistaken registration).
create function public.sign_out_device(p_consultant_id uuid, p_device_token text)
returns json
language plpgsql security definer set search_path = '' as $$
declare freed boolean := false;
begin
  if not private.check_device(p_consultant_id, p_device_token) then return json_build_object('freed', false); end if;
  if not exists (select 1 from public.reports where consultant_id = p_consultant_id) then
    delete from public.consultant_devices
     where consultant_id = p_consultant_id and token_hash = private.hash_token(p_device_token);
    freed := true;
  end if;
  return json_build_object('freed', freed);
end $$;

-- ---------------------------------------------------------------- submission: report date, min length, duplicates
drop function if exists public.submit_report(uuid, uuid, text, text, uuid, text, text, text, integer);

create function public.submit_report(
  p_report_id          uuid,
  p_consultant_id      uuid,
  p_device_token       text,
  p_project_type       text,
  p_project_id         uuid,
  p_project_other_name text,
  p_body_html          text,
  p_body_text          text,
  p_photos_expected    integer,
  p_report_for         text default 'today')
returns json
language plpgsql security definer set search_path = '' as $$
declare
  s          public.app_settings;
  c          public.consultants;
  r          public.reports;
  today      date := (now() at time zone 'Asia/Riyadh')::date;
  rdate      date;
  today_from timestamptz;
  n_today    int;
  txt        text;
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
    if length(coalesce(p_body_html, '')) = 0 then raise exception 'empty_report'; end if;
    if octet_length(p_body_html) > 30000 then raise exception 'too_long'; end if;
    if not private.html_ok(p_body_html) then raise exception 'bad_html'; end if;
    txt := private.html_to_text(p_body_html);
    if length(txt) = 0 then raise exception 'empty_report'; end if;
    if length(regexp_replace(txt, '\s', '', 'g')) < 10 then raise exception 'too_short'; end if;
    if coalesce(p_photos_expected, 0) not between 0 and 20 then
      raise exception 'too_many_photos';
    end if;

    -- "Yesterday" is accepted until 12:00 Riyadh time.
    if p_report_for = 'yesterday' then
      if extract(hour from now() at time zone 'Asia/Riyadh') >= 12 then raise exception 'yesterday_closed'; end if;
      rdate := today - 1;
    else
      rdate := today;
    end if;

    -- The same text for the same project within 30 minutes is almost certainly a second tap.
    if exists (select 1 from public.reports x
                where x.consultant_id = p_consultant_id
                  and x.submitted_at > now() - interval '30 minutes'
                  and x.project_type = p_project_type
                  and x.project_id is not distinct from p_project_id
                  and x.project_other_name is not distinct from nullif(left(btrim(p_project_other_name), 150), '')
                  and x.body_text = left(txt, 30000)) then
      raise exception 'duplicate_report';
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
      project_type, project_id, project_other_name, body_html, body_text, photos_expected, report_date)
    values (
      p_report_id, c.id, c.full_name, c.mobile,
      p_project_type, p_project_id, nullif(left(btrim(p_project_other_name), 150), ''),
      p_body_html, left(txt, 30000), coalesce(p_photos_expected, 0), rdate)
    on conflict (id) do nothing
    returning * into r;
    if not found then
      select * into r from public.reports where id = p_report_id;
      if r.consultant_id <> p_consultant_id then raise exception 'report_conflict'; end if;
      existed := true;
    end if;
  end if;

  return json_build_object('report_id', r.id, 'submitted_at', r.submitted_at, 'report_date', r.report_date,
                           'folder', private.report_folder(r.id, r.submitted_at),
                           'photos_expected', r.photos_expected, 'existed', existed);
end $$;
revoke execute on function public.submit_report(uuid, uuid, text, text, uuid, text, text, text, integer, text) from public;
grant execute on function public.submit_report(uuid, uuid, text, text, uuid, text, text, text, integer, text) to anon, authenticated;

-- ---------------------------------------------------------------- 7. staff: delete / correct a single report
create function public.staff_delete_report(p_report_id uuid)
returns json
language plpgsql security definer set search_path = '' as $$
declare
  r     public.reports;
  names text[];
begin
  if not public.is_staff() then raise exception 'forbidden'; end if;
  select * into r from public.reports where id = p_report_id;
  if not found then raise exception 'unknown_report'; end if;
  select coalesce(array_agg(o.name order by o.name), '{}') into names
    from storage.objects o
   where o.bucket_id = 'report-photos' and o.name like private.report_folder(r.id, r.submitted_at) || '/%';
  delete from public.reports where id = r.id;
  return json_build_object('object_names', names);
end $$;

create function public.staff_set_report_project(p_report_id uuid, p_type text, p_project_id uuid, p_other_name text)
returns json
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_staff() then raise exception 'forbidden'; end if;
  if p_type not in ('UGC', 'S/S', 'OHTL') then raise exception 'invalid_project_type'; end if;
  if p_project_id is null and length(btrim(coalesce(p_other_name, ''))) = 0 then raise exception 'invalid_project'; end if;
  update public.reports
     set project_type = p_type,
         project_id = p_project_id,
         project_other_name = case when p_project_id is null then left(btrim(p_other_name), 150) end
   where id = p_report_id;
  if not found then raise exception 'unknown_report'; end if;
  insert into private.audit (action, detail) values ('edit_report_project', p_report_id::text);
  return json_build_object('ok', true);
end $$;

-- 12. staff: link an "Other" name to an existing project (instead of creating a near-duplicate)
create function public.link_other_to_project(p_type text, p_name text, p_project_id uuid)
returns json
language plpgsql security definer set search_path = '' as $$
declare
  pj public.projects;
  n  int;
begin
  if not public.is_staff() then raise exception 'forbidden'; end if;
  select * into pj from public.projects where id = p_project_id;
  if not found then raise exception 'unknown_project'; end if;
  update public.reports set project_id = pj.id, project_type = pj.type, project_other_name = null
   where project_id is null and project_type = p_type and project_other_name = p_name;
  get diagnostics n = row_count;
  return json_build_object('relinked', n);
end $$;

-- ---------------------------------------------------------------- 11. staff: merge a duplicate consultant into another
create function public.merge_consultants(p_from uuid, p_into uuid)
returns json
language plpgsql security definer set search_path = '' as $$
declare
  f  public.consultants;
  n  int;
begin
  if not public.is_staff() then raise exception 'forbidden'; end if;
  if p_from = p_into then raise exception 'same_consultant'; end if;
  select * into f from public.consultants where id = p_from;
  if not found or not exists (select 1 from public.consultants where id = p_into) then
    raise exception 'unknown_consultant';
  end if;
  perform set_config('dcr.merge', 'on', true);
  update public.reports set consultant_id = p_into where consultant_id = p_from;
  get diagnostics n = row_count;
  perform set_config('dcr.merge', 'off', true);
  update public.consultant_devices set consultant_id = p_into where consultant_id = p_from;
  delete from public.consultants where id = p_from;
  insert into private.audit (action, detail)
  values ('merge_consultants', f.full_name || ' (' || f.mobile || ') → ' || p_into::text || ', ' || n || ' report(s)');
  return json_build_object('reports_moved', n);
end $$;

-- ---------------------------------------------------------------- 16. keep the audit log bounded (1 year)
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
  delete from private.audit where at < now() - interval '1 year';
  return null;
end $$;

-- ---------------------------------------------------------------- consultant overview: expiry of "Allow new phone"
create or replace view public.consultant_overview with (security_invoker = true) as
select c.id, c.full_name, c.mobile, c.created_at, c.is_active, c.allow_new_device,
       (select max(r.submitted_at) from public.reports r where r.consultant_id = c.id) as last_submitted_at,
       (select count(distinct d.device_hash) from public.consultant_devices d
         where d.consultant_id = c.id and d.device_hash is not null
           and coalesce(d.last_used_at, d.created_at) > now() - interval '30 days') as phones,
       (select count(*) from public.reports r where r.consultant_id = c.id) as reports,
       c.allow_new_device_at,
       (c.allow_new_device and c.allow_new_device_at > now() - interval '24 hours') as allow_active
  from public.consultants c;
revoke all on public.consultant_overview from anon;

-- ---------------------------------------------------------------- grants
revoke execute on function public.allow_new_device_all() from public, anon;
revoke execute on function public.staff_delete_report(uuid) from public, anon;
revoke execute on function public.staff_set_report_project(uuid, text, uuid, text) from public, anon;
revoke execute on function public.link_other_to_project(text, text, uuid) from public, anon;
revoke execute on function public.merge_consultants(uuid, uuid) from public, anon;
grant execute on function public.allow_new_device_all() to authenticated;
grant execute on function public.staff_delete_report(uuid) to authenticated;
grant execute on function public.staff_set_report_project(uuid, text, uuid, text) to authenticated;
grant execute on function public.link_other_to_project(text, text, uuid) to authenticated;
grant execute on function public.merge_consultants(uuid, uuid) to authenticated;
revoke execute on function public.sign_out_device(uuid, text) from public;
grant execute on function public.sign_out_device(uuid, text) to anon, authenticated;
