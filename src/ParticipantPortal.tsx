import { useEffect, useRef, useState } from "react";
import { ArrowLeft, CheckCircle2, CircleAlert, Clock3, LockKeyhole, ShieldCheck, Wallet } from "lucide-react";
import { supabase, supabaseConfigured } from "./lib/supabase";
import {
  consumePhantomCallback,
  getPhantomConnection,
  launchPhantomConnect,
  launchPhantomSignMessage,
} from "./lib/phantomDeepLink";

type WalletPublicKey = { toBase58(): string };
type WalletSignResult = Uint8Array | { signature: Uint8Array };
type WalletSignInInput = {
  domain?: string;
  statement?: string;
  uri?: string;
  version?: string;
  chainId?: string;
  nonce?: string;
  issuedAt?: string;
  expirationTime?: string;
};
type WalletSignInOutput = {
  account?: { address?: string; publicKey?: Uint8Array };
  signature: Uint8Array;
  signedMessage: Uint8Array;
};
type SolanaWalletProvider = {
  isPhantom?: boolean;
  publicKey?: WalletPublicKey | null;
  connect: () => Promise<{ publicKey?: WalletPublicKey }>;
  signMessage?: (message: Uint8Array, display?: "utf8") => Promise<WalletSignResult>;
  signIn?: (input: WalletSignInInput) => Promise<WalletSignInOutput>;
  disconnect?: () => Promise<void>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  off?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
};

declare global {
  interface Window {
    solana?: SolanaWalletProvider;
    phantom?: { solana?: SolanaWalletProvider };
  }
}

function getWalletProvider(): SolanaWalletProvider | null {
  if (typeof window === "undefined") return null;
  return window.phantom?.solana ?? window.solana ?? null;
}

