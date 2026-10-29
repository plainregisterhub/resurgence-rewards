-- Prevent the same wallet from being registered twice in one campaign.
-- Solana wallet addresses are case-sensitive, so retain exact-address matching.
create unique index if not exists idx_participants_campaign_wallet_unique
  on public.participants (campaign_id, wallet_address);
