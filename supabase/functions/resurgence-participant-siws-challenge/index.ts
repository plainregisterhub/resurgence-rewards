import { createClient } from "https://esm.sh/@supabase/supabase-js@2.58.0";

const allowedOrigins = new Set(["https://plainregisterhub.github.io", "http://localhost:5173"]);
const canonicalStatements = "Signing verifies wallet ownership only. It does not authorize a SOL or token transfer.";

function json(data: unknown, status = 200, origin?: string | null) {
  return new Response(JSON.stringify(data), { status, headers: {
    "Content-Type": "application/json", "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": origin && allowedOrigins.has(origin) ? origin : "https://plainregisterhub.github.io",
    "Vary": "Origin", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  }});
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  if (origin && !allowedOrigins.has(origin)) return json({ error: "Origin not allowed." }, 403, origin);
  if (req.method === "OPTIONS") return json({ ok: true }, 200, origin);
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405, origin);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) return json({ error: "Wallet verification service is not configured." }, 500, origin);
    const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });

    // Unbound challenges are rate-limited independently from legacy wallet-bound challenges.
    const windowStart = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { count, error: rateError } = await admin
      .from("resurgence_wallet_challenges")
      .select("nonce", { count: "exact", head: true })
      .is("wallet_address", null)
      .gte("created_at", windowStart);
    if (rateError) return json({ error: "Unable to prepare sign-in. Please retry." }, 500, origin);
    if ((count ?? 0) >= 300) return json({ error: "Too many wallet sign-in attempts. Please wait a few minutes." }, 429, origin);

    const uri = origin === "http://localhost:5173"
      ? "http://localhost:5173/?view=participant"
      : "https://plainregisterhub.github.io/resurgence-rewards/?view=participant";
    const domain = new URL(uri).host;
    const nonce = crypto.randomUUID();
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + 5 * 60 * 1000);
    const signInInput = {
      domain,
      statement: canonicalStatements,
      uri,
      version: "1",
      chainId: "mainnet",
      nonce: nonce.replaceAll("-", ""),
      issuedAt: issuedAt.toISOString(),
      expirationTime: expiresAt.toISOString(),
    };

    const { error } = await admin.from("resurgence_wallet_challenges").insert({
      nonce,
      wallet_address: null,
      message: JSON.stringify(signInInput),
      created_at: issuedAt.toISOString(),
      expires_at: expiresAt.toISOString(),
    });
    if (error) return json({ error: "Unable to create a one-time sign-in challenge. Please retry." }, 500, origin);
    return json({ nonce, input: signInInput, expiresAt: expiresAt.toISOString() }, 200, origin);
  } catch {
    return json({ error: "Unable to prepare wallet sign-in. Please retry." }, 400, origin);
  }
});
