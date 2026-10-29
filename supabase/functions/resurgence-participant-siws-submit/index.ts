import { createClient } from "https://esm.sh/@supabase/supabase-js@2.58.0";

const allowedOrigins = new Set(["https://plainregisterhub.github.io", "http://localhost:5173"]);
const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ed25519SpkiPrefix = new Uint8Array([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]);

function decodeBase58(value: string): Uint8Array | null {
  if (!value || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(value)) return null;
  let number = 0n;
  for (const char of value) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) return null;
    number = number * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (number > 0n) {
    bytes.unshift(Number(number & 255n));
    number >>= 8n;
  }
  for (const char of value) {
    if (char !== "1") break;
    bytes.unshift(0);
  }
  return new Uint8Array(bytes);
}

function decodeBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function json(data: unknown, status = 200, origin?: string | null) {
  return new Response(JSON.stringify(data), { status, headers: {
    "Content-Type": "application/json", "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": origin && allowedOrigins.has(origin) ? origin : "https://plainregisterhub.github.io",
    "Vary": "Origin", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  }});
}

function toIso(value: string): string {
  return new Date(value).toISOString();
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
    const signature = typeof body.signature === "string" ? decodeBase64(body.signature) : null;
    const signedMessage = typeof body.signedMessage === "string" ? decodeBase64(body.signedMessage) : null;
    const publicKeyBytes = decodeBase58(walletAddress);
    if (!publicKeyBytes || publicKeyBytes.length !== 32 || !/^[0-9a-f-]{36}$/i.test(nonce)) {
      return json({ error: "Invalid sign-in verification request." }, 400, origin);
    }
    if (!signature || signature.length !== 64 || !signedMessage || signedMessage.length > 4096) {
      return json({ error: "The wallet returned an invalid sign-in signature or message." }, 400, origin);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) return json({ error: "Wallet verification service is not configured." }, 500, origin);
    const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });

    const { data: challenge, error: challengeError } = await admin
      .from("resurgence_wallet_challenges")
      .select("message,created_at,expires_at,consumed_at,wallet_address")
      .eq("nonce", nonce)
      .is("wallet_address", null)
      .maybeSingle();
    if (challengeError || !challenge) return json({ error: "Sign-in challenge not found. Please retry." }, 400, origin);
    if (challenge.consumed_at || new Date(challenge.expires_at).getTime() <= Date.now()) {
      return json({ error: "Sign-in challenge expired or was already used. Please retry." }, 400, origin);
    }

    let input: {
      domain?: string;
      statement?: string;
      uri?: string;
      version?: string;
      chainId?: string;
      nonce?: string;
      issuedAt?: string;
      expirationTime?: string;
    };
    try {
      input = JSON.parse(challenge.message);
    } catch {
      return json({ error: "Stored sign-in challenge is malformed." }, 500, origin);
    }
    const expectedUri = origin === "http://localhost:5173"
      ? "http://localhost:5173/?view=participant"
      : "https://plainregisterhub.github.io/resurgence-rewards/?view=participant";
    if (
      input.domain !== new URL(expectedUri).host ||
      input.uri !== expectedUri ||
      input.version !== "1" ||
      input.chainId !== "mainnet" ||
      input.nonce !== nonce.replaceAll("-", "") ||
      input.issuedAt !== toIso(challenge.created_at) ||
      input.expirationTime !== toIso(challenge.expires_at) ||
      !input.statement
    ) {
      return json({ error: "Sign-in challenge did not match the expected domain, nonce or expiry." }, 401, origin);
    }

    const expectedMessage = [
      `${input.domain} wants you to sign in with your Solana account:`,
      walletAddress,
      "",
      input.statement,
      "",
      `URI: ${input.uri}`,
      `Version: ${input.version}`,
      `Chain ID: ${input.chainId}`,
      `Nonce: ${input.nonce}`,
      `Issued At: ${input.issuedAt}`,
      `Expiration Time: ${input.expirationTime}`,
    ].join("\n");
    const actualMessage = new TextDecoder().decode(signedMessage);
    if (actualMessage !== expectedMessage) {
      return json({ error: "The signed SIWS message does not match this one-time request." }, 401, origin);
    }

    let validSignature = false;
    try {
      const spki = new Uint8Array(ed25519SpkiPrefix.length + publicKeyBytes.length);
      spki.set(ed25519SpkiPrefix, 0);
      spki.set(publicKeyBytes, ed25519SpkiPrefix.length);
      const publicKey = await crypto.subtle.importKey("spki", spki, { name: "Ed25519" }, false, ["verify"]);
      validSignature = await crypto.subtle.verify({ name: "Ed25519" }, publicKey, signature, signedMessage);
    } catch {
      validSignature = false;
    }
    if (!validSignature) return json({ error: "Wallet signature verification failed. No application was created." }, 401, origin);

    const { data, error: submitError } = await admin.rpc("submit_resurgence_participant_application", {
      p_wallet_address: walletAddress,
      p_nonce: nonce,
    });
    if (submitError) {
      const message = submitError.message.toLowerCase();
      if (message.includes("invalid, expired") || message.includes("already used")) {
        return json({ error: "Sign-in challenge expired or was already used. Please retry." }, 400, origin);
      }
      return json({ error: "The application could not be saved. Please retry sign-in." }, 500, origin);
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return json({ error: "The application was not saved. Please retry." }, 500, origin);
    return json({
      success: true,
      alreadyRegistered: Boolean(row.already_registered),
      participant: { id: row.participant_id, status: row.participant_status },
    }, 200, origin);
  } catch {
    return json({ error: "Invalid sign-in request. Please reconnect and retry." }, 400, origin);
  }
});
