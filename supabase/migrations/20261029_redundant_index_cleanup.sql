-- Remove redundant uniqueness objects while preserving the canonical constraints.
drop index if exists public.idx_participants_campaign_wallet_unique;
alter table public.multisplit_items
  drop constraint if exists multisplit_items_run_participant_key;
