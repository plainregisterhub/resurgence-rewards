-- Restrict client API privileges to the operations used by the browser portal.
-- RLS policies remain enabled. This migration changes grants only; it does not modify rows.
revoke all privileges on table
  public.admin_users,
  public.participants,
  public.distribution_records,
  public.multisplit_runs,
  public.multisplit_items
from anon;

-- RLS does not constrain TRUNCATE. Remove it and other unnecessary table privileges.
revoke delete, truncate, references, trigger
  on table public.participants
  from authenticated;

revoke insert, update, delete, truncate, references, trigger
  on table public.admin_users
  from authenticated;

-- The current browser portal only reads the distribution ledger and allocation run summaries.
revoke insert, update, delete, truncate, references, trigger
  on table public.distribution_records
  from authenticated;

revoke insert, update, delete, truncate, references, trigger
  on table public.multisplit_runs
  from authenticated;

-- multsplit_items is not accessed directly by the browser client.
revoke all privileges on table public.multisplit_items
  from authenticated;

-- Explicitly document the privileges the UI currently needs.
grant select on table public.admin_users to authenticated;
grant select, insert, update on table public.participants to authenticated;
grant select on table public.distribution_records to authenticated;
grant select on table public.multisplit_runs to authenticated;
