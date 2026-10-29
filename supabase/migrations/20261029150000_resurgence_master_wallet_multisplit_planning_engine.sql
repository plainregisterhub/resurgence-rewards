-- Admin-gated Master Wallet configuration and safe multisplit draft planner.
-- This migration intentionally does not sign or submit Solana transactions.

create table if not exists public.resurgence_treasury_config (
  campaign_id text primary key default 'resurgence-2026',
  master_wallet_address text not null,
  pool_bps integer not null default 2500 check (pool_bps = 2500),
  participant_bps integer not null default 20 check (participant_bps = 20),
  participant_cap integer not null default 125 check (participant_cap = 125),
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  constraint resurgence_treasury_master_wallet_base58
    check (master_wallet_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')
);

alter table public.resurgence_treasury_config enable row level security;
revoke all on table public.resurgence_treasury_config from anon, authenticated;
alter table public.multisplit_runs
  add column if not exists master_wallet_address text;

create or replace function public.get_resurgence_treasury_config()
returns table (
  campaign_id text,
  master_wallet_address text,
  pool_bps integer,
  participant_bps integer,
  participant_cap integer,
  updated_at timestamptz
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
    select c.campaign_id, c.master_wallet_address, c.pool_bps,
           c.participant_bps, c.participant_cap, c.updated_at
    from public.resurgence_treasury_config c
    where c.campaign_id = 'resurgence-2026';
end;
$$;

create or replace function public.save_resurgence_treasury_config(p_master_wallet_address text)
returns table (
  campaign_id text,
  master_wallet_address text,
  pool_bps integer,
  participant_bps integer,
  participant_cap integer,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_resurgence_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  if p_master_wallet_address is null
     or p_master_wallet_address !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' then
    raise exception 'Enter a valid-format Solana public address (32–44 Base58 characters).';
  end if;

  insert into public.resurgence_treasury_config
    (campaign_id, master_wallet_address, pool_bps, participant_bps, participant_cap, updated_by, updated_at)
  values
    ('resurgence-2026', p_master_wallet_address, 2500, 20, 125, auth.uid(), now())
  on conflict (campaign_id) do update
    set master_wallet_address = excluded.master_wallet_address,
        pool_bps = excluded.pool_bps,
        participant_bps = excluded.participant_bps,
        participant_cap = excluded.participant_cap,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at;

  return query
    select c.campaign_id, c.master_wallet_address, c.pool_bps,
           c.participant_bps, c.participant_cap, c.updated_at
    from public.resurgence_treasury_config c
    where c.campaign_id = 'resurgence-2026';
end;
$$;

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

  if p_eligible_fees_lamports is null
     or p_eligible_fees_lamports <= 0
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
    raise exception 'Save the Master Wallet address before creating a plan.';
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

  select count(*)::integer into v_count
  from public.participants p
  where p.campaign_id = 'resurgence-2026' and p.status = 'APPROVED';

  if v_count < 1 then
    raise exception 'At least one approved participant is required to create a draft plan.';
  end if;
  if v_count > v_config.participant_cap then
    raise exception 'Approved participants exceed the 125-wallet pool cap.';
  end if;

  v_pool := trunc(p_eligible_fees_lamports * v_config.pool_bps / 10000);
  v_each := trunc(p_eligible_fees_lamports * v_config.participant_bps / 10000);
  v_total := v_each * v_count;

  if v_each < 1 then
    raise exception 'Eligible fee base is too small to allocate at least one lamport per participant.';
  end if;
  if v_total > v_pool then
    raise exception 'Planned participant total exceeds the Rewards Pool cap.';
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

  insert into public.multisplit_items
    (run_id, participant_id, wallet_address, amount_lamports, status)
  select v_run_id, p.id, p.wallet_address, v_each, 'PENDING'
  from public.participants p
  where p.campaign_id = 'resurgence-2026' and p.status = 'APPROVED'
  order by p.submitted_at, p.id;

  return query
    select r.id, r.eligible_fees_lamports, r.pool_bps, r.participant_bps,
           r.participant_count, r.total_pool_lamports, r.total_planned_lamports,
           r.master_wallet_address, r.status, r.created_at
    from public.multisplit_runs r where r.id = v_run_id;
end;
$$;

revoke all on function public.get_resurgence_treasury_config() from public, anon;
revoke all on function public.save_resurgence_treasury_config(text) from public, anon;
revoke all on function public.create_resurgence_multisplit_plan(numeric, text) from public, anon;
grant execute on function public.get_resurgence_treasury_config() to authenticated;
grant execute on function public.save_resurgence_treasury_config(text) to authenticated;
grant execute on function public.create_resurgence_multisplit_plan(numeric, text) to authenticated;
