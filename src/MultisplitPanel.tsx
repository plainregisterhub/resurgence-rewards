import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, CircleDollarSign, ClipboardCheck, LoaderCircle, ShieldCheck, Wallet } from "lucide-react";
import { supabase } from "./lib/supabase";

type TreasuryConfig = {
  campaign_id: string;
  master_wallet_address: string;
  pool_bps: number;
  participant_bps: number;
  participant_cap: number;
  updated_at: string;
};

type PlanResult = {
  run_id: string;
  eligible_fees_lamports: string | number;
  pool_bps: number;
  participant_bps: number;
  participant_count: number;
  total_pool_lamports: string | number;
  total_planned_lamports: string | number;
  master_wallet_address: string;
  status: string;
  created_at: string;
};

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const LAMPORTS_PER_SOL = 1_000_000_000n;

function solToLamports(value: string): string {
  const normalized = value.trim();
  if (!/^\d+(\.\d{1,9})?$/.test(normalized)) {
    throw new Error("Enter a SOL amount with up to 9 decimal places.");
  }
  const [whole, fraction = ""] = normalized.split(".");
  const lamports = BigInt(whole) * LAMPORTS_PER_SOL + BigInt((fraction + "000000000").slice(0, 9));
  if (lamports <= 0n) throw new Error("Eligible fees must be greater than zero.");
  if (lamports > 600_000_000n * LAMPORTS_PER_SOL) {
    throw new Error("The fee base exceeds the maximum supported validation range.");
  }
  return lamports.toString();
}

function lamportsToSol(value: string | number): string {
  const lamports = BigInt(value);
  const whole = lamports / LAMPORTS_PER_SOL;
  const fraction = (lamports % LAMPORTS_PER_SOL).toString().padStart(9, "0").replace(/0+$/, "");
  return fraction ? `${whole.toString()}.${fraction}` : whole.toString();
}

