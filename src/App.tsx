import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import {
  Activity, ArrowDownRight, ArrowUpRight, Check, CircleAlert, Clock3,
  Coins, ExternalLink, LogOut, Plus, RefreshCw, ShieldCheck, Users, Wallet, X,
} from "lucide-react";
import { supabase, supabaseConfigured } from "./lib/supabase";
import MultisplitPanel from "./MultisplitPanel";

type Participant = {
  id: string;
  campaign_id: string;
  wallet_address: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  submitted_at: string;
  reviewed_at: string | null;
};
type DistributionRecord = {
  id: string;
  wallet_address: string;
  asset_type: "SOL" | "TOKEN";
  amount: number | string | null;
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
  transaction_signature: string | null;
  created_at: string;
};
type MultisplitRun = {
  id: string;
  eligible_fees_lamports: number | string;
  pool_bps: number;
  participant_bps: number;
  participant_count: number;
  total_pool_lamports: number | string;
  total_planned_lamports: number | string;
  status: "DRAFT" | "APPROVED" | "PROCESSING" | "COMPLETED" | "FAILED" | "CANCELLED";
  created_at: string;
};

const shortWallet = (value: string) => value.length > 18 ? value.slice(0, 8) + "…" + value.slice(-6) : value;
const dateLabel = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const solLabel = (lamports: number | string) => (Number(lamports) / 1_000_000_000).toLocaleString(undefined, { maximumFractionDigits: 6 });
const numberLabel = (value: number) => value.toLocaleString();

function Badge({ value }: { value: string }) {
  const normalized = value.toLowerCase();
  return <span className={`badge badge-${normalized}`}><span className="badge-dot" />{value.replaceAll("_", " ")}</span>;
}

