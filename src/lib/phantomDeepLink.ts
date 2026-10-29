import nacl from "tweetnacl";

const PENDING_KEY = "resurgence.phantom.pending";
const CONNECTION_KEY = "resurgence.phantom.connection";
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export type PhantomConnection = {
  walletAddress: string;
  session: string;
  dappPublicKey: string;
  dappSecretKey: string;
  phantomEncryptionPublicKey: string;
};

type PendingRequest = {
  action: "connect" | "sign";
  state: string;
  dappPublicKey?: string;
  dappSecretKey?: string;
  walletAddress?: string;
  challengeNonce?: string;
};

export type PhantomCallbackResult =
  | { type: "connected"; walletAddress: string }
  | { type: "signed"; walletAddress: string; challengeNonce: string; signature: Uint8Array }
  | { type: "error"; message: string };

function bytesToBase58(bytes: Uint8Array): string {
  if (!bytes.length) return "";
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) + BigInt(byte);
  let encoded = "";
  while (value > 0n) {
    const remainder = Number(value % 58n);
    encoded = BASE58_ALPHABET[remainder] + encoded;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = "1" + encoded;
  }
  return encoded || "1";
}

function base58ToBytes(value: string): Uint8Array {
  if (!value) return new Uint8Array();
  let number = 0n;
  for (const char of value) {
    const digit = BASE58_ALPHABET.indexOf(char);
    if (digit < 0) throw new Error("Phantom returned data in an invalid format.");
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

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function randomState(): string {
  return toBase64(nacl.randomBytes(24)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function currentCallbackUrl(action: PendingRequest["action"], state: string): string {
  const callback = new URL(window.location.href);
  callback.searchParams.set("view", "participant");
  callback.searchParams.set("phantom_callback", action);
  callback.searchParams.set("phantom_state", state);
  callback.hash = "";
  return callback.toString();
}

function getPending(): PendingRequest | null {
  try {
    const value = localStorage.getItem(PENDING_KEY);
    return value ? JSON.parse(value) as PendingRequest : null;
  } catch {
    return null;
  }
}

function savePending(value: PendingRequest): void {
  localStorage.setItem(PENDING_KEY, JSON.stringify(value));
}

export function getPhantomConnection(): PhantomConnection | null {
  try {
    const raw = localStorage.getItem(CONNECTION_KEY);
    if (!raw) return null;
    const connection = JSON.parse(raw) as PhantomConnection;
    if (!connection.walletAddress || !connection.session || !connection.dappSecretKey || !connection.phantomEncryptionPublicKey) return null;
    return connection;
  } catch {
    return null;
  }
}

function launch(url: URL): boolean {
  // Navigate the current tab so Phantom's redirect returns to the same portal
  // context. The pending state is also kept in localStorage to survive mobile
  // browser tab/app handoffs.
  try {
    window.location.assign(url.toString());
    return true;
  } catch {
    return false;
  }
}

export function launchPhantomConnect(): boolean {
  const keyPair = nacl.box.keyPair();
  const state = randomState();
  const dappPublicKey = bytesToBase58(keyPair.publicKey);
  const dappSecretKey = toBase64(keyPair.secretKey);
  const pending: PendingRequest = {
    action: "connect",
    state,
    dappPublicKey,
    dappSecretKey,
  };
  savePending(pending);

  const params = new URLSearchParams({
    app_url: window.location.origin + window.location.pathname,
    dapp_encryption_public_key: dappPublicKey,
    redirect_link: currentCallbackUrl("connect", state),
    cluster: "mainnet-beta",
  });
  return launch(new URL("https://phantom.app/ul/v1/connect?" + params.toString()));
}

export function launchPhantomSignMessage(
  message: string,
  connection: PhantomConnection,
  challengeNonce: string,
): boolean {
  const state = randomState();
  savePending({
    action: "sign",
    state,
    walletAddress: connection.walletAddress,
    challengeNonce,
  });

  const sharedSecret = nacl.box.before(
    base58ToBytes(connection.phantomEncryptionPublicKey),
    fromBase64(connection.dappSecretKey),
  );
  const encryptionNonce = nacl.randomBytes(24);
  const payloadBytes = new TextEncoder().encode(JSON.stringify({
    message: bytesToBase58(new TextEncoder().encode(message)),
    session: connection.session,
    display: "utf8",
  }));
  const encryptedPayload = nacl.box.after(payloadBytes, encryptionNonce, sharedSecret);
  const params = new URLSearchParams({
    dapp_encryption_public_key: connection.dappPublicKey,
    nonce: bytesToBase58(encryptionNonce),
    redirect_link: currentCallbackUrl("sign", state),
    payload: bytesToBase58(encryptedPayload),
  });
  return launch(new URL("https://phantom.app/ul/v1/signMessage?" + params.toString()));
}

function decryptResponse(data: string, nonce: string, sharedSecret: Uint8Array): string {
  const decrypted = nacl.box.open.after(base58ToBytes(data), base58ToBytes(nonce), sharedSecret);
  if (!decrypted) throw new Error("Phantom's response could not be verified. Please reconnect and try again.");
  return new TextDecoder().decode(decrypted);
}

function cleanCallbackUrl(): void {
  const url = new URL(window.location.href);
  [
    "phantom_callback", "phantom_state", "phantom_encryption_public_key",
    "nonce", "data", "errorCode", "errorMessage",
  ].forEach((key) => url.searchParams.delete(key));
  window.history.replaceState({}, document.title, url.toString());
}

export async function consumePhantomCallback(): Promise<PhantomCallbackResult | null> {
  const url = new URL(window.location.href);
  const action = url.searchParams.get("phantom_callback");
  if (action !== "connect" && action !== "sign") return null;

  const returnedState = url.searchParams.get("phantom_state");
  const pending = getPending();
  cleanCallbackUrl();

  if (!pending || pending.action !== action || !returnedState || returnedState !== pending.state) {
    localStorage.removeItem(PENDING_KEY);
    return { type: "error", message: "This Phantom response could not be matched to the request. Please connect again." };
  }

  const errorCode = url.searchParams.get("errorCode");
  if (errorCode) {
    localStorage.removeItem(PENDING_KEY);
    return { type: "error", message: url.searchParams.get("errorMessage") || "The wallet request was cancelled or rejected." };
  }

  const nonce = url.searchParams.get("nonce");
  const data = url.searchParams.get("data");
  if (!nonce || !data) {
    localStorage.removeItem(PENDING_KEY);
    return { type: "error", message: "Phantom returned an incomplete response. Please try again." };
  }

  try {
    if (action === "connect") {
      const phantomPublicKey = url.searchParams.get("phantom_encryption_public_key");
      if (!phantomPublicKey || !pending.dappPublicKey || !pending.dappSecretKey) {
        throw new Error("Phantom did not return the connection details needed to continue.");
      }
      const sharedSecret = nacl.box.before(base58ToBytes(phantomPublicKey), fromBase64(pending.dappSecretKey));
      const response = JSON.parse(decryptResponse(data, nonce, sharedSecret)) as { public_key?: string; session?: string };
      if (!response.public_key || !response.session) throw new Error("Phantom returned an incomplete wallet session.");
      const connection: PhantomConnection = {
        walletAddress: response.public_key,
        session: response.session,
        dappPublicKey: pending.dappPublicKey,
        dappSecretKey: pending.dappSecretKey,
        phantomEncryptionPublicKey: phantomPublicKey,
      };
      localStorage.setItem(CONNECTION_KEY, JSON.stringify(connection));
      localStorage.removeItem(PENDING_KEY);
      return { type: "connected", walletAddress: response.public_key };
    }

    const connection = getPhantomConnection();
    if (!connection || !pending.walletAddress || !pending.challengeNonce) {
      throw new Error("The wallet session is missing. Please reconnect and try again.");
    }
    const sharedSecret = nacl.box.before(
      base58ToBytes(connection.phantomEncryptionPublicKey),
      fromBase64(connection.dappSecretKey),
    );
    const response = JSON.parse(decryptResponse(data, nonce, sharedSecret)) as { signature?: string };
    if (!response.signature) throw new Error("Phantom did not return a message signature.");
    const signature = base58ToBytes(response.signature);
    if (signature.length !== 64) throw new Error("Phantom returned an invalid signature.");
    localStorage.removeItem(PENDING_KEY);
    return {
      type: "signed",
      walletAddress: pending.walletAddress,
      challengeNonce: pending.challengeNonce,
      signature,
    };
  } catch (cause) {
    localStorage.removeItem(PENDING_KEY);
    return {
      type: "error",
      message: cause instanceof Error ? cause.message : "Unable to finish the Phantom request. Please try again.",
    };
  }
}
