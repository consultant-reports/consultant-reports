-- Owner decision (28 Sep 2026): keep the 6-digit pairing code for a consultant's second device,
-- but never ask for it when the consultant has no linked device at all (e.g. after "Release
-- phone"). A lost first device → the person in charge taps "Allow new phone" (24 h).
-- Pairing codes are now consumed atomically (no double use), and wrong pairing codes count in
-- the same per-device failure counter as wrong team codes.

create table if not exists private.pairing_codes (
  consultant_id uuid not null references public.consultants(id) on delete cascade,
  code_hash     text not null,
  expires_at    timestamptz not null,
  primary key (consultant_id)
);

create or replace function public.create_pairing_code(p_consultant_id uuid, p_device_token text)
returns json
language plpgsql security definer set search_path = '' as $$
declare code text;
begin
  if current_setting('transaction_read_only')::boolean then raise exception 'post_required'; end if;
  if not private.check_device(p_consultant_id, p_device_token) then
    raise exception 'device_not_recognized';
  end if;
  if private.device_count(p_consultant_id) >= 2 then raise exception 'device_limit'; end if;
  code := lpad((('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))::bit(32)::bigint % 1000000)::text, 6, '0');
  insert into private.pairing_codes (consultant_id, code_hash, expires_at)
  values (p_consultant_id, private.hash_token(code), now() + interval '10 minutes')
  on conflict (consultant_id) do update set code_hash = excluded.code_hash, expires_at = excluded.expires_at;
  return json_build_object('code', code, 'expires_at', now() + interval '10 minutes');
end $$;

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

  select * into c from public.consultants where mobile = m for update;

  -- Returning on a device already linked to this number: always allowed, never throttled.
  if found and exists (select 1 from public.consultant_devices d
                        where d.consultant_id = c.id and d.device_hash = dev) then
    delete from public.consultant_devices where consultant_id = c.id and device_hash = dev;
    tok := private.new_token();
    insert into public.consultant_devices (consultant_id, token_hash, device_hash)
    values (c.id, private.hash_token(tok), dev);
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
    if s.team_code is null or code <> s.team_code then
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
      update public.consultants set allow_new_device = false where id = c.id;   -- the person in charge allowed it
    elsif n_dev = 0 then
      null;                                                                      -- no linked device: register freely
    elsif n_dev >= 2 then
      raise exception 'device_limit';
    else
      pair := translate(btrim(coalesce(p_pair_code, '')), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789');
      if pair = '' then
        return json_build_object('error', 'pair_code_needed');
      end if;
      -- Consume the code atomically: a code can link one device only.
      delete from private.pairing_codes
       where consultant_id = c.id and expires_at > now() and code_hash = private.hash_token(pair);
      if not found then
        insert into private.code_failures (key) values (dev);
        return json_build_object('error', 'invalid_pair_code');
      end if;
    end if;
  end if;

  tok := private.new_token();
  insert into public.consultant_devices (consultant_id, token_hash, device_hash)
  values (c.id, private.hash_token(tok), dev);

  return json_build_object('consultant_id', c.id, 'full_name', c.full_name, 'mobile', c.mobile,
                           'device_token', tok, 'is_new', is_new);
end $$;

revoke execute on function public.create_pairing_code(uuid, text) from public;
grant execute on function public.create_pairing_code(uuid, text) to anon, authenticated;
