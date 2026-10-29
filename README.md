# The Resurgence — Rewards Management Portal

A secure admin portal foundation for participant review, creator-fee allocation planning, and transparent payout-ledger tracking for Solana.

> **Safety boundary:** this repository does not transfer SOL or tokens. The portal records and previews allocation plans only. A live payout executor must not be enabled until the platform's actual fee-routing mechanism, transaction signer/custody model, fee funding, reconciliation, and end-to-end tests have been independently verified.

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
The existing Supabase schema is preserved. The migration in `supabase/migrations/` adds admin-only policies and supporting indexes. Review the SQL before applying it to another project.

## Current functionality
- Admin login and admin allowlist check.
- Participant review: approve/reject pending wallet registrations.
- Dashboard counts and recent distribution-ledger records.
- Multisplit run visibility.
- No automatic or manual on-chain transfer operation.

## Important allocation invariant
The Resurgence proposal describes 25% of an eligible creator-fee base, with a target of 125 participants at 0.2% of that same base each. That arithmetic is a design rule, not proof that Pump.fun can route creator fees to 125 addresses. The UI must not present planned allocations as paid or settled rewards.
