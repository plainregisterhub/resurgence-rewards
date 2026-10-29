import { createClient } from "https://esm.sh/@supabase/supabase-js@2.58.0";

const allowedOrigins = new Set(["https://plainregisterhub.github.io", "http://localhost:5173"]);
const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ed25519SpkiPrefix = new Uint8Array([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]);

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
    const nonce = typeof body.nonce === "string" ? body.nonce : "";
    const signatureBase64 = typeof body.signature === "string" ? body.signature : "";
    const publicKeyBytes = decodeBase58(walletAddress);
    if (!publicKeyBytes || publicKeyBytes.length !== 32 || !/^[0-9a-f-]{36}$/i.test(nonce)) {
      return json({ error: "Invalid wallet verification request." }, 400, origin);
    }

    let signatureBytes: Uint8Array;
    try {
      signatureBytes = Uint8Array.from(atob(signatureBase64), (character) => character.charCodeAt(0));
    } catch {
      return json({ error: "Wallet signature is not valid base64." }, 400, origin);
    }
    if (signatureBytes.length !== 64) return json({ error: "Wallet signature has an invalid length." }, 400, origin);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) return json({ error: "Wallet verification service is not configured." }, 500, origin);
    const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });

    const { data: challenge, error: challengeError } = await admin.from("resurgence_wallet_challenges")
      .select("message,expires_at,consumed_at").eq("wallet_address", walletAddress).eq("nonce", nonce).maybeSingle();
    if (challengeError || !challenge) return json({ error: "Verification challenge not found. Please reconnect and try again." }, 400, origin);
    if (challenge.consumed_at || new Date(challenge.expires_at).getTime() <= Date.now()) {
      return json({ error: "Verification challenge expired or already used. Please try again." }, 400, origin);
    }

    let validSignature = false;
    try {
      const spki = new Uint8Array(ed25519SpkiPrefix.length + publicKeyBytes.length);
      spki.set(ed25519SpkiPrefix, 0);
      spki.set(publicKeyBytes, ed25519SpkiPrefix.length);
      const publicKey = await crypto.subtle.importKey("spki", spki, { name: "Ed25519" }, false, ["verify"]);
      validSignature = await crypto.subtle.verify({ name: "Ed25519" }, publicKey, signatureBytes, new TextEncoder().encode(challenge.message));
    } catch {
      validSignature = false;
    }
    if (!validSignature) return json({ error: "The wallet signature could not be verified. No application was created." }, 401, origin);

    const { data, error } = await admin.rpc("submit_resurgence_participant_application", {
      p_wallet_address: walletAddress, p_nonce: nonce,
    });
    if (error) {
      const message = error.message.toLowerCase();
      if (message.includes("invalid, expired") || message.includes("already used")) {
        return json({ error: "Verification challenge expired or already used. Please try again." }, 400, origin);
      }
      return json({ error: "The application could not be saved. Please retry with a new signature." }, 500, origin);
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return json({ error: "The application was not saved. Please retry." }, 500, origin);
    return json({ success: true, alreadyRegistered: Boolean(row.already_registered), participant: {
      id: row.participant_id, status: row.participant_status,
    }}, 200, origin);
  } catch {
    return json({ error: "Invalid request. Please reconnect and try again." }, 400, origin);
  }
});
