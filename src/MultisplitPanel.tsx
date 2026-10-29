import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, Ban, CheckCircle2, CircleDollarSign, ClipboardCheck,
  LoaderCircle, RefreshCw, ShieldCheck, UserRoundCheck, Wallet,
} from "lucide-react";
import { supabase } from "./lib/supabase";

type TreasuryConfig = {
  campaign_id: string;
  master_wallet_address: string;
  pool_bps: number;
  participant_bps: number;
  participant_cap: number;
  updated_at: string;
};

type AllocationRight = {
  right_id: string;
  participant_id: string;
  wallet_address: string;
  allocation_bps: number;
  status: "ACTIVE" | "REVOKED";
  granted_at: string;
  revoked_at: string | null;
  revocation_reason: string | null;
};

type RightsSyncResult = {
  added_count: number;
  active_count: number;
  active_bps: number;
  slots_remaining: number;
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

const INITIAL_MASTER_WALLET = "7jqyogrnPP9tCcTqPvzG7Ys63s5V7uDS8sCgSKhNfUFT";
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

function rightPercent(bps: number): string {
  return `${(bps / 100).toFixed(1)}%`;
}

function dateLabel(value: string): string {
  return new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export default function MultisplitPanel({ onPlanCreated }: { onPlanCreated?: () => void }) {
  const [masterWallet, setMasterWallet] = useState(INITIAL_MASTER_WALLET);
  const [savedConfig, setSavedConfig] = useState<TreasuryConfig | null>(null);
  const [rights, setRights] = useState<AllocationRight[]>([]);
  const [eligibleFeesSol, setEligibleFeesSol] = useState("");
  const [loading, setLoading] = useState(true);
  const [savingConfig, setSavingConfig] = useState(false);
  const [syncingRights, setSyncingRights] = useState(false);
  const [revokingId, setRevokingId] = useState("");
  const [creatingPlan, setCreatingPlan] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [lastPlan, setLastPlan] = useState<PlanResult | null>(null);

  const activeRights = useMemo(() => rights.filter((right) => right.status === "ACTIVE"), [rights]);
  const activeBps = useMemo(() => activeRights.reduce((total, right) => total + right.allocation_bps, 0), [activeRights]);

  const reloadData = useCallback(async () => {
    setLoading(true);
    const [configResult, rightsResult] = await Promise.all([
      supabase.rpc("get_resurgence_treasury_config"),
      supabase.rpc("get_resurgence_allocation_rights"),
    ]);

    if (configResult.error) {
      setMessage({ type: "error", text: `Could not load Master Wallet configuration: ${configResult.error.message}` });
    } else {
      const rows = (configResult.data ?? []) as TreasuryConfig[];
      const config = rows[0] ?? null;
      setSavedConfig(config);
      setMasterWallet(config?.master_wallet_address ?? INITIAL_MASTER_WALLET);
    }

    if (rightsResult.error) {
      setMessage({ type: "error", text: `Could not load Allocation Rights: ${rightsResult.error.message}` });
    } else {
      setRights((rightsResult.data ?? []) as AllocationRight[]);
    }
    setLoading(false);
  }, []);

  useEffect(() => { void reloadData(); }, [reloadData]);

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
      setMessage({ type: "success", text: "Master Wallet saved. Fee routing and actual receipt of creator fees remain unverified." });
    } catch (error) {
      setMessage({ type: "error", text: error instanceof Error ? error.message : "Unable to save Master Wallet configuration." });
    } finally {
      setSavingConfig(false);
    }
  }

  async function syncAllocationRights() {
    setMessage(null);
    setSyncingRights(true);
    try {
      const { data, error } = await supabase.rpc("sync_resurgence_allocation_rights");
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as RightsSyncResult[];
      const result = rows[0];
      if (!result) throw new Error("The server did not return an Allocation Rights summary.");
      await reloadData();
      setMessage({
        type: "success",
        text: `Rights sync complete: ${result.added_count} new rights granted; ${result.active_count} active rights (${rightPercent(result.active_bps)} total); ${result.slots_remaining} of 125 slots remain. No funds or tokens were issued.`,
      });
    } catch (error) {
      setMessage({ type: "error", text: error instanceof Error ? error.message : "Unable to sync Allocation Rights." });
    } finally {
      setSyncingRights(false);
    }
  }

  async function revokeRight(right: AllocationRight) {
    if (right.status !== "ACTIVE") return;
    const reason = window.prompt(`Reason for revoking the 0.2% allocation right for ${shortWallet(right.wallet_address)} (5–500 characters):`);
    if (reason === null) return;
    if (reason.trim().length < 5 || reason.trim().length > 500) {
      setMessage({ type: "error", text: "Revocation reason must contain 5–500 characters." });
      return;
    }

    setMessage(null);
    setRevokingId(right.participant_id);
    try {
      const { error } = await supabase.rpc("revoke_resurgence_allocation_right", {
        p_participant_id: right.participant_id,
        p_reason: reason.trim(),
      });
      if (error) throw new Error(error.message);
      await reloadData();
      setMessage({ type: "success", text: `Allocation right revoked for ${shortWallet(right.wallet_address)}. Existing payout drafts are historical snapshots and are not rewritten.` });
    } catch (error) {
      setMessage({ type: "error", text: error instanceof Error ? error.message : "Unable to revoke Allocation Right." });
    } finally {
      setRevokingId("");
    }
  }

  async function createDraftPlan() {
    setMessage(null);
    if (!savedConfig) {
      setMessage({ type: "error", text: "Save the Master Wallet address before creating a payout draft." });
      return;
    }
    if (activeRights.length < 1) {
      setMessage({ type: "error", text: "Grant Allocation Rights before creating a payout draft." });
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
      if (!rows[0]) throw new Error("The server did not return the payout draft.");
      setLastPlan(rows[0]);
      setMessage({ type: "success", text: "Payout draft created from active Allocation Rights. No SOL or tokens have been transferred." });
      onPlanCreated?.();
    } catch (error) {
      setMessage({ type: "error", text: error instanceof Error ? error.message : "Unable to create a payout draft." });
    } finally {
      setCreatingPlan(false);
    }
  }

  return (
    <section id="treasury" className="panel treasury-panel">
      <div className="panel-heading">
        <div>
          <h2>Allocation Rights &amp; Payout Engine</h2>
          <p>Record percentage entitlements first; calculate SOL amounts only after eligible creator fees are verified.</p>
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
            placeholder="Public Solana address"
            autoComplete="off"
            spellCheck={false}
          />
          <div className="treasury-footnote">
            {savedConfig
              ? <>Saved address: <code>{shortWallet(savedConfig.master_wallet_address)}</code></>
              : "Address is prefilled but not yet saved in configuration."}
          </div>
          <button className="button button-secondary treasury-button" type="button" onClick={() => void saveMasterWallet()} disabled={savingConfig || loading}>
            {savingConfig ? <LoaderCircle size={15} className="spin" /> : <ShieldCheck size={15} />}
            {savingConfig ? "Saving…" : "Save Master Wallet"}
          </button>
        </div>

        <div className="treasury-block">
          <div className="treasury-label"><UserRoundCheck size={15} /> ALLOCATION RIGHTS</div>
          <div className="allocation-summary">
            <div><span>Active rights</span><strong>{activeRights.length} / 125</strong></div>
            <div><span>Combined entitlement</span><strong>{rightPercent(activeBps)}</strong></div>
            <div><span>Available slots</span><strong>{Math.max(125 - activeRights.length, 0)}</strong></div>
          </div>
          <p className="allocation-explainer">Each active right records 0.2% of the same eligible creator-fee base. Rights are not tokens, cash, or a current SOL balance.</p>
          <button className="button button-primary treasury-button" type="button" onClick={() => void syncAllocationRights()} disabled={syncingRights || loading}>
            {syncingRights ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}
            {syncingRights ? "Syncing rights…" : "Grant rights to approved participants"}
          </button>
        </div>
      </div>

      <div className="allocation-rights-panel">
        <div className="allocation-rights-heading">
          <div><h3>Allocation Rights Register</h3><p>Only approved participants receive a right. Syncing is idempotent and does not assign a monetary value.</p></div>
          <span className="panel-count">{rights.length} records</span>
        </div>
        {loading ? (
          <div className="treasury-loading"><LoaderCircle size={15} className="spin" /> Loading Allocation Rights…</div>
        ) : rights.length === 0 ? (
          <div className="allocation-empty">No allocation rights have been granted yet. Approve participant wallets, then select “Grant rights to approved participants”.</div>
        ) : (
          <div className="table-wrap">
            <table className="allocation-rights-table">
              <thead><tr><th>WALLET</th><th>ENTITLEMENT</th><th>STATUS</th><th>GRANTED</th><th>ACTION</th></tr></thead>
              <tbody>
                {rights.map((right) => (
                  <tr key={right.right_id}>
                    <td><code>{shortWallet(right.wallet_address)}</code></td>
                    <td>{rightPercent(right.allocation_bps)}</td>
                    <td><span className={right.status === "ACTIVE" ? "rights-status active" : "rights-status revoked"}>{right.status}</span></td>
                    <td>{dateLabel(right.granted_at)}</td>
                    <td>
                      {right.status === "ACTIVE" ? (
                        <button className="rights-revoke-button" type="button" onClick={() => void revokeRight(right)} disabled={revokingId === right.participant_id} aria-label={`Revoke right for ${shortWallet(right.wallet_address)}`}>
                          {revokingId === right.participant_id ? <LoaderCircle size={13} className="spin" /> : <Ban size={13} />}
                          Revoke
                        </button>
                      ) : <span className="allocation-muted">{right.revocation_reason ?? "Revoked"}{right.revoked_at ? ` · ${dateLabel(right.revoked_at)}` : ""}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="allocation-payout-block">
        <div className="treasury-label"><CircleDollarSign size={15} /> PAYOUT PLANNING — LATER STAGE</div>
        <label className="treasury-field-label" htmlFor="eligible-fees">Verified eligible creator fees (SOL)</label>
        <input
          id="eligible-fees"
          className="treasury-input allocation-fee-input"
          inputMode="decimal"
          value={eligibleFeesSol}
          onChange={(event) => setEligibleFeesSol(event.target.value)}
          placeholder="Only enter a verified fee base, e.g. 1.25"
          autoComplete="off"
        />
        <div className="treasury-formula">
          <span>Rewards Pool maximum <strong>25%</strong></span>
          <span>Each active right <strong>0.2%</strong></span>
          <span>Maximum rights <strong>125</strong></span>
        </div>
        <button className="button button-primary treasury-button" type="button" onClick={() => void createDraftPlan()} disabled={creatingPlan || loading || !savedConfig || activeRights.length === 0 || !eligibleFeesSol.trim()}>
          {creatingPlan ? <LoaderCircle size={15} className="spin" /> : <ClipboardCheck size={15} />}
          {creatingPlan ? "Generating draft…" : "Generate payout draft"}
        </button>
      </div>

      <div className="treasury-safety">
        <AlertTriangle size={16} />
        <span><strong>Two separate stages:</strong> Allocation Rights can exist with a zero SOL balance. A payout draft requires a verified fee base and uses active rights only. This portal does not prove Pump.fun fee routing, sign transactions, or send payments.</span>
      </div>

      {loading && <div className="treasury-loading"><LoaderCircle size={15} className="spin" /> Loading treasury configuration…</div>}
      {message && <div className={message.type === "success" ? "treasury-message success" : "treasury-message error"}>{message.type === "success" ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}<span>{message.text}</span></div>}

      {lastPlan && (
        <div className="treasury-result">
          <div className="treasury-result-top"><div><span className="treasury-result-label">PAYOUT DRAFT</span><strong>{lastPlan.run_id.slice(0, 8).toUpperCase()}</strong></div><span className="badge badge-draft"><span className="badge-dot" />{lastPlan.status}</span></div>
          <div className="treasury-result-grid">
            <div><span>Verified eligible fee base</span><strong>{lamportsToSol(lastPlan.eligible_fees_lamports)} SOL</strong></div>
            <div><span>Rewards Pool maximum (25%)</span><strong>{lamportsToSol(lastPlan.total_pool_lamports)} SOL</strong></div>
            <div><span>Active rights snapshotted</span><strong>{lastPlan.participant_count} / 125</strong></div>
            <div><span>Planned allocation total</span><strong>{lamportsToSol(lastPlan.total_planned_lamports)} SOL</strong></div>
          </div>
          <div className="treasury-footnote">Master Wallet snapshot: <code>{shortWallet(lastPlan.master_wallet_address)}</code>. The draft is a calculated ledger only; transaction signing and fee-routing verification are not implemented.</div>
        </div>
      )}
    </section>
  );
}
