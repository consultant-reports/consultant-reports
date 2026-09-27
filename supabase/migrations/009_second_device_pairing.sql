-- A consultant may use up to 2 devices (e.g. phone browser + WhatsApp's in-app browser, or
-- phone + laptop) without the manager. The second device is linked with a 6-digit pairing
-- code shown on the first device (valid 10 minutes, single use). Knowing someone's mobile
-- number is therefore still not enough to register as them.

create table if not exists private.pairing_codes (
  consultant_id uuid not null references public.consultants(id) on delete cascade,
  code_hash     text not null,
  expires_at    timestamptz not null,
  primary key (consultant_id)
);

create or replace function private.device_count(p_consultant uuid) returns int
language sql stable security definer set search_path = '' as $$
  select count(distinct device_hash)::int from public.consultant_devices
   where consultant_id = p_consultant and device_hash is not null;
$$;

-- First device: create a pairing code for a second device.
create function public.create_pairing_code(p_consultant_id uuid, p_device_token text)
returns json
language plpgsql security definer set search_path = '' as $$
declare code text;
begin
  if not private.check_device(p_consultant_id, p_device_token) then
    raise exception 'device_not_recognized';
  end if;
  if private.device_count(p_consultant_id) >= 2 then raise exception 'device_limit'; end if;
  -- 6 digits from gen_random_uuid() (cryptographically random), not random().
  code := lpad((('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))::bit(32)::bigint % 1000000)::text, 6, '0');
  insert into private.pairing_codes (consultant_id, code_hash, expires_at)
  values (p_consultant_id, private.hash_token(code), now() + interval '10 minutes')
  on conflict (consultant_id) do update set code_hash = excluded.code_hash, expires_at = excluded.expires_at;
  return json_build_object('code', code, 'expires_at', now() + interval '10 minutes');
end $$;

drop function if exists public.register_consultant(text, text, text, text);

create function public.register_consultant(
  p_full_name text, p_mobile text, p_team_code text default null,
  p_device_id text default null, p_pair_code text default null)
returns json
language plpgsql security definer set search_path = '' as $$
declare
  s        public.app_settings;
  m        text;
  c        public.consultants;
  existing uuid;
  dev      text;
  tok      text;
  is_new   boolean := false;
  paired   boolean := false;
begin
  if length(coalesce(p_device_id, '')) < 16 then raise exception 'device_required'; end if;
  dev := private.hash_token(p_device_id);
  m := public.normalize_mobile(p_mobile);
  if m is null then raise exception 'invalid_mobile'; end if;
  if length(btrim(coalesce(p_full_name, ''))) < 2 then raise exception 'invalid_name'; end if;

  -- Wrong team codes and wrong pairing codes share one failure counter.
  if (select count(*) from private.code_failures where at > now() - interval '10 minutes') >= 20 then
    return json_build_object('error', 'rate_limited');
  end if;

  select * into s from public.app_settings where id = 1;
  if s.access_mode <> 'none'
     and (s.team_code is null or btrim(coalesce(p_team_code, '')) <> s.team_code) then
    insert into private.code_failures default values;
    return json_build_object('error', 'invalid_team_code');
  end if;

  select id into existing from public.consultants where mobile = m;
  if exists (select 1 from public.consultant_devices d
              where d.device_hash = dev and d.consultant_id is distinct from existing) then
    raise exception 'device_bound_other';
  end if;

  if existing is null then
    if (select count(*) from public.consultants where created_at > now() - interval '1 day') >= 30 then
      raise exception 'rate_limited';
    end if;
    insert into public.consultants (full_name, mobile)
    values (left(btrim(p_full_name), 100), m)
    on conflict (mobile) do nothing
    returning * into c;
    is_new := found;
  end if;

  if not is_new then
    select * into c from public.consultants where mobile = m;
    if not exists (select 1 from public.consultant_devices d
                    where d.consultant_id = c.id and d.device_hash = dev) then
      -- A device this consultant has not used before.
      if c.allow_new_device then
        update public.consultants set allow_new_device = false where id = c.id;
      elsif nullif(btrim(coalesce(p_pair_code, '')), '') is null then
        return json_build_object('error', 'pair_code_needed');
      elsif private.device_count(c.id) >= 2 then
        raise exception 'device_limit';
      elsif exists (select 1 from private.pairing_codes pc
                     where pc.consultant_id = c.id and pc.expires_at > now()
                       and pc.code_hash = private.hash_token(btrim(p_pair_code))) then
        delete from private.pairing_codes where consultant_id = c.id;
        paired := true;
      else
        insert into private.code_failures default values;
        return json_build_object('error', 'invalid_pair_code');
      end if;
    end if;
  end if;

  tok := private.new_token();
  insert into public.consultant_devices (consultant_id, token_hash, device_hash)
  values (c.id, private.hash_token(tok), dev);

  return json_build_object(
    'consultant_id', c.id, 'full_name', c.full_name, 'mobile', c.mobile,
    'device_token', tok, 'is_new', is_new, 'paired', paired);
end $$;

-- Device counts on the Consultants screen: distinct devices, not tokens.
create or replace view public.consultant_overview with (security_invoker = true) as
select c.id, c.full_name, c.mobile, c.created_at, c.is_active, c.allow_new_device,
       (select max(r.submitted_at) from public.reports r where r.consultant_id = c.id) as last_submitted_at,
       (select count(distinct d.device_hash) from public.consultant_devices d
         where d.consultant_id = c.id and d.device_hash is not null) as phones,
       (select count(*) from public.reports r where r.consultant_id = c.id) as reports
  from public.consultants c;
revoke all on public.consultant_overview from anon;

revoke execute on function private.device_count(uuid) from public, anon, authenticated;
revoke execute on function public.create_pairing_code(uuid, text) from public;
grant execute on function public.create_pairing_code(uuid, text) to anon, authenticated;
revoke execute on function public.register_consultant(text, text, text, text, text) from public;
grant execute on function public.register_consultant(text, text, text, text, text) to anon, authenticated;
