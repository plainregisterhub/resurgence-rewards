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
  asset_type: "SOL" | "TOKEN";
  asset_mint: string | null;
  asset_decimals: number;
};

const INITIAL_MASTER_WALLET = "7jqyogrnPP9tCcTqPvzG7Ys63s5V7uDS8sCgSKhNfUFT";
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function amountToBaseUnits(value: string, decimals: number): string {
  const normalized = value.trim();
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 9) {
    throw new Error("Asset decimals must be an integer between 0 and 9.");
  }
  if (!/^\\d+(\\.\\d+)?$/.test(normalized)) {
    throw new Error(`Enter an amount with up to ${decimals} decimal places.`);
  }
  const [whole, fraction = ""] = normalized.split(".");
  if (fraction.length > decimals && /[^0]/.test(fraction.slice(decimals))) {
    throw new Error(`Enter an amount with no more than ${decimals} decimal places.`);
  }
  const units = BigInt(whole) * (10n ** BigInt(decimals)) +
    BigInt(fraction.slice(0, decimals).padEnd(decimals, "0") || "0");
  if (units <= 0n) throw new Error("Eligible fees must be greater than zero.");
  return units.toString();
}

function baseUnitsToAmount(value: string | number, decimals: number): string {
  const units = BigInt(String(value));
  const scale = 10n ** BigInt(decimals);
  const whole = units / scale;
  if (decimals === 0) return whole.toString();
  const fraction = (units % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
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
  const [assetType, setAssetType] = useState<"SOL" | "TOKEN">("SOL");
  const [assetMint, setAssetMint] = useState("");
  const [assetDecimals, setAssetDecimals] = useState("6");
  const [eligibleFeeBaseAmount, setEligibleFeeBaseAmount] = useState("");
  const [executingPayout, setExecutingPayout] = useState(false);
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

    const decimals = assetType === "SOL" ? 9 : Number(assetDecimals);
    const mint = assetType === "TOKEN" ? assetMint.trim() : null;
    if (assetType === "TOKEN" && (!BASE58_ADDRESS.test(mint ?? "") || mint === savedConfig.master_wallet_address)) {
      setMessage({ type: "error", text: "Enter the actual SPL token mint address, not a wallet address." });
      return;
    }
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 9) {
      setMessage({ type: "error", text: "Token decimals must be an integer from 0 to 9." });
      return;
    }

    let baseUnits: string;
    try {
      baseUnits = amountToBaseUnits(eligibleFeeBaseAmount, decimals);
    } catch (error) {
      setMessage({ type: "error", text: error instanceof Error ? error.message : "Enter a valid eligible fee base." });
      return;
    }

    setCreatingPlan(true);
    try {
      const { data, error } = await supabase.rpc("create_resurgence_asset_payout_plan", {
        p_asset_type: assetType,
        p_asset_mint: mint,
        p_asset_decimals: decimals,
        p_eligible_fee_base_units: baseUnits,
        p_idempotency_key: crypto.randomUUID(),
      });
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as PlanResult[];
      if (!rows[0]) throw new Error("The server did not return the payout draft.");
      setLastPlan(rows[0]);
      setMessage({
        type: "success",
        text: `Payout draft created for ${rows[0].participant_count} approved recipients. No funds have moved yet.`,
      });
      onPlanCreated?.();
    } catch (error) {
      setMessage({ type: "error", text: error instanceof Error ? error.message : "Unable to create a payout draft." });
    } finally {
      setCreatingPlan(false);
    }
  }

  async function executePayout() {
    if (!lastPlan || !["DRAFT", "FAILED", "PROCESSING"].includes(lastPlan.status)) return;
    if (lastPlan.status === "PROCESSING") {
      setMessage({ type: "error", text: "This payout run is already processing. Refresh the ledger before retrying." });
      return;
    }
    setMessage(null);
    setExecutingPayout(true);
    try {
      const { data, error } = await supabase.functions.invoke("resurgence-payout-execute", {
        body: { runId: lastPlan.run_id },
      });
      if (error) {
        const context = (error as { context?: Response }).context;
        if (context && typeof context.json === "function") {
          try {
            const details = await context.json() as { error?: string };
            throw new Error(details.error || error.message);
          } catch (cause) {
            if (cause instanceof Error && cause.message !== "Unexpected end of JSON input") throw cause;
            throw new Error(error.message);
          }
        }
        throw new Error(error.message);
      }
      if (!data?.success || data?.status !== "COMPLETED") {
        throw new Error(data?.error || "The payout executor did not confirm the full payout.");
      }
      setLastPlan((current) => current ? { ...current, status: "COMPLETED" } : current);
      setMessage({
        type: "success",
        text: `Payout completed on ${data.cluster}. ${data.recipientCount} recipients paid across ${data.confirmedBatches} confirmed transaction batches.`,
      });
      onPlanCreated?.();
    } catch (error) {
      setMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Payout execution failed. Review the payout ledger before retrying.",
      });
    } finally {
      setExecutingPayout(false);
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
        <div className="treasury-label"><CircleDollarSign size={15} /> PAYOUT PLANNING &amp; EXECUTION</div>
        <label className="treasury-field-label" htmlFor="payout-asset">Reward asset</label>
        <select id="payout-asset" className="treasury-input" value={assetType} onChange={(event) => setAssetType(event.target.value as "SOL" | "TOKEN")}>
          <option value="SOL">SOL</option>
          <option value="TOKEN">SPL token (e.g. $DayOne)</option>
        </select>
        {assetType === "TOKEN" && (
          <div className="treasury-token-fields">
            <label className="treasury-field-label" htmlFor="payout-token-mint">SPL token mint address</label>
            <input id="payout-token-mint" className="treasury-input mono" value={assetMint} onChange={(event) => setAssetMint(event.target.value.trim())} placeholder="Paste token mint public address" maxLength={44} autoComplete="off" spellCheck={false} />
            <label className="treasury-field-label" htmlFor="payout-token-decimals">Mint decimals</label>
            <input id="payout-token-decimals" className="treasury-input" type="number" inputMode="numeric" min={0} max={9} step={1} value={assetDecimals} onChange={(event) => setAssetDecimals(event.target.value)} />
          </div>
        )}
        <label className="treasury-field-label" htmlFor="eligible-fees">Verified eligible fee base ({assetType === "SOL" ? "SOL" : "token units"})</label>
        <input
          id="eligible-fees"
          className="treasury-input allocation-fee-input"
          inputMode="decimal"
          value={eligibleFeeBaseAmount}
          onChange={(event) => setEligibleFeeBaseAmount(event.target.value)}
          placeholder={assetType === "SOL" ? "e.g. 1.25 SOL" : "e.g. 1250000.5 tokens"}
          autoComplete="off"
        />
        <div className="treasury-formula">
          <span>Rewards Pool maximum <strong>25%</strong></span>
          <span>Each active right <strong>0.2%</strong></span>
          <span>Maximum rights <strong>125</strong></span>
        </div>
        <button className="button button-primary treasury-button" type="button" onClick={() => void createDraftPlan()} disabled={creatingPlan || loading || !savedConfig || activeRights.length === 0 || !eligibleFeeBaseAmount.trim() || (assetType === "TOKEN" && !assetMint.trim())}>
          {creatingPlan ? <LoaderCircle size={15} className="spin" /> : <ClipboardCheck size={15} />}
          {creatingPlan ? "Generating draft…" : "Generate payout draft"}
        </button>
      </div>

      <div className="treasury-safety">
        <AlertTriangle size={16} />
        <span><strong>Transfer safety:</strong> payouts are disabled until the server-side signer, cluster and Master Wallet are configured. The executor refuses mismatched signers, checks balances, persists signed batches before broadcast, and records only confirmed transactions. A verified fee base remains an admin-provided input; this portal does not independently prove Pump.fun fee routing.</span>
      </div>

      {loading && <div className="treasury-loading"><LoaderCircle size={15} className="spin" /> Loading treasury configuration…</div>}
      {message && <div className={message.type === "success" ? "treasury-message success" : "treasury-message error"}>{message.type === "success" ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}<span>{message.text}</span></div>}

      {lastPlan && (
        <div className="treasury-result">
          <div className="treasury-result-top"><div><span className="treasury-result-label">PAYOUT RUN</span><strong>{lastPlan.run_id.slice(0, 8).toUpperCase()}</strong></div><span className={`badge badge-${lastPlan.status.toLowerCase()}`}><span className="badge-dot" />{lastPlan.status}</span></div>
          <div className="treasury-result-grid">
            <div><span>Verified eligible fee base</span><strong>{baseUnitsToAmount(lastPlan.eligible_fees_lamports, lastPlan.asset_decimals)} {lastPlan.asset_type}</strong></div>
            <div><span>Rewards Pool maximum (25%)</span><strong>{baseUnitsToAmount(lastPlan.total_pool_lamports, lastPlan.asset_decimals)} {lastPlan.asset_type}</strong></div>
            <div><span>Active rights snapshotted</span><strong>{lastPlan.participant_count} / 125</strong></div>
            <div><span>Planned allocation total</span><strong>{baseUnitsToAmount(lastPlan.total_planned_lamports, lastPlan.asset_decimals)} {lastPlan.asset_type}</strong></div>
          </div>
          {lastPlan.asset_type === "TOKEN" && lastPlan.asset_mint && <div className="treasury-footnote">Token mint: <code>{shortWallet(lastPlan.asset_mint)}</code></div>}
          <div className="treasury-footnote">Master Wallet snapshot: <code>{shortWallet(lastPlan.master_wallet_address)}</code>. Network fees and missing token-account rent are paid by this wallet. Mainnet execution remains locked unless explicitly enabled server-side.</div>
          {lastPlan.status !== "COMPLETED" && lastPlan.status !== "CANCELLED" && (
            <button className="button button-primary treasury-button" type="button" onClick={() => void executePayout()} disabled={executingPayout || lastPlan.status === "PROCESSING"}>
              {executingPayout ? <LoaderCircle size={15} className="spin" /> : <Wallet size={15} />}
              {executingPayout ? "Processing payout batches…" : "Execute payout automatically"}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
