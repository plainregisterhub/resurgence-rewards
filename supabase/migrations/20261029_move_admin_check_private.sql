-- Move the admin-check helper out of the exposed public API schema.
-- Policies remain admin-only; no data rows are changed.

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

drop policy if exists "resurgence admins read participants" on public.participants;
drop policy if exists "resurgence admins insert participants" on public.participants;
drop policy if exists "resurgence admins update participants" on public.participants;
drop policy if exists "resurgence admins read distribution records" on public.distribution_records;
drop policy if exists "resurgence admins insert distribution records" on public.distribution_records;
drop policy if exists "resurgence admins update distribution records" on public.distribution_records;
drop policy if exists "resurgence admins read multisplit runs" on public.multisplit_runs;
drop policy if exists "resurgence admins insert multisplit runs" on public.multisplit_runs;
drop policy if exists "resurgence admins update multisplit runs" on public.multisplit_runs;
drop policy if exists "resurgence admins read multisplit items" on public.multisplit_items;
drop policy if exists "resurgence admins insert multisplit items" on public.multisplit_items;
drop policy if exists "resurgence admins update multisplit items" on public.multisplit_items;

drop function if exists public.is_resurgence_admin();
create or replace function private.is_resurgence_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1 from public.admin_users as au
    where au.user_id = (select auth.uid())
  );
$function$;
revoke all on function private.is_resurgence_admin() from public;
grant execute on function private.is_resurgence_admin() to authenticated;

create policy "resurgence admins read participants" on public.participants for select to authenticated using ((select private.is_resurgence_admin()));
create policy "resurgence admins insert participants" on public.participants for insert to authenticated with check ((select private.is_resurgence_admin()));
create policy "resurgence admins update participants" on public.participants for update to authenticated using ((select private.is_resurgence_admin())) with check ((select private.is_resurgence_admin()));

create policy "resurgence admins read distribution records" on public.distribution_records for select to authenticated using ((select private.is_resurgence_admin()));
create policy "resurgence admins insert distribution records" on public.distribution_records for insert to authenticated with check ((select private.is_resurgence_admin()));
create policy "resurgence admins update distribution records" on public.distribution_records for update to authenticated using ((select private.is_resurgence_admin())) with check ((select private.is_resurgence_admin()));

create policy "resurgence admins read multisplit runs" on public.multisplit_runs for select to authenticated using ((select private.is_resurgence_admin()));
create policy "resurgence admins insert multisplit runs" on public.multisplit_runs for insert to authenticated with check ((select private.is_resurgence_admin()));
create policy "resurgence admins update multisplit runs" on public.multisplit_runs for update to authenticated using ((select private.is_resurgence_admin())) with check ((select private.is_resurgence_admin()));

create policy "resurgence admins read multisplit items" on public.multisplit_items for select to authenticated using ((select private.is_resurgence_admin()));
create policy "resurgence admins insert multisplit items" on public.multisplit_items for insert to authenticated with check ((select private.is_resurgence_admin()));
create policy "resurgence admins update multisplit items" on public.multisplit_items for update to authenticated using ((select private.is_resurgence_admin())) with check ((select private.is_resurgence_admin()));
