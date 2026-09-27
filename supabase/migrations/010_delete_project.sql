-- Staff: delete a project. Reports that used it are kept: they switch to "Other" with the
-- project's name, so no report is lost and filters still find them by name.
create function public.delete_project(p_project_id uuid)
returns json
language plpgsql security definer set search_path = '' as $$
declare
  pj public.projects;
  n  int;
begin
  if not public.is_staff() then raise exception 'forbidden'; end if;
  select * into pj from public.projects where id = p_project_id;
  if not found then raise exception 'unknown_project'; end if;
  update public.reports set project_id = null, project_other_name = pj.name
   where project_id = pj.id;
  get diagnostics n = row_count;
  delete from public.projects where id = pj.id;
  return json_build_object('reports_moved', n);
end $$;

revoke execute on function public.delete_project(uuid) from public, anon;
grant execute on function public.delete_project(uuid) to authenticated;
