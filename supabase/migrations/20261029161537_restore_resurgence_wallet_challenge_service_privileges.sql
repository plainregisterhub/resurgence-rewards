-- Restore only the backend privileges required for rate-limit checks and challenge creation.
-- Keep wallet challenge rows inaccessible to anon and authenticated roles.
GRANT SELECT, INSERT ON TABLE public.resurgence_wallet_challenges TO service_role;
