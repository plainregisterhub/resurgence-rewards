-- Resurgence payout executor foundation: asset-aware plans, idempotent batches, and signer state.
-- This migration never sends transactions or stores a wallet private key.

alter table public.multisplit_runs
  add column if not exists asset_type text not null default 'SOL',
  add column if not exists asset_mint text,
  add column if not exists asset_decimals integer not null default 9,
  add column if not exists execution_lock_until timestamptz,
  add column if not exists execution_error text,
  add column if not exists payout_cluster text;

alter table public.multisplit_runs
  drop constraint if exists multisplit_runs_payout_cluster_check;
alter table public.multisplit_runs
  add constraint multisplit_runs_payout_cluster_check
  check (payout_cluster is null or payout_cluster in ('devnet', 'mainnet-beta'));

alter table public.multisplit_runs
  drop constraint if exists multisplit_runs_asset_type_check;
alter table public.multisplit_runs
  add constraint multisplit_runs_asset_type_check
  check (asset_type in ('SOL', 'TOKEN'));

alter table public.multisplit_runs
  drop constraint if exists multisplit_runs_asset_decimals_check;
alter table public.multisplit_runs
  add constraint multisplit_runs_asset_decimals_check
  check (asset_decimals between 0 and 9);

alter table public.multisplit_runs
  drop constraint if exists multisplit_runs_asset_config_check;
