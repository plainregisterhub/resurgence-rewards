-- The Resurgence: admin-only data access baseline.
-- Non-destructive: no tables or rows are dropped or rewritten.
-- Apply only after reviewing the project's existing policies and grants.

create or replace function public.is_resurgence_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.admin_users as au
    where au.user_id = (select auth.uid())
  );
$function$;

revoke all on function public.is_resurgence_admin() from public;
grant execute on function public.is_resurgence_admin() to authenticated;

alter table public.admin_users enable row level security;
alter table public.participants enable row level security;
alter table public.distribution_records enable row level security;
alter table public.multisplit_runs enable row level security;
alter table public.multisplit_items enable row level security;

-- Admins may read only their own allowlist row. No client-side admin provisioning.
drop policy if exists "admins can read own admin row" on public.admin_users;
create policy "admins can read own admin row"
  on public.admin_users for select to authenticated
  using (user_id = (select auth.uid()));

-- Participants: administrative review only. No public access to wallet lists.
drop policy if exists "admins can read participants" on public.participants;
drop policy if exists "resurgence admins read participants" on public.participants;
create policy "resurgence admins read participants"
  on public.participants for select to authenticated
  using ((select public.is_resurgence_admin()));

drop policy if exists "resurgence admins insert participants" on public.participants;
create policy "resurgence admins insert participants"
  on public.participants for insert to authenticated
  with check ((select public.is_resurgence_admin()));

drop policy if exists "resurgence admins update participants" on public.participants;
create policy "resurgence admins update participants"
  on public.participants for update to authenticated
  using ((select public.is_resurgence_admin()))
  with check ((select public.is_resurgence_admin()));

-- Append-oriented reward ledger: no delete policy is intentionally provided.
drop policy if exists "resurgence admins read distribution records" on public.distribution_records;
create policy "resurgence admins read distribution records"
  on public.distribution_records for select to authenticated
  using ((select public.is_resurgence_admin()));
drop policy if exists "resurgence admins insert distribution records" on public.distribution_records;
create policy "resurgence admins insert distribution records"
  on public.distribution_records for insert to authenticated
  with check ((select public.is_resurgence_admin()));
drop policy if exists "resurgence admins update distribution records" on public.distribution_records;
create policy "resurgence admins update distribution records"
  on public.distribution_records for update to authenticated
  using ((select public.is_resurgence_admin()))
  with check ((select public.is_resurgence_admin()));

-- Allocation planning ledger: admins only; this does not execute any chain transfer.
drop policy if exists "resurgence admins read multisplit runs" on public.multisplit_runs;
create policy "resurgence admins read multisplit runs"
  on public.multisplit_runs for select to authenticated
  using ((select public.is_resurgence_admin()));
drop policy if exists "resurgence admins insert multisplit runs" on public.multisplit_runs;
create policy "resurgence admins insert multisplit runs"
  on public.multisplit_runs for insert to authenticated
  with check ((select public.is_resurgence_admin()));
drop policy if exists "resurgence admins update multisplit runs" on public.multisplit_runs;
create policy "resurgence admins update multisplit runs"
  on public.multisplit_runs for update to authenticated
  using ((select public.is_resurgence_admin()))
  with check ((select public.is_resurgence_admin()));

drop policy if exists "resurgence admins read multisplit items" on public.multisplit_items;
create policy "resurgence admins read multisplit items"
  on public.multisplit_items for select to authenticated
  using ((select public.is_resurgence_admin()));
drop policy if exists "resurgence admins insert multisplit items" on public.multisplit_items;
create policy "resurgence admins insert multisplit items"
  on public.multisplit_items for insert to authenticated
  with check ((select public.is_resurgence_admin()));
drop policy if exists "resurgence admins update multisplit items" on public.multisplit_items;
create policy "resurgence admins update multisplit items"
  on public.multisplit_items for update to authenticated
  using ((select public.is_resurgence_admin()))
  with check ((select public.is_resurgence_admin()));

-- Supporting indexes. Avoid recreating the existing multisplit_items(run_id, participant_id) index.
create index if not exists idx_participants_campaign_status
  on public.participants (campaign_id, status);
create index if not exists idx_distribution_records_participant_id
  on public.distribution_records (participant_id);
create index if not exists idx_multisplit_runs_created_by
  on public.multisplit_runs (created_by);
create index if not exists idx_multisplit_items_status
  on public.multisplit_items (run_id, status);

-- Restrict API grants; RLS remains the actual row-level boundary.
revoke all on table public.participants, public.admin_users,
  public.distribution_records, public.multisplit_runs, public.multisplit_items
  from anon;

grant select on table public.admin_users to authenticated;
grant select, insert, update on table public.participants to authenticated;
grant select, insert, update on table public.distribution_records to authenticated;
grant select, insert, update on table public.multisplit_runs to authenticated;
grant select, insert, update on table public.multisplit_items to authenticated;
