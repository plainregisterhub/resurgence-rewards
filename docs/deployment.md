# Deployment & first-admin setup

## 1. Configure the frontend
- Copy `.env.example` to `.env.local`.
- Set the Supabase project URL and **publishable/anon** key in the local environment.
- Never expose a service-role key, wallet private key, or seed phrase in client code, GitHub, or browser storage.

## 2. Apply the database migrations
Review and apply the files in `supabase/migrations/` in filename order. These migrations install the admin-only RLS policies, move the admin check helper into the non-exposed `private` schema, enforce campaign-scoped wallet uniqueness, and remove redundant duplicate constraints. They do not delete participant or ledger rows. Confirm the Security Advisor and test with both an admin and a non-admin account.

## 3. Create the first admin
1. In Supabase Authentication, create the designated operator account (or sign up through a trusted auth flow).
2. Copy the user's UUID from Authentication → Users.
3. In the SQL Editor, run this statement after replacing the placeholder with that exact UUID:

```sql
insert into public.admin_users (user_id)
values ('REPLACE_WITH_AUTH_USER_UUID'::uuid)
on conflict (user_id) do nothing;
```

Admin provisioning is deliberately not available from the public frontend. Only someone with project-level database access should grant an admin role.

## 4. Build and host
Run `npm ci` (if a lockfile exists; otherwise `npm install`), then `npm run build`. The GitHub Pages workflow builds from this repository when configured/enabled. In repository Settings → Pages, choose GitHub Actions.

For GitHub Actions, add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as repository Actions variables. They are publishable client values; all sensitive authority must remain server-side.

## 5. On-chain payout boundary
This build is a management portal and allocation ledger only. Do not deploy a transfer function until fee source/routing, signer custody, fee funding, transaction simulation, duplicate prevention, confirmation/reconciliation, and failure handling are verified. A database percentage does not make Pump.fun route fees to 125 wallets automatically.