function shortWallet(value: string): string {
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

export default function MultisplitPanel({ onPlanCreated }: { onPlanCreated?: () => void }) {
  const [masterWallet, setMasterWallet] = useState("");
  const [savedConfig, setSavedConfig] = useState<TreasuryConfig | null>(null);
  const [eligibleFeesSol, setEligibleFeesSol] = useState("");
  const [loadingConfig, setLoadingConfig] = useState(true);
  const [savingConfig, setSavingConfig] = useState(false);
  const [creatingPlan, setCreatingPlan] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [lastPlan, setLastPlan] = useState<PlanResult | null>(null);

  useEffect(() => {
    let active = true;
    async function loadConfig() {
      setLoadingConfig(true);
      const { data, error } = await supabase.rpc("get_resurgence_treasury_config");
      if (!active) return;
      if (error) {
        setMessage({ type: "error", text: `Could not load treasury configuration: ${error.message}` });
      } else {
        const rows = (data ?? []) as TreasuryConfig[];
        const config = rows[0] ?? null;
        setSavedConfig(config);
        setMasterWallet(config?.master_wallet_address ?? "");
      }
      setLoadingConfig(false);
    }
    void loadConfig();
    return () => { active = false; };
  }, []);

  async function saveMasterWallet() {
    setMessage(null);
    const address = masterWallet.trim();
    if (!BASE58_ADDRESS.test(address)) {
      setMessage({ type: "error", text: "Enter a Solana public address using 32–44 Base58 characters." });
      return;
    }
    setSavingConfig(true);
    try {
      const { data, error } = await supabase.rpc("save_resurgence_treasury_config", {
        p_master_wallet_address: address,
      });
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as TreasuryConfig[];
      if (!rows[0]) throw new Error("Treasury configuration was not returned by the server.");
      setSavedConfig(rows[0]);
      setMasterWallet(rows[0].master_wallet_address);
      setMessage({ type: "success", text: "Master Wallet address saved. Its fee-routing and ownership are not yet verified." });
    } catch (error) {
      setMessage({ type: "error", text: error instanceof Error ? error.message : "Unable to save Master Wallet configuration." });
    } finally {
      setSavingConfig(false);
    }
  }

  async function createDraftPlan() {
    setMessage(null);
    if (!savedConfig) {
      setMessage({ type: "error", text: "Save the Master Wallet address before generating a plan." });
      return;
    }
    let lamports: string;
    try {
      lamports = solToLamports(eligibleFeesSol);
    } catch (error) {
      setMessage({ type: "error", text: error instanceof Error ? error.message : "Enter a valid eligible fee base." });
      return;
    }

    setCreatingPlan(true);
    try {
      const { data, error } = await supabase.rpc("create_resurgence_multisplit_plan", {
        p_eligible_fees_lamports: lamports,
        p_idempotency_key: crypto.randomUUID(),
      });
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as PlanResult[];
      if (!rows[0]) throw new Error("The server did not return the allocation plan.");
      setLastPlan(rows[0]);
      setMessage({ type: "success", text: "Draft plan created. No SOL or tokens have been transferred." });
      onPlanCreated?.();
    } catch (error) {
      setMessage({ type: "error", text: error instanceof Error ? error.message : "Unable to create a draft allocation plan." });
    } finally {
      setCreatingPlan(false);
    }
  }

  return (
    <section id="treasury" className="panel treasury-panel">
      <div className="panel-heading">
        <div>
          <h2>Rewards Treasury &amp; Multisplit Engine</h2>
          <p>Configure the single Master Wallet and create an auditable allocation draft for approved participants.</p>
        </div>
        <div className="panel-heading-icon treasury-icon"><Wallet size={17} /></div>
      </div>

      <div className="treasury-grid">
        <div className="treasury-block">
          <div className="treasury-label"><Wallet size={15} /> MASTER WALLET</div>
          <label className="treasury-field-label" htmlFor="master-wallet">Master Wallet public address</label>
          <input
            id="master-wallet"
            className="treasury-input mono"
            value={masterWallet}
            onChange={(event) => setMasterWallet(event.target.value)}
            maxLength={44}
            minLength={32}
            placeholder="Paste public Solana address…"
            autoComplete="off"
            spellCheck={false}
          />
          <div className="treasury-footnote">
            {savedConfig
              ? <>Saved address: <code>{shortWallet(savedConfig.master_wallet_address)}</code></>
              : "No Master Wallet address is configured yet."}
          </div>
          <button className="button button-secondary treasury-button" type="button" onClick={() => void saveMasterWallet()} disabled={savingConfig || loadingConfig}>
            {savingConfig ? <LoaderCircle size={15} className="spin" /> : <ShieldCheck size={15} />}
            {savingConfig ? "Saving…" : "Save Master Wallet"}
          </button>
        </div>

        <div className="treasury-block">
          <div className="treasury-label"><CircleDollarSign size={15} /> PLAN INPUT</div>
          <label className="treasury-field-label" htmlFor="eligible-fees">Verified eligible creator fees (SOL)</label>
          <input
            id="eligible-fees"
            className="treasury-input"
            inputMode="decimal"
            value={eligibleFeesSol}
            onChange={(event) => setEligibleFeesSol(event.target.value)}
            placeholder="e.g. 1.25"
            autoComplete="off"
          />
          <div className="treasury-formula">
            <span>Rewards Pool target <strong>25%</strong></span>
            <span>Per approved participant <strong>0.2%</strong></span>
            <span>Maximum recipients <strong>125</strong></span>
          </div>
          <button className="button button-primary treasury-button" type="button" onClick={() => void createDraftPlan()} disabled={creatingPlan || loadingConfig || !savedConfig || !eligibleFeesSol.trim()}>
            {creatingPlan ? <LoaderCircle size={15} className="spin" /> : <ClipboardCheck size={15} />}
            {creatingPlan ? "Generating draft…" : "Generate draft plan"}
          </button>
        </div>
      </div>

      <div className="treasury-safety">
        <AlertTriangle size={16} />
        <span><strong>Planning only:</strong> fee-base input must be verified by the operator. Saving a wallet does not prove it receives Pump.fun fees. This engine records a draft; it does not sign or send transactions.</span>
      </div>

      {loadingConfig && <div className="treasury-loading"><LoaderCircle size={15} className="spin" /> Loading treasury configuration…</div>}
      {message && <div className={message.type === "success" ? "treasury-message success" : "treasury-message error"}>{message.type === "success" ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}<span>{message.text}</span></div>}

      {lastPlan && (
        <div className="treasury-result">
          <div className="treasury-result-top"><div><span className="treasury-result-label">NEW DRAFT PLAN</span><strong>{lastPlan.run_id.slice(0, 8).toUpperCase()}</strong></div><span className="badge badge-draft"><span className="badge-dot" />{lastPlan.status}</span></div>
          <div className="treasury-result-grid">
            <div><span>Eligible fee base</span><strong>{lamportsToSol(lastPlan.eligible_fees_lamports)} SOL</strong></div>
            <div><span>Pool target (25%)</span><strong>{lamportsToSol(lastPlan.total_pool_lamports)} SOL</strong></div>
            <div><span>Approved recipients</span><strong>{lastPlan.participant_count} / 125</strong></div>
            <div><span>Planned total</span><strong>{lamportsToSol(lastPlan.total_planned_lamports)} SOL</strong></div>
          </div>
          <div className="treasury-footnote">Master Wallet snapshot: <code>{shortWallet(lastPlan.master_wallet_address)}</code>. The plan remains a draft until separately reviewed and the on-chain payment method is implemented and verified.</div>
        </div>
      )}
    </section>
  );
}
