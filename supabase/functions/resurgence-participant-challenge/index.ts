import { createClient } from "https://esm.sh/@supabase/supabase-js@2.58.0";

const allowedOrigins = new Set(["https://plainregisterhub.github.io", "http://localhost:5173"]);
const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function decodeBase58(value: string): Uint8Array | null {
  let number = 0n;
  for (const char of value) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) return null;
    number = number * 58n + BigInt(digit);
  }
  let hex = number === 0n ? "" : number.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  const leadingZeros = value.match(/^1+/)?.[0].length ?? 0;
  const output = new Uint8Array(leadingZeros + bytes.length);
  output.set(bytes, leadingZeros);
  return output;
}

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
    const body = await req.json();
    const walletAddress = typeof body.walletAddress === "string" ? body.walletAddress.trim() : "";
    const publicKey = decodeBase58(walletAddress);
    if (!publicKey || publicKey.length !== 32) return json({ error: "Enter a valid Solana wallet address." }, 400, origin);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) return json({ error: "Wallet verification service is not configured." }, 500, origin);
    const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });

    const windowStart = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { count, error: rateError } = await admin.from("resurgence_wallet_challenges")
      .select("nonce", { count: "exact", head: true }).eq("wallet_address", walletAddress).gte("created_at", windowStart);
    if (rateError) return json({ error: "Unable to prepare wallet verification. Please retry." }, 500, origin);
    if ((count ?? 0) >= 5) return json({ error: "Too many verification attempts for this wallet. Please wait a few minutes." }, 429, origin);

    const nonce = crypto.randomUUID();
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + 10 * 60 * 1000);
    const message = [
      "THE RESURGENCE — PARTICIPANT WALLET VERIFICATION",
      "Domain: plainregisterhub.github.io/resurgence-rewards",
      "Campaign: resurgence-2026",
      `Wallet: ${walletAddress}`,
      `Nonce: ${nonce}`,
      `Issued At: ${issuedAt.toISOString()}`,
      `Expires At: ${expiresAt.toISOString()}`,
      "",
      "This signature proves control of this wallet only.",
      "It does not authorize or initiate any SOL transfer or token transaction.",
    ].join("\n");

    const { error } = await admin.from("resurgence_wallet_challenges").insert({
      nonce, wallet_address: walletAddress, message,
      created_at: issuedAt.toISOString(), expires_at: expiresAt.toISOString(),
    });
    if (error) return json({ error: "Unable to create wallet verification challenge. Please retry." }, 500, origin);
    return json({ nonce, message, expiresAt: expiresAt.toISOString() }, 200, origin);
  } catch {
    return json({ error: "Invalid request. Please retry wallet verification." }, 400, origin);
  }
});
