-- Ensure campaign-scoped wallet uniqueness while reusing the schema's existing index name when present.
-- Solana wallet addresses are case-sensitive, so retain exact-address matching.
create unique index if not exists participants_campaign_id_wallet_address_key
  on public.participants (campaign_id, wallet_address);