alter table public.multisplit_runs
  add constraint multisplit_runs_asset_config_check
  check (
    (asset_type = 'SOL' and asset_mint is null and asset_decimals = 9)
    or
    (asset_type = 'TOKEN' and asset_mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')
  );

-- One Solana transaction may pay multiple recipients, so a transaction signature
-- is intentionally allowed to appear on multiple recipient ledger rows.
alter table public.multisplit_items
  drop constraint if exists multisplit_items_transaction_signature_key;
create index if not exists multisplit_items_transaction_signature_idx
  on public.multisplit_items (transaction_signature)
  where transaction_signature is not null;

alter table public.distribution_records
  drop constraint if exists distribution_records_transaction_signature_key;
create index if not exists distribution_records_transaction_signature_idx
  on public.distribution_records (transaction_signature)
  where transaction_signature is not null;

alter table public.distribution_records
  add column if not exists payout_item_id uuid references public.multisplit_items(id) on delete restrict;
alter table public.distribution_records
  add column if not exists cluster text not null default 'mainnet-beta';
alter table public.distribution_records
  drop constraint if exists distribution_records_cluster_check;
alter table public.distribution_records
  add constraint distribution_records_cluster_check
  check (cluster in ('devnet', 'mainnet-beta'));
create unique index if not exists distribution_records_payout_item_id_key
  on public.distribution_records (payout_item_id);

create table if not exists public.resurgence_payout_batches (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.multisplit_runs(id) on delete restrict,
  batch_index integer not null check (batch_index >= 0),
  attempt_no integer not null default 1 check (attempt_no >= 1),
  item_ids uuid[] not null check (cardinality(item_ids) between 1 and 125),
  status text not null default 'SIGNED'
    check (status in ('SIGNED', 'SUBMITTED', 'CONFIRMED', 'FAILED')),
  transaction_signature text unique,
  signed_transaction text,
  recent_blockhash text,
  last_valid_block_height bigint,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  confirmed_at timestamptz,
  constraint resurgence_payout_batches_run_index_attempt_key unique (run_id, batch_index, attempt_no),
  constraint resurgence_payout_batches_signed_data_check
    check (
      (status = 'SIGNED' and signed_transaction is not null and transaction_signature is not null)
      or status <> 'SIGNED'
    )
);

create index if not exists resurgence_payout_batches_run_status_idx
  on public.resurgence_payout_batches (run_id, status, batch_index);

alter table public.resurgence_payout_batches enable row level security;
revoke all on table public.resurgence_payout_batches from public, anon, authenticated;
grant select, insert, update on table public.resurgence_payout_batches to service_role;

-- Asset-aware plan creation. Amounts are stored in the asset's smallest units:
-- lamports for SOL, token base units for classic SPL tokens.
create or replace function public.create_resurgence_asset_payout_plan(
  p_asset_type text,
  p_asset_mint text,
  p_asset_decimals integer,
  p_eligible_fee_base_units numeric,
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
  created_at timestamptz,
  asset_type text,
  asset_mint text,
  asset_decimals integer
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

  if p_asset_type not in ('SOL', 'TOKEN') then
    raise exception 'Asset type must be SOL or TOKEN.';
  end if;
  if p_asset_decimals is null or p_asset_decimals < 0 or p_asset_decimals > 9 then
    raise exception 'Asset decimals must be between 0 and 9.';
  end if;
  if p_asset_type = 'SOL' and (p_asset_mint is not null or p_asset_decimals <> 9) then
    raise exception 'SOL uses 9 decimals and has no mint address.';
  end if;
  if p_asset_type = 'TOKEN' and (
    p_asset_mint is null or p_asset_mint !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
  ) then
    raise exception 'A valid SPL token mint address is required.';
  end if;
  if p_eligible_fee_base_units is null
     or p_eligible_fee_base_units <= 0
     or trunc(p_eligible_fee_base_units) <> p_eligible_fee_base_units then
    raise exception 'Eligible fee base must be a positive whole number of base units.';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) < 8 or length(p_idempotency_key) > 100 then
    raise exception 'A valid idempotency key is required.';
  end if;

  select * into v_config
  from public.resurgence_treasury_config
  where campaign_id = 'resurgence-2026';
  if not found then
    raise exception 'Configure the Master Wallet before creating a payout plan.';
  end if;

  select * into v_existing
  from public.multisplit_runs
  where idempotency_key = p_idempotency_key;

  if found then
    if v_existing.eligible_fees_lamports <> p_eligible_fee_base_units
       or v_existing.asset_type <> p_asset_type
       or v_existing.asset_mint is distinct from p_asset_mint
       or v_existing.asset_decimals <> p_asset_decimals
       or v_existing.campaign_id <> 'resurgence-2026' then
      raise exception 'This idempotency key was already used for a different payout plan.';
    end if;
    return query
      select r.id, r.eligible_fees_lamports, r.pool_bps, r.participant_bps,
             r.participant_count, r.total_pool_lamports, r.total_planned_lamports,
             r.master_wallet_address, r.status, r.created_at,
             r.asset_type, r.asset_mint, r.asset_decimals
      from public.multisplit_runs r where r.id = v_existing.id;
    return;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('resurgence-2026-allocation-rights', 0));

  select count(*)::integer into v_count
  from public.participant_allocation_rights ar
  where ar.campaign_id = 'resurgence-2026' and ar.status = 'ACTIVE';

  if v_count < 1 then
    raise exception 'No active allocation rights exist. Approve participants before creating a payout plan.';
  end if;
  if v_count > v_config.participant_cap then
    raise exception 'Active allocation rights exceed the configured 125-participant cap.';
  end if;

  v_pool := trunc(p_eligible_fee_base_units * v_config.pool_bps / 10000);
  v_each := trunc(p_eligible_fee_base_units * v_config.participant_bps / 10000);
  v_total := v_each * v_count;

  if v_each < 1 then
    raise exception 'The fee base is too small to allocate at least one base unit per participant.';
  end if;
  if v_total > v_pool then
    raise exception 'Planned allocation total exceeds the 25% Rewards Pool cap.';
  end if;

  insert into public.multisplit_runs (
    idempotency_key, campaign_id, eligible_fees_lamports, pool_bps,
    participant_bps, participant_count, total_pool_lamports,
    total_planned_lamports, master_wallet_address, status, created_by,
    asset_type, asset_mint, asset_decimals, execution_lock_until, execution_error, payout_cluster
  )
  values (
    p_idempotency_key, 'resurgence-2026', p_eligible_fee_base_units,
    v_config.pool_bps, v_config.participant_bps, v_count, v_pool,
    v_total, v_config.master_wallet_address, 'DRAFT', auth.uid(),
    p_asset_type, p_asset_mint, p_asset_decimals, null, null, null
  )
  returning id into v_run_id;

  insert into public.multisplit_items
    (run_id, participant_id, wallet_address, amount_lamports, status)
  select v_run_id, ar.participant_id, ar.wallet_address, v_each, 'PENDING'
  from public.participant_allocation_rights ar
  where ar.campaign_id = 'resurgence-2026' and ar.status = 'ACTIVE'
  order by ar.granted_at, ar.participant_id;

  return query
    select r.id, r.eligible_fees_lamports, r.pool_bps, r.participant_bps,
           r.participant_count, r.total_pool_lamports, r.total_planned_lamports,
           r.master_wallet_address, r.status, r.created_at,
           r.asset_type, r.asset_mint, r.asset_decimals
    from public.multisplit_runs r where r.id = v_run_id;