async function readFunctionError(error: unknown): Promise<string> {
  const fallback = error instanceof Error ? error.message : "The request could not be completed. Please retry.";
  const context = (error as { context?: Response } | null)?.context;
  if (!context || typeof context.json !== "function") return fallback;
  try {
    const details = await context.json() as { error?: string };
    return details.error || fallback;
  } catch {
    return fallback;
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export default function ParticipantPortal() {
  const [walletAddress, setWalletAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [applicationStatus, setApplicationStatus] = useState("");
  const [alreadyRegistered, setAlreadyRegistered] = useState(false);
  const callbackHandled = useRef(false);

  // Restore an already-authorized injected wallet when the portal opens inside Phantom.
  // This keeps the participant in one browser context for connect + sign.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("phantom_callback")) return;
    const provider = getWalletProvider();
    if (!provider) return;

    const toAddress = (candidate: unknown): string => {
      if (candidate && typeof candidate === "object" &&
          typeof (candidate as WalletPublicKey).toBase58 === "function") {
        return (candidate as WalletPublicKey).toBase58();
      }
      return provider.publicKey?.toBase58() ?? "";
    };

    const existingAddress = provider.publicKey?.toBase58() ?? "";
    if (existingAddress) {
      setWalletAddress(existingAddress);
      setNotice("Wallet detected. Tap Connect Wallet to complete verification and submit your application automatically.");
    }

    const handleConnect = (...args: unknown[]) => {
      const address = toAddress(args[0]);
      if (!address) return;
      setWalletAddress(address);
      setError("");
      setNotice("Wallet connected. Verification will continue automatically when you tap Connect Wallet.");
    };
    const handleAccountChanged = (...args: unknown[]) => {
      const address = args[0] == null ? "" : toAddress(args[0]);
      setError("");
      setApplicationStatus("");
      setAlreadyRegistered(false);
      if (!address) {
        setWalletAddress("");
        setNotice("Wallet disconnected. Connect again to continue.");
        return;
      }
      setWalletAddress(address);
      setNotice("Wallet account changed. Check the address before submitting your application.");
    };
    const handleDisconnect = () => {
      setWalletAddress("");
      setApplicationStatus("");
      setAlreadyRegistered(false);
      setNotice("Wallet disconnected. Connect again to continue.");
    };

    provider.on?.("connect", handleConnect);
    provider.on?.("accountChanged", handleAccountChanged);
    provider.on?.("disconnect", handleDisconnect);
    return () => {
      const remove = provider.off?.bind(provider) ?? provider.removeListener?.bind(provider);
      remove?.("connect", handleConnect);
      remove?.("accountChanged", handleAccountChanged);
      remove?.("disconnect", handleDisconnect);
    };
  }, []);

  async function submitSignedApplication(address: string, nonce: string, signature: Uint8Array) {
    const { data: result, error: submitError } = await supabase.functions.invoke(
      "resurgence-participant-submit",
      { body: { walletAddress: address, nonce, signature: toBase64(signature) } },
    );
    if (submitError) throw new Error(await readFunctionError(submitError));
    if (!result?.success || !result?.participant?.status) {
      throw new Error("The application response was incomplete. Please retry.");
    }
    const status = String(result.participant.status).toUpperCase();
    setApplicationStatus(status);
    setAlreadyRegistered(Boolean(result.alreadyRegistered));
    setNotice(
      result.alreadyRegistered
        ? `This wallet is already registered. Current status: ${status.toLowerCase()}.`
        : "Application submitted successfully. Your status is Pending while the admin reviews it.",
    );
  }

  useEffect(() => {
    if (callbackHandled.current) return;
    const params = new URLSearchParams(window.location.search);
    if (!params.has("phantom_callback")) return;
    callbackHandled.current = true;
    setBusy(true);
    setError("");
    setNotice("");

    void (async () => {
      try {
        const callback = await consumePhantomCallback();
        if (!callback) return;
        if (callback.type === "error") {
          setError(callback.message);
          return;
        }
        setWalletAddress(callback.walletAddress);
        if (callback.type === "connected") {
          setNotice("Phantom connected. Opening the wallet-ownership signature; your application will submit automatically.");
          await startDeepLinkVerification(callback.walletAddress);
          return;
        }
        if (!supabaseConfigured) {
          setError("The application service is not configured. Your signature was not submitted; contact the event administrator.");
          return;
        }
        setNotice("Signature received. Submitting your application securely…");
        await submitSignedApplication(callback.walletAddress, callback.challengeNonce, callback.signature);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Unable to finish the Phantom request. Please try again.");
      } finally {
        setBusy(false);
      }
    })();
  }, []);

  async function requestWalletChallenge(address: string) {
    const { data: challenge, error: challengeError } = await supabase.functions.invoke(
      "resurgence-participant-challenge",
      { body: { walletAddress: address } },
    );
    if (challengeError) throw new Error(await readFunctionError(challengeError));
    if (!challenge?.nonce || !challenge?.message) {
      throw new Error("The verification service returned an incomplete challenge. Please retry.");
    }
    return { nonce: String(challenge.nonce), message: String(challenge.message) };
  }
 
  async function signInAndSubmit(provider: SolanaWalletProvider) {
    const { data: challenge, error: challengeError } = await supabase.functions.invoke(
      "resurgence-participant-siws-challenge",
      { body: {} },
    );
    if (challengeError) throw new Error(await readFunctionError(challengeError));
    if (!challenge?.nonce || !challenge?.input || typeof challenge.input !== "object") {
      throw new Error("The one-step sign-in service returned an incomplete challenge. Please retry.");
    }

    const input = challenge.input as WalletSignInInput;
    const output = await provider.signIn!(input);
    if (!(output.signature instanceof Uint8Array) ||
        output.signature.length !== 64 ||
        !(output.signedMessage instanceof Uint8Array) ||
        output.signedMessage.length < 1) {
      throw new Error("The wallet returned an invalid sign-in response. Please retry.");
    }

    const address = output.account?.address ?? provider.publicKey?.toBase58() ?? "";
    if (!address) throw new Error("The wallet did not return a public address for sign-in.");
    if (output.account?.publicKey instanceof Uint8Array && output.account.publicKey.length === 32) {
      // Wallet-standard SIWS outputs expose a public key. The backend independently
      // binds the signature to account.address and verifies the exact signed message.
      setWalletAddress(address);
    }

    const { data: result, error: submitError } = await supabase.functions.invoke(
      "resurgence-participant-siws-submit",
      { body: {
        walletAddress: address,
        nonce: String(challenge.nonce),
        signature: toBase64(output.signature),
        signedMessage: toBase64(output.signedMessage),
      } },
    );
    if (submitError) throw new Error(await readFunctionError(submitError));
    if (!result?.success || !result?.participant?.status) {
      throw new Error("Sign-in was verified but the application response was incomplete. Please retry.");
    }
    const status = String(result.participant.status).toUpperCase();
    setWalletAddress(address);
    setApplicationStatus(status);
    setAlreadyRegistered(Boolean(result.alreadyRegistered));
    setNotice(result.alreadyRegistered
      ? `This wallet is already registered. Current status: ${status.toLowerCase()}.`
      : "Wallet verified. Your application was submitted automatically and is Pending admin review.");
  }

  async function startDeepLinkVerification(address: string) {
    if (!supabaseConfigured) {
      throw new Error("The application service is not configured. Contact the event administrator.");
    }
    const connection = getPhantomConnection();
    if (!connection || connection.walletAddress !== address) {
      throw new Error("The Phantom session is missing. Please tap Connect Wallet to reconnect.");
    }
    const challenge = await requestWalletChallenge(address);
    setNotice("Phantom connected. Opening the wallet-ownership signature; no blockchain transaction will be made.");
    const launched = launchPhantomSignMessage(challenge.message, connection, challenge.nonce);
    if (!launched) throw new Error("Could not open Phantom's signature request. Tap Connect Wallet to retry.");
  }

  async function authenticateAndSubmit(address: string) {
    if (!supabaseConfigured) {
      setError("The application service is not configured yet. Please contact the event administrator.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("Verifying wallet ownership and submitting your application…");
    try {
      const provider = getWalletProvider();
      const deepLinkConnection = getPhantomConnection();

      if (provider) {
        const currentAddress = provider.publicKey?.toBase58() ?? "";
        if (currentAddress && currentAddress !== address) {
          throw new Error("The connected wallet changed. Reconnect the wallet you want to register.");
        }
        const challenge = await requestWalletChallenge(address);
        if (typeof provider.signMessage !== "function") {
          throw new Error("This wallet cannot sign the verification message. Open this page inside Phantom and retry.");
        }
        const signed = await provider.signMessage(new TextEncoder().encode(challenge.message), "utf8");
        const signature = signed instanceof Uint8Array ? signed : signed.signature;
        if (!(signature instanceof Uint8Array) || signature.length !== 64) {
          throw new Error("The wallet returned an invalid signature. Please retry.");
        }
        await submitSignedApplication(address, challenge.nonce, signature);
        return;
      }

      if (!deepLinkConnection || deepLinkConnection.walletAddress !== address) {
        throw new Error("Your Phantom session is not available. Tap Connect Wallet to reconnect.");
      }
      await startDeepLinkVerification(address);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The application could not be submitted. Please try again.");
      setNotice("");
    } finally {
      setBusy(false);
    }
  }

  async function connectWallet() {
    setError("");
    setNotice("");
    setApplicationStatus("");
    setAlreadyRegistered(false);
    if (!supabaseConfigured) {
      setError("The application service is not configured yet. Please contact the event administrator.");
      return;
    }

    const provider = getWalletProvider();
    if (!provider) {
      setBusy(true);
      setNotice("Opening Phantom to connect and verify your wallet. Your application will submit automatically when you return.");
      try {
        const launched = launchPhantomConnect();
        if (!launched) throw new Error("Could not open Phantom. Please retry.");
        window.setTimeout(() => {
          setBusy((current) => current ? false : current);
          setNotice((current) => current.startsWith("Opening Phantom to connect")
            ? "Still on this page? Phantom may not have opened or returned. Tap Connect Wallet to retry."
            : current);
        }, 12000);
      } catch (cause) {
        setBusy(false);
        setNotice("");
        setError(cause instanceof Error ? cause.message : "Could not open Phantom. Please try again.");
      }
      return;
    }

    setBusy(true);
    try {
      if (typeof provider.signIn === "function") {
        await signInAndSubmit(provider);
        return;
      }
      const connection = await provider.connect();
      const address = (connection.publicKey ?? provider.publicKey)?.toBase58() ?? "";
      if (!address) throw new Error("Phantom did not return a wallet address. Please reconnect.");
      setWalletAddress(address);
      await authenticateAndSubmit(address);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Wallet connection was cancelled or failed.");
      setNotice("");
    } finally {
      setBusy(false);
    }
  }

  const statusDescription = applicationStatus === "APPROVED"
    ? "Your application is approved. Allocation rights are subject to availability and the campaign cap."
    : applicationStatus === "REJECTED"
      ? "This wallet has already been reviewed. Contact the event administrator if you believe this is incorrect."
      : applicationStatus === "PENDING"
        ? "Your application is in the admin review queue."
        : "";

  return (
    <main className="participant-shell">
      <section className="participant-card">
        <a className="participant-back" href="./"><ArrowLeft size={15} /> Back to portal</a>
        <div className="participant-brand">
          <div className="participant-brand-mark"><ShieldCheck size={22} /></div>
          <div><span>THE RESURGENCE</span><small>PARTICIPANT PORTAL</small></div>
        </div>

        <p className="eyebrow participant-eyebrow">CAMPAIGN 2026</p>
        <h1>Register your wallet.</h1>
        <p className="participant-intro">{getWalletProvider() ? "Connect your Solana wallet. Phantom will handle the wallet-ownership signature, then your application will be submitted automatically for admin review." : "Tap Connect Wallet to open Phantom. Once connected, the verification signature and application submission continue automatically; no separate portal submission button is needed."}</p>


        <div className="participant-steps">
          <div className="participant-step"><span>01</span><div><strong>Connect wallet</strong><small>One button starts the wallet connection.</small></div></div>
          <div className="participant-step"><span>02</span><div><strong>Sign verification message</strong><small>Phantom confirms wallet ownership; no transaction or transfer is created.</small></div></div>
          <div className="participant-step"><span>03</span><div><strong>Admin review</strong><small>Applications start as Pending. Approval does not guarantee funds; allocation rights are limited to 125 participants.</small></div></div>
        </div>

        <div className="participant-wallet">
          <div className="participant-wallet-icon"><Wallet size={19} /></div>
          <div className="participant-wallet-copy">
            <strong>{walletAddress ? "Wallet connected" : "No wallet connected"}</strong>
            <span>{walletAddress ? `${walletAddress.slice(0, 8)}…${walletAddress.slice(-7)}` : "Your address will appear here after connecting."}</span>
          </div>
          <span className={walletAddress ? "participant-connection connected" : "participant-connection"}>{walletAddress ? "CONNECTED" : "WAITING"}</span>
        </div>

        {!applicationStatus && (
          <button className="button button-primary button-full participant-main-button" type="button" onClick={() => void connectWallet()} disabled={busy || !supabaseConfigured}>
            <Wallet size={16} /> {busy ? "Connecting & verifying…" : error && walletAddress ? "Retry wallet verification" : "Connect Wallet"}
          </button>
        )}

        {error && <div className="participant-alert participant-alert-error"><CircleAlert size={17} /><span>{error}</span></div>}
        {notice && <div className="participant-alert participant-alert-success"><CheckCircle2 size={17} /><span>{notice}</span></div>}
        {applicationStatus && <div className="participant-status"><div><Clock3 size={16} /><strong>Application status: {applicationStatus}</strong></div><p>{statusDescription}</p>{alreadyRegistered && <small>No duplicate application was created.</small>}</div>}

        <div className="participant-safety"><LockKeyhole size={16} /><span><strong>Message signature only.</strong> Never enter or share your recovery phrase or private key. The verification message does not authorize a transfer.</span></div>
        <p className="participant-footnote">By submitting, you confirm you control the connected wallet. Wallet address and review status are stored to administer this campaign.</p>
      </section>
      <footer className="page-footer">THE RESURGENCE <span>•</span> PARTICIPANT REGISTRATION</footer>
    </main>
  );
}
