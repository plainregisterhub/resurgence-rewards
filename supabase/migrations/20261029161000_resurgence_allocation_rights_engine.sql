-- Separate allocation-right entitlements from all payout amounts.
-- A right is a project-defined 0.2% entitlement to the eligible creator-fee base; it is not a token or current monetary balance.
-- This migration does not establish Pump.fun fee routing and does not sign or send Solana transactions.

create table if not exists public.participant_allocation_rights (
  id uuid primary key default gen_random_uuid(),
  campaign_id text not null default 'resurgence-2026',
  participant_id uuid not null references public.participants(id) on delete restrict,
  wallet_address text not null
    check (wallet_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  allocation_bps integer not null default 20 check (allocation_bps = 20),
  status text not null default 'ACTIVE' check (status in ('ACTIVE','REVOKED')),
  granted_at timestamptz not null default now(),
  granted_by uuid references auth.users(id),
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id),
  revocation_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint participant_allocation_rights_campaign_participant_key unique (campaign_id, participant_id),
  constraint participant_allocation_rights_revocation_state_check
    check (
      (status = 'ACTIVE' and revoked_at is null and revoked_by is null)
      or (status = 'REVOKED' and revoked_at is not null)
    )
);

create index if not exists participant_allocation_rights_campaign_status_idx
  on public.participant_allocation_rights (campaign_id, status, granted_at);

alter table public.participant_allocation_rights enable row level security;
revoke all on table public.participant_allocation_rights from public, anon, authenticated;

-- Seed the selected public Master Wallet address in a fresh project only.
-- Preserve any deliberate later admin configuration if this migration is replayed.
insert into public.resurgence_treasury_config
  (campaign_id, master_wallet_address, pool_bps, participant_bps, participant_cap)
values
  ('resurgence-2026', '7jqyogrnPP9tCcTqPvzG7Ys63s5V7uDS8sCgSKhNfUFT', 2500, 20, 125)
on conflict (campaign_id) do nothing;