end;
$$;

-- Atomic lease prevents concurrent invocations from executing the same run.
create or replace function public.claim_resurgence_payout_run(
  p_run_id uuid,
  p_lease_seconds integer default 180
)
returns table (
  acquired boolean,
  run_status text,
  current_lock_until timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.multisplit_runs%rowtype;
  v_lease integer;
begin
  if p_run_id is null then
    raise exception 'A payout run ID is required.';
  end if;
  v_lease := least(greatest(coalesce(p_lease_seconds, 180), 30), 300);

  select * into v_run
  from public.multisplit_runs
  where id = p_run_id and campaign_id = 'resurgence-2026'
  for update;

  if not found then
    raise exception 'Payout run not found.';
  end if;

  if v_run.status = 'COMPLETED' then
    return query select false, v_run.status, v_run.execution_lock_until;
    return;
  end if;
  if v_run.status not in ('DRAFT', 'FAILED', 'PROCESSING') then
    raise exception 'This payout run cannot be executed from its current status.';
  end if;
  if v_run.status = 'PROCESSING' and v_run.execution_lock_until is not null
     and v_run.execution_lock_until > now() then
    return query select false, v_run.status, v_run.execution_lock_until;
    return;
  end if;

  update public.multisplit_runs
  set status = 'PROCESSING',
      execution_lock_until = now() + make_interval(secs => v_lease),
      execution_error = null
  where id = p_run_id;

  return query
    select true, 'PROCESSING'::text, now() + make_interval(secs => v_lease);
end;
$$;

revoke all on function public.create_resurgence_asset_payout_plan(text, text, integer, numeric, text) from public, anon;
grant execute on function public.create_resurgence_asset_payout_plan(text, text, integer, numeric, text) to authenticated;
revoke all on function public.claim_resurgence_payout_run(uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_resurgence_payout_run(uuid, integer) to service_role;


-- Allow an unbound, one-time SIWS challenge. It is bound to the returned wallet only
-- after the backend verifies the exact signed message and Ed25519 signature.
alter table public.resurgence_wallet_challenges
  alter column wallet_address drop not null;

create or replace function public.submit_resurgence_participant_application(
  p_wallet_address text,
  p_nonce uuid
)
returns table (
  participant_id uuid,
  participant_status text,
  already_registered boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_challenge public.resurgence_wallet_challenges%rowtype;
  v_participant_id uuid;
  v_status text;
begin
  if p_wallet_address is null
     or p_wallet_address !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
     or p_nonce is null then
    raise exception 'A valid wallet address and challenge nonce are required.';
  end if;

  select * into v_challenge
  from public.resurgence_wallet_challenges c
  where c.nonce = p_nonce
    and (c.wallet_address is null or c.wallet_address = p_wallet_address)
  for update;

  if not found or v_challenge.consumed_at is not null or v_challenge.expires_at <= now() then
    raise exception 'The wallet verification challenge is invalid, expired, or already used.';
  end if;

  update public.resurgence_wallet_challenges
  set consumed_at = now(),
      wallet_address = p_wallet_address
  where nonce = p_nonce;

  select p.id, p.status
  into v_participant_id, v_status
  from public.participants p
  where p.campaign_id = 'resurgence-2026'
    and p.wallet_address = p_wallet_address;

  if found then
    return query select v_participant_id, v_status, true;
    return;
  end if;

  begin
    insert into public.participants (campaign_id, wallet_address, status)
    values ('resurgence-2026', p_wallet_address, 'PENDING')
    returning id, status into v_participant_id, v_status;
  exception when unique_violation then
    select p.id, p.status
    into v_participant_id, v_status
    from public.participants p
    where p.campaign_id = 'resurgence-2026'
      and p.wallet_address = p_wallet_address;
    if not found then
      raise;
    end if;
    return query select v_participant_id, v_status, true;
    return;
  end;

  return query select v_participant_id, v_status, false;
end;
$$;

revoke all on function public.submit_resurgence_participant_application(text, uuid) from public, anon, authenticated;
grant execute on function public.submit_resurgence_participant_application(text, uuid) to service_role;
