# The Resurgence — Rewards Management Portal

A secure admin portal foundation for participant review, creator-fee allocation planning, and transparent payout-ledger tracking for Solana.

> **Safety boundary:** this repository now includes a guarded SOL/classic SPL payout executor. It remains disabled unless server-side configuration explicitly enables it. Mainnet is additionally locked unless `RESURGENCE_PAYOUT_MAINNET_ENABLED=true`. A planned creator-fee base is still an admin-provided input and is not proof that Pump.fun has routed those fees to the Master Wallet. Never place a seed phrase or private key in GitHub, frontend code, or ordinary database records.

## Stack
- React + TypeScript + Vite
- Supabase Auth + Postgres with Row Level Security
- Static-site compatible; deployable to GitHub Pages after configuration

## Local setup
1. Install Node.js 20+ and npm.
2. Copy `.env.example` to `.env.local`.
3. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` from Supabase Project Settings → API.
4. Run `npm install`, then `npm run dev`.
5. Create an admin user through Supabase Auth, then add that user's UUID to `public.admin_users` using the SQL in `docs/deployment.md`.

Never put a Supabase service-role key, wallet secret key, or seed phrase in this frontend or GitHub.

## Database
The existing Supabase schema is preserved. The migrations in `supabase/migrations/` add admin-only policies, supporting indexes, and campaign-scoped wallet uniqueness. Review the SQL before applying them to another project.

## Current functionality
- Admin login and admin allowlist check.
- Participant wallet registration with a one-time SIWS endpoint when the injected wallet supports it; legacy Phantom deep-link + signed-message flow remains the mobile fallback.
- Participant review: approve/reject pending wallet registrations.
- Allocation Rights register with a 125-recipient cap and 0.2% entitlement records.
- Asset-aware payout planning for native SOL or classic SPL tokens.
- Guarded server-side payout executor with size-aware transaction batches, signer/master-wallet match checks, balance validation, saved signed transactions, signature confirmation and payout-item reconciliation.
- Cluster-aware distribution ledger and an isolated 125-recipient SOL/SPL local-validator smoke test.

## Payout configuration (server-side only)
The Edge Function `resurgence-payout-execute` expects:
- `RESURGENCE_PAYOUT_ENABLED=true`
- `RESURGENCE_PAYOUT_SECRET_KEY`: a 64-byte Solana keypair encoded as a Base58 secret key or a JSON array of 64 bytes.
- `RESURGENCE_PAYOUT_CLUSTER=devnet` for initial tests.
- `RESURGENCE_PAYOUT_MAINNET_ENABLED=true` only after mainnet readiness checks.
- Optional `SOLANA_RPC_URL` for a suitable HTTPS RPC provider.

The signer public key must match the Master Wallet snapshot in the payout run and the current treasury configuration. The service-role key and payout signer belong only in Supabase Edge Function secrets. Importing a Phantom private key into a server-side secret hands the backend signing authority over that wallet; consider a dedicated payout wallet and fund it only with the amount required for approved payouts. Do not enable Mainnet before the Devnet/local-validator tests, signer custody decisions, fee-base verification, and recipient reconciliation have been reviewed.

Apply the matching SQL migration before deploying the three new Edge Functions. Mobile Phantom must still be verified on a real device; SIWS is only used when the injected provider advertises `signIn`.

## Important allocation invariant
The Resurgence proposal describes 25% of an eligible creator-fee base, with a target of 125 participants at 0.2% of that same base each. That arithmetic is a design rule, not proof that Pump.fun can route creator fees to 125 addresses. The UI must not present planned allocations as paid or settled rewards.