function App() {
  const [session, setSession] = useState<Awaited<ReturnType<typeof supabase.auth.getSession>>["data"]["session"]>(null);
  const [authReady, setAuthReady] = useState(false);
  const [admin, setAdmin] = useState(false);
  const [checkingAdmin, setCheckingAdmin] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [records, setRecords] = useState<DistributionRecord[]>([]);
  const [runs, setRuns] = useState<MultisplitRun[]>([]);
  const [dataBusy, setDataBusy] = useState(false);
  const [dataError, setDataError] = useState("");
  const [filter, setFilter] = useState<"ALL" | Participant["status"]>("ALL");
  const [walletInput, setWalletInput] = useState("");
  const [addingWallet, setAddingWallet] = useState(false);
  const [actionId, setActionId] = useState("");
  const [toast, setToast] = useState("");

  useEffect(() => {
    let mounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (mounted) {
        setSession(data.session);
        setAuthReady(true);
      }
    }).catch(() => { if (mounted) setAuthReady(true); });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setAuthReady(true);
    });
    return () => { mounted = false; subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function verifyAdmin() {
      if (!session) {
        setAdmin(false);
        setCheckingAdmin(false);
        return;
      }
      setCheckingAdmin(true);
      const { data, error } = await supabase
        .from("admin_users")
        .select("user_id")
        .eq("user_id", session.user.id)
        .maybeSingle();
      if (!cancelled) {
        setAdmin(!error && Boolean(data));
        setCheckingAdmin(false);
      }
    }
    void verifyAdmin();
    return () => { cancelled = true; };
  }, [session]);

  const loadData = useCallback(async () => {
    if (!session || !admin) return;
    setDataBusy(true);
    setDataError("");
    const [participantResult, recordResult, runResult] = await Promise.all([
      supabase.from("participants").select("id,campaign_id,wallet_address,status,submitted_at,reviewed_at").order("submitted_at", { ascending: false }).limit(300),
      supabase.from("distribution_records").select("id,wallet_address,asset_type,amount,status,transaction_signature,created_at").order("created_at", { ascending: false }).limit(12),
      supabase.from("multisplit_runs").select("id,eligible_fees_lamports,pool_bps,participant_bps,participant_count,total_pool_lamports,total_planned_lamports,status,created_at").order("created_at", { ascending: false }).limit(8),
    ]);
    const firstError = participantResult.error || recordResult.error || runResult.error;
    if (firstError) {
      setDataError(firstError.message);
    } else {
      setParticipants((participantResult.data ?? []) as Participant[]);
      setRecords((recordResult.data ?? []) as DistributionRecord[]);
      setRuns((runResult.data ?? []) as MultisplitRun[]);
    }
    setDataBusy(false);
  }, [session, admin]);

  useEffect(() => { void loadData(); }, [loadData]);

  const counts = useMemo(() => ({
    total: participants.length,
    pending: participants.filter((p) => p.status === "PENDING").length,
    approved: participants.filter((p) => p.status === "APPROVED").length,
    rejected: participants.filter((p) => p.status === "REJECTED").length,
  }), [participants]);

  const filteredParticipants = useMemo(
    () => filter === "ALL" ? participants : participants.filter((p) => p.status === filter),
    [participants, filter],
  );

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAuthError("");
    setLoginBusy(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) setAuthError(error.message);
    } catch {
      setAuthError("Unable to sign in right now. Check your connection and try again.");
    } finally {
      setLoginBusy(false);
    }
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    setParticipants([]);
    setRecords([]);
    setRuns([]);
  }

  async function reviewParticipant(person: Participant, status: "APPROVED" | "REJECTED") {
    setActionId(person.id);
    setToast("");
    const { error } = await supabase.from("participants")
      .update({ status, reviewed_at: new Date().toISOString() })
      .eq("id", person.id)
      .eq("status", "PENDING");
    if (error) {
      setDataError(error.message);
    } else {
      setToast(`Wallet ${status.toLowerCase()}.`);
      await loadData();
    }
    setActionId("");
  }

  async function addParticipant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const wallet = walletInput.trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) {
      setDataError("Enter a Solana address using Base58 characters (32–44 characters).");
      return;
    }
    setAddingWallet(true);
    setDataError("");
    try {
      const { data: existing, error: lookupError } = await supabase
        .from("participants")
        .select("id")
        .eq("campaign_id", "resurgence-2026")
        .eq("wallet_address", wallet)
        .maybeSingle();
      if (lookupError) {
        setDataError(lookupError.message);
        return;
      }
      if (existing) {
        setDataError("This wallet is already registered for this campaign.");
        return;
      }
      const { error } = await supabase.from("participants").insert({
        wallet_address: wallet,
        campaign_id: "resurgence-2026",
        status: "PENDING",
      });
      if (error) {
        setDataError(error.code === "23505" ? "This wallet is already registered for this campaign." : error.message);
      } else {
        setWalletInput("");
        setToast("Wallet added to the pending review queue.");
        await loadData();
      }
    } catch {
      setDataError("Unable to add the wallet right now. Check the connection and try again.");
    } finally {
      setAddingWallet(false);
    }
  }

  if (!supabaseConfigured) {
    return <main className="center-screen"><section className="auth-card">
      <div className="brand-mark"><ShieldCheck size={24} /></div>
      <p className="eyebrow">CONFIGURATION REQUIRED</p><h1>Connect Supabase</h1>
      <p className="muted">Set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> in your local environment or deployment variables before using the portal.</p>
      <p className="tiny muted">Use the publishable/anon key only. Never add a service-role key or wallet secret.</p>
    </section></main>;
  }

  if (!authReady || checkingAdmin) {
    return <main className="center-screen"><div className="loading-ring" /><p className="muted">Checking secure session…</p></main>;
  }

  if (!session) {
    return <main className="center-screen">
      <section className="auth-card">
        <div className="brand-row"><div className="brand-mark"><ShieldCheck size={24} /></div><div><p className="eyebrow">CREATOR FEE OPERATIONS</p><span className="brand-name">THE RESURGENCE</span></div></div>
        <h1>Rewards, in clear view.</h1>
        <p className="muted">Private operator access for participant review, allocation planning and audit visibility.</p>
        <form className="login-form" onSubmit={handleLogin}>
          <label>Email address<input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="operator@example.com" /></label>
          <label>Password<input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter your password" /></label>
          {authError && <div className="alert alert-error"><CircleAlert size={16} />{authError}</div>}
          <button className="button button-primary button-full" type="submit" disabled={loginBusy}>{loginBusy ? "Signing in…" : "Sign in securely"}</button>
        </form>
        <div className="security-note"><ShieldCheck size={16} /><span>Admin access is allowlisted in Supabase. The frontend cannot grant itself admin privileges.</span></div>
      </section>
      <footer className="page-footer">THE RESURGENCE <span>•</span> REWARDS PORTAL</footer>
    </main>;
  }

  if (!admin) {
    return <main className="center-screen"><section className="auth-card">
      <div className="brand-mark warning-mark"><ShieldCheck size={24} /></div>
      <p className="eyebrow">ACCOUNT SIGNED IN</p><h1>Admin access not enabled</h1>
      <p className="muted">This account is not listed in <code>public.admin_users</code>. Ask the project owner to provision the admin role in the Supabase SQL Editor.</p>
      <button className="button button-secondary button-full" onClick={() => void handleLogout()}><LogOut size={16} /> Sign out</button>
    </section></main>;
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand-row sidebar-brand"><div className="brand-mark"><ShieldCheck size={22} /></div><div><span className="brand-name">THE RESURGENCE</span><span className="brand-subtitle">REWARDS OPERATIONS</span></div></div>
      <div className="side-label">WORKSPACE</div>
      <a className="nav-item nav-item-active" href="#overview"><Activity size={17} /> Overview</a>
      <a className="nav-item" href="#participants"><Users size={17} /> Participants <span className="nav-count">{counts.pending}</span></a>
      <a className="nav-item" href="#ledger"><Coins size={17} /> Allocation ledger</a>
      <a className="nav-item" href="#treasury"><Wallet size={17} /> Treasury &amp; multisplit</a>
      <div className="sidebar-bottom"><div className="online-dot" /><div><strong>Supabase session</strong><span>Authenticated operator</span></div></div>
    </aside>

    <main className="main-panel">
      <header className="topbar">
        <div className="breadcrumb">Workspace <span>/</span> Overview</div>
        <div className="top-actions"><span className="live-label"><span className="online-dot" /> Session active</span><button className="icon-button" onClick={() => void loadData()} aria-label="Refresh data" title="Refresh data"><RefreshCw size={17} className={dataBusy ? "spin" : ""} /></button><button className="profile-button" title={session.user.email ?? "Operator"}><span className="profile-avatar">{(session.user.email ?? "O").slice(0, 1).toUpperCase()}</span><span className="profile-email">{session.user.email}</span></button><button className="icon-button" onClick={() => void handleLogout()} aria-label="Sign out" title="Sign out"><LogOut size={17} /></button></div>
      </header>

      <section id="overview" className="content">
        <div className="page-heading">
          <div><p className="eyebrow">MONITORING / CAMPAIGN 2026</p><h1>Operations overview</h1><p className="muted">Review wallets, inspect allocation plans, and keep an auditable record.</p></div>
          <div className="heading-status"><span className="status-pulse" /> Admin session verified</div>
        </div>

        <div className="notice-strip"><ShieldCheck size={18} /><div><strong>Transfer safety is on</strong><span>This portal does not send SOL or tokens. Allocation figures are plans, not confirmed payouts.</span></div><Badge value="READ / REVIEW" /></div>

        {dataError && <div className="alert alert-error"><CircleAlert size={17} /><span>{dataError}</span><button className="alert-close" onClick={() => setDataError("")} aria-label="Dismiss error"><X size={16} /></button></div>}
        {toast && <div className="alert alert-success"><Check size={17} /><span>{toast}</span><button className="alert-close" onClick={() => setToast("")} aria-label="Dismiss message"><X size={16} /></button></div>}

        <div className="stats-grid">
          <article className="stat-card"><div className="stat-top"><span>Registered wallets</span><div className="stat-icon"><Wallet size={17} /></div></div><div className="stat-value">{numberLabel(counts.total)}</div><div className="stat-bottom"><span className="stat-sub">All campaign participants</span><span className="stat-arrow"><Users size={14} /></span></div></article>
          <article className="stat-card"><div className="stat-top"><span>Pending review</span><div className="stat-icon gold"><Clock3 size={17} /></div></div><div className="stat-value">{numberLabel(counts.pending)}</div><div className="stat-bottom"><span className="stat-sub">Waiting for one-time approval</span><span className="stat-arrow"><ArrowDownRight size={14} /></span></div></article>
          <article className="stat-card"><div className="stat-top"><span>Approved wallets</span><div className="stat-icon green"><Check size={17} /></div></div><div className="stat-value">{numberLabel(counts.approved)}</div><div className="stat-bottom"><span className="stat-sub">Included in eligible set</span><span className="stat-arrow"><ArrowUpRight size={14} /></span></div></article>
          <article className="stat-card"><div className="stat-top"><span>Allocation runs</span><div className="stat-icon violet"><Activity size={17} /></div></div><div className="stat-value">{numberLabel(runs.length)}</div><div className="stat-bottom"><span className="stat-sub">Latest 8 planning records</span><span className="stat-arrow"><Coins size={14} /></span></div></article>
        </div>

        <MultisplitPanel onPlanCreated={() => void loadData()} />

        <div className="content-grid">
          <section id="participants" className="panel participants-panel">
            <div className="panel-heading"><div><h2>Participant review</h2><p>Review each wallet once before it enters the eligible set.</p></div><span className="panel-count">{counts.pending} pending</span></div>
            <form className="add-wallet-form" onSubmit={addParticipant}><div className="input-with-icon"><Wallet size={16} /><input aria-label="Solana wallet address" value={walletInput} onChange={(e) => setWalletInput(e.target.value)} placeholder="Add Solana wallet address…" minLength={32} maxLength={44} /></div><button className="button button-secondary" type="submit" disabled={addingWallet || !walletInput.trim()}><Plus size={16} />{addingWallet ? "Adding…" : "Add wallet"}</button></form>
            <div className="filter-row">{(["ALL", "PENDING", "APPROVED", "REJECTED"] as const).map((item) => <button key={item} className={filter === item ? "filter-pill filter-pill-active" : "filter-pill"} onClick={() => setFilter(item)}>{item === "ALL" ? "All wallets" : item.charAt(0) + item.slice(1).toLowerCase()}{item === "PENDING" ? <span>{counts.pending}</span> : null}</button>)}</div>
            <div className="table-wrap"><table><thead><tr><th>WALLET</th><th>SUBMITTED</th><th>STATUS</th><th className="right-align">REVIEW</th></tr></thead><tbody>
              {dataBusy && participants.length === 0 ? <tr><td colSpan={4} className="empty-cell">Loading wallet records…</td></tr> : filteredParticipants.length === 0 ? <tr><td colSpan={4} className="empty-cell"><div className="empty-icon"><Users size={19} /></div><strong>No wallets in this view</strong><span>New entries will appear here when added.</span></td></tr> : filteredParticipants.map((person) => <tr key={person.id}><td><div className="wallet-cell"><span className="wallet-token"><Wallet size={14} /></span><span><strong>{shortWallet(person.wallet_address)}</strong><small>{person.campaign_id}</small></span><button className="copy-link" title="Open Solscan address" onClick={() => window.open(`https://solscan.io/account/${encodeURIComponent(person.wallet_address)}`, "_blank", "noopener,noreferrer")}><ExternalLink size={13} /></button></div></td><td className="date-cell">{dateLabel(person.submitted_at)}</td><td><Badge value={person.status} /></td><td className="right-align">{person.status === "PENDING" ? <div className="review-actions"><button className="review-approve" disabled={actionId === person.id} onClick={() => void reviewParticipant(person, "APPROVED")} title="Approve wallet" aria-label="Approve wallet"><Check size={15} /></button><button className="review-reject" disabled={actionId === person.id} onClick={() => void reviewParticipant(person, "REJECTED")} title="Reject wallet" aria-label="Reject wallet"><X size={15} /></button></div> : <span className="reviewed-label">{person.reviewed_at ? "Reviewed" : "—"}</span>}</td></tr>)}
            </tbody></table></div>
            <div className="panel-footer">Showing up to 300 most recent participant records <span>·</span> {filteredParticipants.length} in view</div>
          </section>

          <section id="allocations" className="panel runs-panel">
            <div className="panel-heading"><div><h2>Allocation plans</h2><p>Recent multisplit planning ledger</p></div><div className="panel-heading-icon"><Coins size={17} /></div></div>
            {runs.length === 0 ? <div className="empty-run"><div className="empty-icon"><Activity size={19} /></div><strong>No allocation plans yet</strong><span>Future plans will appear after they are generated and reviewed.</span></div> : <div className="run-list">{runs.map((run) => <article className="run-item" key={run.id}><div className="run-head"><div><strong>{run.id.slice(0, 8).toUpperCase()}</strong><small>{dateLabel(run.created_at)}</small></div><Badge value={run.status} /></div><div className="run-metrics"><div><span>Eligible fee base</span><strong>{solLabel(run.eligible_fees_lamports)} SOL</strong></div><div><span>Pool target</span><strong>{(run.pool_bps / 100).toFixed(2)}%</strong></div><div><span>Recipients</span><strong>{run.participant_count}</strong></div></div><div className="run-allocation"><span>Planned amount</span><strong>{solLabel(run.total_planned_lamports)} SOL</strong></div></article>)}</div>}
            <div className="ledger-note"><CircleAlert size={16} /><span>Lamports are converted for display only. A planned value is not proof of a routed or confirmed on-chain reward.</span></div>
          </section>
        </div>

        <section id="ledger" className="panel ledger-panel">
          <div className="panel-heading"><div><h2>Latest distribution records</h2><p>Audit view of ledger entries and transaction signatures.</p></div><span className="panel-count">Recent activity</span></div>
          <div className="table-wrap"><table><thead><tr><th>RECIPIENT WALLET</th><th>ASSET</th><th>AMOUNT</th><th>CREATED</th><th>STATUS</th><th>TRANSACTION</th></tr></thead><tbody>
            {records.length === 0 ? <tr><td colSpan={6} className="empty-cell compact-empty">No distribution ledger records yet.</td></tr> : records.map((record) => <tr key={record.id}><td><strong className="mono">{shortWallet(record.wallet_address)}</strong></td><td><span className="asset-pill">{record.asset_type}</span></td><td className="amount-cell">{record.amount == null ? "—" : Number(record.amount).toLocaleString(undefined, { maximumFractionDigits: 9 })} {record.asset_type}</td><td className="date-cell">{dateLabel(record.created_at)}</td><td><Badge value={record.status} /></td><td>{record.transaction_signature ? <a className="tx-link" href={`https://solscan.io/tx/${encodeURIComponent(record.transaction_signature)}`} target="_blank" rel="noreferrer">View tx <ExternalLink size={12} /></a> : <span className="muted">Not recorded</span>}</td></tr>)}
          </tbody></table></div>
          <div className="panel-footer">On-chain status must be independently verified against the transaction signature. This portal does not send transactions.</div>
        </section>
        <footer className="app-footer"><span>THE RESURGENCE <span className="footer-separator">/</span> REWARDS OPERATIONS</span><span><span className="online-dot" /> Session protected by Supabase Auth + RLS</span></footer>
      </section>
    </main>
  </div>;
}

export default App;