create or replace function public.get_resurgence_allocation_rights()
returns table (
  right_id uuid,
  participant_id uuid,
  wallet_address text,
  allocation_bps integer,
  status text,
  granted_at timestamptz,
  revoked_at timestamptz,
  revocation_reason text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_resurgence_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;
  return query
    select ar.id, ar.participant_id, ar.wallet_address, ar.allocation_bps,
           ar.status, ar.granted_at, ar.revoked_at, ar.revocation_reason
    from public.participant_allocation_rights ar
    where ar.campaign_id = 'resurgence-2026'
    order by ar.granted_at desc, ar.id;
end;
$$;

create or replace function public.sync_resurgence_allocation_rights()
returns table (
  added_count integer,
  active_count integer,
  active_bps integer,
  slots_remaining integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_active integer;
  v_to_add integer;
  v_added integer;
  v_bps integer;
begin
  if not private.is_resurgence_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('resurgence-2026-allocation-rights', 0));

  select count(*)::integer into v_active
  from public.participant_allocation_rights ar
  where ar.campaign_id = 'resurgence-2026' and ar.status = 'ACTIVE';

  select count(*)::integer into v_to_add
  from public.participants p
  where p.campaign_id = 'resurgence-2026'
    and p.status = 'APPROVED'
    and not exists (
      select 1 from public.participant_allocation_rights ar
      where ar.campaign_id = p.campaign_id and ar.participant_id = p.id
    );

  if v_active + v_to_add > 125 then
    raise exception 'The 125 allocation-right cap would be exceeded. Review approvals before granting more rights.';
  end if;

  insert into public.participant_allocation_rights
    (campaign_id, participant_id, wallet_address, allocation_bps, status, granted_by)
  select p.campaign_id, p.id, p.wallet_address, 20, 'ACTIVE', auth.uid()
  from public.participants p
  where p.campaign_id = 'resurgence-2026'
    and p.status = 'APPROVED'
    and not exists (
      select 1 from public.participant_allocation_rights ar
      where ar.campaign_id = p.campaign_id and ar.participant_id = p.id
    )
  order by p.submitted_at, p.id
  on conflict on constraint participant_allocation_rights_campaign_participant_key do nothing;
  get diagnostics v_added = row_count;

  select count(*)::integer, coalesce(sum(ar.allocation_bps), 0)::integer
    into v_active, v_bps
  from public.participant_allocation_rights ar
  where ar.campaign_id = 'resurgence-2026' and ar.status = 'ACTIVE';

  return query select v_added, v_active, v_bps, greatest(125 - v_active, 0);
end;
$$;

create or replace function public.revoke_resurgence_allocation_right(
  p_participant_id uuid,
  p_reason text
)
returns table (
  right_id uuid,
  status text,
  revoked_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_status text;
  v_revoked_at timestamptz;
begin
  if not private.is_resurgence_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;
  if p_participant_id is null then
    raise exception 'A participant ID is required.';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 5 or length(btrim(p_reason)) > 500 then
    raise exception 'Enter a revocation reason between 5 and 500 characters.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('resurgence-2026-allocation-rights', 0));

  update public.participant_allocation_rights ar
  set status = 'REVOKED',
      revoked_at = now(),
      revoked_by = auth.uid(),
      revocation_reason = btrim(p_reason),
      updated_at = now()
  where ar.campaign_id = 'resurgence-2026'
    and ar.participant_id = p_participant_id
    and ar.status = 'ACTIVE'
  returning ar.id, ar.status, ar.revoked_at into v_id, v_status, v_revoked_at;

  if not found then
    raise exception 'No active allocation right was found for this participant.';
  end if;
  return query select v_id, v_status, v_revoked_at;
end;
$$;

-- Payout planning consumes active rights; it never creates rights and never sends funds.
create or replace function public.create_resurgence_multisplit_plan(
  p_eligible_fees_lamports numeric,
  p_idempotency_key text
)
returns table (
  run_id uuid,
  eligible_fees_lamports numeric,
  pool_bps integer,
  participant_bps integer,
  participant_count integer,
  total_pool_lamports numeric,
  total_planned_lamports numeric,
  master_wallet_address text,
  status text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_config public.resurgence_treasury_config%rowtype;
  v_existing public.multisplit_runs%rowtype;
  v_count integer;
  v_pool numeric;
  v_each numeric;
  v_total numeric;
  v_run_id uuid;
begin
  if not private.is_resurgence_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;
  if p_eligible_fees_lamports is null or p_eligible_fees_lamports <= 0
     or trunc(p_eligible_fees_lamports) <> p_eligible_fees_lamports then
    raise exception 'Eligible creator fees must be a positive whole number of lamports.';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) < 8 or length(p_idempotency_key) > 100 then
    raise exception 'A valid idempotency key is required.';
  end if;

  select * into v_config
  from public.resurgence_treasury_config
  where campaign_id = 'resurgence-2026';
  if not found then
    raise exception 'Configure the Master Wallet address before creating a payout draft.';
  end if;

  select * into v_existing
  from public.multisplit_runs
  where idempotency_key = p_idempotency_key;
  if found then
    if v_existing.eligible_fees_lamports <> p_eligible_fees_lamports
       or v_existing.campaign_id <> 'resurgence-2026' then
      raise exception 'This idempotency key was already used for a different plan.';
    end if;
    return query
      select r.id, r.eligible_fees_lamports, r.pool_bps, r.participant_bps,
             r.participant_count, r.total_pool_lamports, r.total_planned_lamports,
             r.master_wallet_address, r.status, r.created_at
      from public.multisplit_runs r where r.id = v_existing.id;
    return;
  end if;

  -- Prevent a rights sync/revocation racing this payout snapshot.
  perform pg_advisory_xact_lock(hashtextextended('resurgence-2026-allocation-rights', 0));

  select count(*)::integer into v_count
  from public.participant_allocation_rights ar
  where ar.campaign_id = 'resurgence-2026' and ar.status = 'ACTIVE';
  if v_count < 1 then
    raise exception 'No active allocation rights exist yet. Grant rights to approved participants before planning payouts.';
  end if;
  if v_count > v_config.participant_cap then
    raise exception 'Active allocation rights exceed the 125-recipient cap.';
  end if;

  v_pool := trunc(p_eligible_fees_lamports * v_config.pool_bps / 10000);
  v_each := trunc(p_eligible_fees_lamports * v_config.participant_bps / 10000);
  v_total := v_each * v_count;
  if v_each < 1 then
    raise exception 'Eligible fee base is too small to allocate at least one lamport per right.';
  end if;
  if v_total > v_pool then
    raise exception 'Planned allocations exceed the 25%% Rewards Pool cap.';
  end if;

  insert into public.multisplit_runs (
    idempotency_key, campaign_id, eligible_fees_lamports, pool_bps,
    participant_bps, participant_count, total_pool_lamports,
    total_planned_lamports, master_wallet_address, status, created_by
  )
  values (
    p_idempotency_key, 'resurgence-2026', p_eligible_fees_lamports,
    v_config.pool_bps, v_config.participant_bps, v_count, v_pool,
    v_total, v_config.master_wallet_address, 'DRAFT', auth.uid()
  )
  returning id into v_run_id;

  insert into public.multisplit_items (run_id, participant_id, wallet_address, amount_lamports, status)
  select v_run_id, ar.participant_id, ar.wallet_address, v_each, 'PENDING'
  from public.participant_allocation_rights ar
  where ar.campaign_id = 'resurgence-2026' and ar.status = 'ACTIVE'
  order by ar.granted_at, ar.participant_id;

  return query
    select r.id, r.eligible_fees_lamports, r.pool_bps, r.participant_bps,
           r.participant_count, r.total_pool_lamports, r.total_planned_lamports,
           r.master_wallet_address, r.status, r.created_at
    from public.multisplit_runs r where r.id = v_run_id;
end;
$$;

revoke all on function public.get_resurgence_allocation_rights() from public, anon;
revoke all on function public.sync_resurgence_allocation_rights() from public, anon;
revoke all on function public.revoke_resurgence_allocation_right(uuid, text) from public, anon;
revoke all on function public.create_resurgence_multisplit_plan(numeric, text) from public, anon;
grant execute on function public.get_resurgence_allocation_rights() to authenticated;
grant execute on function public.sync_resurgence_allocation_rights() to authenticated;
grant execute on function public.revoke_resurgence_allocation_right(uuid, text) to authenticated;
grant execute on function public.create_resurgence_multisplit_plan(numeric, text) to authenticated;
