-- Secure, one-time Solana wallet proof for public participant applications.
create table if not exists public.resurgence_wallet_challenges (
  nonce uuid primary key,
  wallet_address text not null check (wallet_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  message text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  constraint resurgence_wallet_challenges_expiry_check check (expires_at > created_at),
  constraint resurgence_wallet_challenges_nonce_wallet_key unique (nonce, wallet_address)
);

create index if not exists resurgence_wallet_challenges_expiry_idx
  on public.resurgence_wallet_challenges (expires_at);
create index if not exists resurgence_wallet_challenges_wallet_created_idx
  on public.resurgence_wallet_challenges (wallet_address, created_at desc);

alter table public.resurgence_wallet_challenges enable row level security;
revoke all on table public.resurgence_wallet_challenges from public, anon, authenticated;

-- The Edge Function verifies the Ed25519 signature before calling this one-time submission RPC.
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
    and c.wallet_address = p_wallet_address
  for update;

  if not found or v_challenge.consumed_at is not null or v_challenge.expires_at <= now() then
    raise exception 'The wallet verification challenge is invalid, expired, or already used.';
  end if;

  update public.resurgence_wallet_challenges
  set consumed_at = now()
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
