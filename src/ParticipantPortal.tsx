import { useState } from "react";
import type { FormEvent } from "react";
import { ArrowLeft, CheckCircle2, CircleAlert, Clock3, LockKeyhole, ShieldCheck, Wallet } from "lucide-react";
import { supabase, supabaseConfigured } from "./lib/supabase";

type WalletPublicKey = { toBase58(): string };
type WalletSignResult = Uint8Array | { signature: Uint8Array };
type SolanaWalletProvider = {
  isPhantom?: boolean;
  publicKey?: WalletPublicKey | null;
  connect: () => Promise<{ publicKey?: WalletPublicKey }>;
  signMessage?: (message: Uint8Array, display?: "utf8") => Promise<WalletSignResult>;
  disconnect?: () => Promise<void>;
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

  async function connectWallet() {
    setError("");
    setNotice("");
    setApplicationStatus("");
    const provider = getWalletProvider();
    if (!provider) {
      setError("No compatible Solana wallet was detected. Open this portal inside the Phantom app browser, or install a compatible Solana wallet and try again.");
      return;
    }
    setBusy(true);
    try {
      const connection = await provider.connect();
      const publicKey = connection.publicKey ?? provider.publicKey;
      if (!publicKey) throw new Error("The wallet did not return a public address. Please reconnect.");
      setWalletAddress(publicKey.toBase58());
      setNotice("Wallet connected. Next, sign the verification message to submit your application.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Wallet connection was cancelled or failed.");
    } finally {
      setBusy(false);
    }
  }

  async function submitApplication(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    setApplicationStatus("");
    setAlreadyRegistered(false);
    if (!supabaseConfigured) {
      setError("The application service is not configured yet. Please contact the event administrator.");
      return;
    }

    const provider = getWalletProvider();
    if (!provider || typeof provider.signMessage !== "function") {
      setError("This wallet cannot sign verification messages in the current browser. Open the portal in Phantom or another compatible Solana wallet.");
      return;
    }

    setBusy(true);
    try {
      let currentAddress = provider.publicKey?.toBase58() ?? "";
      if (currentAddress !== walletAddress) {
        const connection = await provider.connect();
        currentAddress = (connection.publicKey ?? provider.publicKey)?.toBase58() ?? "";
      }
      if (currentAddress !== walletAddress) {
        throw new Error("The connected wallet changed. Please reconnect the wallet you want to register.");
      }

      const { data: challenge, error: challengeError } = await supabase.functions.invoke(
        "resurgence-participant-challenge",
        { body: { walletAddress } },
      );
      if (challengeError) throw new Error(await readFunctionError(challengeError));
      if (!challenge?.nonce || !challenge?.message) throw new Error("The verification service returned an incomplete challenge. Please retry.");

      const messageBytes = new TextEncoder().encode(challenge.message as string);
      const signed = await provider.signMessage(messageBytes, "utf8");
      const signature = signed instanceof Uint8Array ? signed : signed.signature;
      if (!(signature instanceof Uint8Array) || signature.length !== 64) {
        throw new Error("The wallet returned an invalid signature. Please retry.");
      }

      const { data: result, error: submitError } = await supabase.functions.invoke(
        "resurgence-participant-submit",
        { body: { walletAddress, nonce: challenge.nonce, signature: toBase64(signature) } },
      );
      if (submitError) throw new Error(await readFunctionError(submitError));
      if (!result?.success || !result?.participant?.status) throw new Error("The application response was incomplete. Please retry.");

      const status = String(result.participant.status).toUpperCase();
      setApplicationStatus(status);
      setAlreadyRegistered(Boolean(result.alreadyRegistered));
      setNotice(
        result.alreadyRegistered
          ? `This wallet is already registered. Current status: ${status.toLowerCase()}.`
          : "Application submitted successfully. Your status is Pending while the admin reviews it.",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The application could not be submitted. Please try again.");
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
        <p className="participant-intro">Connect your Solana wallet and prove ownership with a signature. Your application will be sent directly to the review queue.</p>

        <div className="participant-steps">
          <div className="participant-step"><span>01</span><div><strong>Connect wallet</strong><small>Use Phantom or a compatible Solana wallet.</small></div></div>
          <div className="participant-step"><span>02</span><div><strong>Sign verification message</strong><small>Proves wallet control only. No transaction is created and no SOL is transferred.</small></div></div>
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

        {!walletAddress ? (
          <button className="button button-primary button-full participant-main-button" type="button" onClick={() => void connectWallet()} disabled={busy || !supabaseConfigured}>
            <Wallet size={16} /> {busy ? "Connecting…" : "Connect Wallet"}
          </button>
        ) : (
          <form onSubmit={submitApplication}>
            <button className="button button-primary button-full participant-main-button" type="submit" disabled={busy}>
              <LockKeyhole size={16} /> {busy ? "Verifying wallet…" : "Sign & Submit Application"}
            </button>
            <button className="participant-change-wallet" type="button" disabled={busy} onClick={() => { setWalletAddress(""); setNotice(""); setError(""); setApplicationStatus(""); }}>
              Use a different wallet
            </button>
          </form>
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
