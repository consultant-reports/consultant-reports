-- audit_row(): read the deleted row as JSON, so one trigger function serves tables with
-- different columns (plain OLD.field fails when the column does not exist on that table).
create or replace function private.audit_row() returns trigger
language plpgsql security definer set search_path = '' as $$
declare j jsonb := to_jsonb(old);
begin
  insert into private.audit (action, detail)
  values ('delete_' || tg_table_name,
          case tg_table_name
            when 'consultants' then (j ->> 'full_name') || ' (' || (j ->> 'mobile') || ')'
            when 'projects' then (j ->> 'name') || ' (' || (j ->> 'type') || ')'
          end);
  return null;
end $$;
revoke execute on function private.audit_row() from public, anon, authenticated;
