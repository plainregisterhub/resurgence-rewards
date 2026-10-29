import { createClient } from "https://esm.sh/@supabase/supabase-js@2.58.0";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "https://esm.sh/@solana/web3.js@1.98.4?target=deno";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddress,
  getMint,
} from "https://esm.sh/@solana/spl-token@0.4.13?target=deno";

const ALLOWED_ORIGINS = new Set([
  "https://plainregisterhub.github.io",
  "http://localhost:5173",
]);
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const MAX_SOLANA_TX_BYTES = 1232;
const CAMPAIGN_ID = "resurgence-2026";

type Run = {
  id: string;
  campaign_id: string;
  eligible_fees_lamports: string | number;
  pool_bps: number;
  participant_bps: number;
  participant_count: number;
  total_pool_lamports: string | number;
  total_planned_lamports: string | number;
  master_wallet_address: string;
  status: string;
  asset_type: "SOL" | "TOKEN";
  asset_mint: string | null;
  asset_decimals: number;
  execution_lock_until: string | null;
  payout_cluster: string | null;
};

type Item = {
  id: string;
  participant_id: string;
  wallet_address: string;
  amount_lamports: string | number;
  status: string;
  transaction_signature: string | null;
};

type Batch = {
  id: string;
  run_id: string;
  batch_index: number;
  attempt_no: number;
  item_ids: string[];
  status: "SIGNED" | "SUBMITTED" | "CONFIRMED" | "FAILED";
  transaction_signature: string | null;
  signed_transaction: string | null;
  recent_blockhash: string | null;
  last_valid_block_height: number | null;
  error_message: string | null;
};

function base58Decode(value: string): Uint8Array {
  if (!value || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(value)) {
    throw new Error("The payout key is not valid Base58.");
  }
  let number = 0n;
  for (const char of value) {
    const digit = BASE58.indexOf(char);
    if (digit < 0) throw new Error("The payout key is not valid Base58.");
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

function base58Encode(value: Uint8Array): string {
  let number = 0n;
  for (const byte of value) number = (number << 8n) + BigInt(byte);
  let encoded = "";
  while (number > 0n) {
    const remainder = Number(number % 58n);
    encoded = BASE58[remainder] + encoded;
    number /= 58n;
  }
  for (const byte of value) {
    if (byte !== 0) break;
    encoded = "1" + encoded;
  }
  return encoded || "1";
}

function base64Encode(value: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < value.length; offset += 0x8000) {
    binary += String.fromCharCode(...value.subarray(offset, Math.min(offset + 0x8000, value.length)));
  }
  return btoa(binary);
}

function base64Decode(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function getPayoutKeypair(secret: string): Keypair {
  const trimmed = secret.trim();
  let keyBytes: Uint8Array;
  if (trimmed.startsWith("[")) {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || parsed.some((v) => !Number.isInteger(v) || v < 0 || v > 255)) {
      throw new Error("RESURGENCE_PAYOUT_SECRET_KEY must be a Base58 key or JSON byte array.");
    }
    keyBytes = Uint8Array.from(parsed as number[]);
  } else {
    keyBytes = base58Decode(trimmed);
  }
  if (keyBytes.length !== 64) {
    throw new Error("RESURGENCE_PAYOUT_SECRET_KEY must decode to a 64-byte Solana keypair.");
  }
  return Keypair.fromSecretKey(keyBytes);
}

function json(data: unknown, status = 200, origin?: string | null): Response {
  const allowOrigin = origin && ALLOWED_ORIGINS.has(origin)
    ? origin
    : "https://plainregisterhub.github.io";
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": allowOrigin,
      "Vary": "Origin",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    },
  });
}

function toBaseUnits(value: string | number, decimals: number): bigint {
  const raw = String(value);
  if (!/^\d+(\.\d+)?$/.test(raw)) throw new Error("A planned amount is not a valid decimal value.");
  const [whole, fractional = ""] = raw.split(".");
  if (fractional.length > decimals && /[^0]/.test(fractional.slice(decimals))) {
    throw new Error("A planned amount has more precision than the configured asset decimals.");
  }
  const fraction = fractional.slice(0, decimals).padEnd(decimals, "0");
  return BigInt(whole) * (10n ** BigInt(decimals)) + BigInt(fraction || "0");
}

function fromBaseUnits(value: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  if (decimals === 0) return whole.toString();
  const fraction = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? whole.toString() + "." + fraction : whole.toString();
}

function chunks<T>(values: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let i = 0; i < values.length; i += size) output.push(values.slice(i, i + size));
  return output;
}

async function requireAdmin(req: Request, supabase: ReturnType<typeof createClient>) {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) throw Object.assign(new Error("A valid admin session is required."), { status: 401 });

  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  const user = userData?.user;
  if (userError || !user) throw Object.assign(new Error("Admin session is invalid or expired."), { status: 401 });

  const { data: adminRecord, error: adminError } = await supabase
    .from("admin_users")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (adminError) throw new Error("Unable to verify the admin allowlist.");
  if (!adminRecord) throw Object.assign(new Error("Admin access required."), { status: 403 });
  return user;
}

async function getBatchStatus(connection: Connection, signature: string) {
  const response = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
  return response.value[0];
}

async function saveBatchState(
  supabase: ReturnType<typeof createClient>,
  batchId: string,
  values: Record<string, unknown>,
) {
  const { error } = await supabase.from("resurgence_payout_batches")
    .update({ ...values, updated_at: new Date().toISOString() })
    .eq("id", batchId);
  if (error) throw new Error("Could not persist payout batch state: " + error.message);
}

async function settleBatch(
  supabase: ReturnType<typeof createClient>,
  run: Run,
  batch: Batch,
  items: Item[],
) {
  if (!batch.transaction_signature) throw new Error("A confirmed batch has no transaction signature.");
  const batchItems = items.filter((item) => batch.item_ids.includes(item.id));
  if (batchItems.length !== batch.item_ids.length) {
    throw new Error("The stored payout batch no longer matches its payout items.");
  }

  const updates = await supabase.from("multisplit_items")
    .update({ status: "COMPLETED", transaction_signature: batch.transaction_signature })
    .in("id", batch.item_ids);
  if (updates.error) throw new Error("Transaction confirmed, but recipient statuses could not be saved: " + updates.error.message);

  const records = batchItems.map((item) => ({
    participant_id: item.participant_id,
    wallet_address: item.wallet_address,
    asset_type: run.asset_type === "SOL" ? "SOL" : "TOKEN",
    asset_mint: run.asset_type === "TOKEN" ? run.asset_mint : null,
    amount: fromBaseUnits(toBaseUnits(item.amount_lamports, run.asset_decimals), run.asset_decimals),
    status: "COMPLETED",
    transaction_signature: batch.transaction_signature,
    payout_item_id: item.id,
    completed_at: new Date().toISOString(),
    cluster: run.payout_cluster ?? "devnet",
  }));
  const ledger = await supabase.from("distribution_records")
    .upsert(records, { onConflict: "payout_item_id" });
  if (ledger.error) throw new Error("Transaction confirmed, but the distribution ledger could not be saved: " + ledger.error.message);
}

function transactionBytes(tx: Transaction): Uint8Array {
  const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  if (bytes.length > MAX_SOLANA_TX_BYTES) {
    throw new Error("The payout batch exceeds Solana's 1,232-byte transaction limit. Reduce the batch size.");
  }
  return bytes;
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  if (origin && !ALLOWED_ORIGINS.has(origin)) return json({ error: "Origin not allowed." }, 403, origin);
  if (req.method === "OPTIONS") return json({ ok: true }, 200, origin);
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405, origin);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return json({ error: "Payout backend is not configured." }, 503, origin);
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const user = await requireAdmin(req, supabase);
    const body = await req.json().catch(() => ({}));
    const runId = typeof body.runId === "string" ? body.runId : "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) {
      return json({ error: "A valid payout run ID is required." }, 400, origin);
    }

    if (Deno.env.get("RESURGENCE_PAYOUT_ENABLED") !== "true") {
      return json({
        error: "Payout execution is locked. Configure and test the server-side payout signer before enabling transfers.",
        code: "PAYOUT_EXECUTION_DISABLED",
      }, 503, origin);
    }
    const cluster = Deno.env.get("RESURGENCE_PAYOUT_CLUSTER") ?? "devnet";
    if (cluster !== "devnet" && cluster !== "mainnet-beta") {
      return json({ error: "RESURGENCE_PAYOUT_CLUSTER must be devnet or mainnet-beta." }, 503, origin);
    }
    if (cluster === "mainnet-beta" && Deno.env.get("RESURGENCE_PAYOUT_MAINNET_ENABLED") !== "true") {
      return json({ error: "Mainnet payouts are locked until RESURGENCE_PAYOUT_MAINNET_ENABLED is explicitly set to true." }, 503, origin);
    }
    const secret = Deno.env.get("RESURGENCE_PAYOUT_SECRET_KEY");
    if (!secret) return json({ error: "Server-side payout signer is not configured." }, 503, origin);

    const signer = getPayoutKeypair(secret);
    const rpcUrl = Deno.env.get("SOLANA_RPC_URL") ??
      (cluster === "mainnet-beta" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com");
    if (!rpcUrl.startsWith("https://") && !rpcUrl.startsWith("http://localhost")) {
      return json({ error: "SOLANA_RPC_URL must use HTTPS except for local development." }, 503, origin);
    }
    const connection = new Connection(rpcUrl, { commitment: "confirmed" });

    const { data: runData, error: runError } = await supabase.from("multisplit_runs")
      .select("id,campaign_id,eligible_fees_lamports,pool_bps,participant_bps,participant_count,total_pool_lamports,total_planned_lamports,master_wallet_address,status,asset_type,asset_mint,asset_decimals,execution_lock_until,payout_cluster")
      .eq("id", runId)
      .eq("campaign_id", CAMPAIGN_ID)
      .maybeSingle();
    if (runError) throw new Error("Could not load payout run: " + runError.message);
    if (!runData) return json({ error: "Payout run not found." }, 404, origin);
    const run = runData as Run;

    if (run.status === "COMPLETED") {
      return json({ success: true, status: "COMPLETED", alreadyCompleted: true, runId, confirmedBatches: 0 }, 200, origin);
    }
    if (run.asset_type !== "SOL" && run.asset_type !== "TOKEN") {
      return json({ error: "This payout run uses an unsupported asset type." }, 400, origin);
    }
    if (signer.publicKey.toBase58() !== run.master_wallet_address) {
      return json({ error: "Configured signer does not match the Master Wallet saved in this payout run." }, 409, origin);
    }

    const { data: treasuryRows, error: treasuryError } = await supabase
      .from("resurgence_treasury_config")
      .select("master_wallet_address")
      .eq("campaign_id", CAMPAIGN_ID)
      .maybeSingle();
    if (treasuryError || !treasuryRows) throw new Error("Unable to verify the current Master Wallet configuration.");
    if (treasuryRows.master_wallet_address !== run.master_wallet_address) {
      return json({ error: "The Master Wallet configuration changed after this plan was created. Create a fresh payout plan." }, 409, origin);
    }

    const { data: claimRows, error: claimError } = await supabase.rpc("claim_resurgence_payout_run", {
      p_run_id: runId,
      p_lease_seconds: 180,
    });
    if (claimError) throw new Error("Could not claim payout run: " + claimError.message);
    const claim = Array.isArray(claimRows) ? claimRows[0] : claimRows;
    if (!claim?.acquired) {
      if (claim?.run_status === "COMPLETED") {
        return json({ success: true, status: "COMPLETED", alreadyCompleted: true, runId, confirmedBatches: 0 }, 200, origin);
      }
      return json({ error: "This payout run is already being processed. Refresh the ledger before retrying.", status: claim?.run_status ?? "UNKNOWN" }, 409, origin);
    }

    const { error: clusterUpdateError } = await supabase.from("multisplit_runs")
      .update({ payout_cluster: cluster })
      .eq("id", runId);
    if (clusterUpdateError) throw new Error("Could not save payout cluster: " + clusterUpdateError.message);
    run.payout_cluster = cluster;

    let confirmedThisCall = 0;
    try {
      const { data: itemRows, error: itemError } = await supabase.from("multisplit_items")
        .select("id,participant_id,wallet_address,amount_lamports,status,transaction_signature")
        .eq("run_id", runId)
        .order("created_at", { ascending: true });
      if (itemError) throw new Error("Could not load payout recipients: " + itemError.message);
      const items = (itemRows ?? []) as Item[];
      if (items.length !== run.participant_count || items.length < 1 || items.length > 125) {
        throw new Error("Recipient count does not match this payout plan or exceeds the 125-wallet cap.");
      }
      if (new Set(items.map((item) => item.wallet_address)).size !== items.length) {
        throw new Error("Duplicate recipient addresses were found. No payments were sent.");
      }
      if (items.some((item) => item.wallet_address === signer.publicKey.toBase58())) {
        throw new Error("The Master Wallet is also a payout recipient. Remove it from the participant set before paying.");
      }
      const totalUnits = items.reduce((sum, item) => {
        const amount = toBaseUnits(item.amount_lamports, run.asset_decimals);
        if (amount <= 0n) throw new Error("Every recipient amount must be greater than zero.");
        return sum + amount;
      }, 0n);
      if (totalUnits !== BigInt(String(run.total_planned_lamports))) {
        throw new Error("Recipient amounts do not equal the payout plan total. No payments were sent.");
      }

      const mint = run.asset_type === "TOKEN" && run.asset_mint ? new PublicKey(run.asset_mint) : null;
      let sourceTokenAccount: PublicKey | null = null;
      let tokenRecipientAta = new Map<string, { ata: PublicKey; exists: boolean }>();
      let missingAtaCount = 0;
      if (run.asset_type === "TOKEN") {
        if (!mint) throw new Error("The token payout plan has no mint address.");
        const mintInfo = await getMint(connection, mint, "confirmed", TOKEN_PROGRAM_ID);
        if (mintInfo.decimals !== run.asset_decimals) {
          throw new Error("The SPL mint decimals do not match this payout plan.");
        }
        sourceTokenAccount = await getAssociatedTokenAddress(mint, signer.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
        const source = await getAccount(connection, sourceTokenAccount, "confirmed", TOKEN_PROGRAM_ID);
        if (source.owner.toBase58() !== signer.publicKey.toBase58() || source.mint.toBase58() !== mint.toBase58()) {
          throw new Error("Master Wallet's associated token account does not match the configured mint.");
        }
        if (source.amount < totalUnits) {
          throw new Error("The Master Wallet token balance is below the planned payout total.");
        }
        for (const item of items) {
          const owner = new PublicKey(item.wallet_address);
          const ata = await getAssociatedTokenAddress(mint, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
          const info = await connection.getAccountInfo(ata, "confirmed");
          let exists = false;
          if (info) {
            const account = await getAccount(connection, ata, "confirmed", TOKEN_PROGRAM_ID);
            if (account.owner.toBase58() !== owner.toBase58() || account.mint.toBase58() !== mint.toBase58()) {
              throw new Error("A recipient's associated token account is invalid. No payments were sent.");
            }
            exists = true;
          } else {
            missingAtaCount++;
          }
          tokenRecipientAta.set(item.id, { ata, exists });
        }
      }

      const batchSize = run.asset_type === "SOL" ? 10 : 4;
      const groups = chunks(items, batchSize);
      const feeReserveLamports = BigInt(groups.length) * 15_000n;
      const masterSolBalance = BigInt(await connection.getBalance(signer.publicKey, "confirmed"));
      let requiredSol = feeReserveLamports;
      if (run.asset_type === "SOL") requiredSol += totalUnits;
      else if (missingAtaCount > 0) {
        requiredSol += BigInt(await connection.getMinimumBalanceForRentExemption(165, "confirmed")) * BigInt(missingAtaCount);
      }
      if (masterSolBalance < requiredSol) {
        throw new Error("The Master Wallet does not have enough SOL to cover the planned transfers, network fees and any token accounts that must be created.");
      }

      const { data: existingRows, error: batchError } = await supabase.from("resurgence_payout_batches")
        .select("id,run_id,batch_index,attempt_no,item_ids,status,transaction_signature,signed_transaction,recent_blockhash,last_valid_block_height,error_message")
        .eq("run_id", runId)
        .order("batch_index", { ascending: true })
        .order("attempt_no", { ascending: true });
      if (batchError) throw new Error("Could not load payout batch ledger: " + batchError.message);
      const allBatches = (existingRows ?? []) as Batch[];
      const latestByIndex = new Map<number, Batch>();
      for (const batch of allBatches) {
        const current = latestByIndex.get(batch.batch_index);
        if (!current || batch.attempt_no > current.attempt_no) latestByIndex.set(batch.batch_index, batch);
      }

      for (let batchIndex = 0; batchIndex < groups.length; batchIndex++) {
        const batchItems = groups[batchIndex];
        let currentBatch = latestByIndex.get(batchIndex);
        if (currentBatch && JSON.stringify(currentBatch.item_ids) !== JSON.stringify(batchItems.map((item) => item.id))) {
          throw new Error("The payout batch recipient snapshot changed. Stop and reconcile before attempting payment.");
        }

        if (currentBatch?.transaction_signature && currentBatch.signed_transaction) {
          const knownStatus = await getBatchStatus(connection, currentBatch.transaction_signature);
          if (knownStatus && !knownStatus.err &&
              (knownStatus.confirmationStatus === "confirmed" || knownStatus.confirmationStatus === "finalized")) {
            if (currentBatch.status !== "CONFIRMED") {
              await saveBatchState(supabase, currentBatch.id, { status: "CONFIRMED", confirmed_at: new Date().toISOString(), error_message: null });
              currentBatch = { ...currentBatch, status: "CONFIRMED" };
            }
            await settleBatch(supabase, run, currentBatch, items);
            if (currentBatch.status === "CONFIRMED") continue;
          }

          if (knownStatus?.err) {
            await saveBatchState(supabase, currentBatch.id, {
              status: "FAILED",
              error_message: "The Solana network reported that this transaction failed on-chain; no recipient instructions were committed.",
            });
            currentBatch = { ...currentBatch, status: "FAILED" };
            latestByIndex.set(batchIndex, currentBatch);
          } else if (currentBatch.status === "CONFIRMED") {
            await settleBatch(supabase, run, currentBatch, items);
            continue;
          } else {
            const blockHeight = await connection.getBlockHeight("confirmed");
            const lastValid = Number(currentBatch.last_valid_block_height ?? 0);
            if (lastValid > 0 && blockHeight > lastValid) {
              await saveBatchState(supabase, currentBatch.id, {
                status: "FAILED",
                error_message: "The saved transaction's blockhash expired without a retrievable signature status. It was not rebuilt to avoid a possible duplicate payment; reconcile this signature before retrying.",
              });
              throw new Error("A previous batch expired without a conclusive signature status. Reconcile its signature before retrying to prevent duplicate payments.");
            }
          }
        }

        // A previously failed on-chain transaction can be retried only when the
        // RPC explicitly reported that the signed transaction failed atomically.
        const latest = latestByIndex.get(batchIndex);
        let batchToSend = latest;
        if (latest?.status === "FAILED" && latest.transaction_signature && latest.signed_transaction) {
          const knownStatus = await getBatchStatus(connection, latest.transaction_signature);
          if (!knownStatus?.err) {
            throw new Error("A failed batch has no confirmed on-chain error. Refusing to create a replacement transaction until it is reconciled.");
          }
          batchToSend = undefined;
        } else if (latest?.status === "CONFIRMED") {
          await settleBatch(supabase, run, latest, items);
          continue;
        }

        if (!batchToSend) {
          const attemptNo = (latest?.attempt_no ?? 0) + 1;
          const latestBlockhash = await connection.getLatestBlockhash("confirmed");
          const transaction = new Transaction({
            feePayer: signer.publicKey,
            recentBlockhash: latestBlockhash.blockhash,
          });

          if (run.asset_type === "SOL") {
            for (const item of batchItems) {
              const amount = toBaseUnits(item.amount_lamports, 9);
              if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("A SOL amount exceeds the safe transaction encoding range.");
              transaction.add(SystemProgram.transfer({
                fromPubkey: signer.publicKey,
                toPubkey: new PublicKey(item.wallet_address),
                lamports: Number(amount),
              }));
            }
          } else {
            if (!mint || !sourceTokenAccount) throw new Error("Token transfer configuration is incomplete.");
            for (const item of batchItems) {
              const owner = new PublicKey(item.wallet_address);
              const recipient = tokenRecipientAta.get(item.id);
              if (!recipient) throw new Error("A recipient token account was not prepared.");
              transaction.add(createAssociatedTokenAccountIdempotentInstruction(
                signer.publicKey, recipient.ata, owner, mint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
              ));
              transaction.add(createTransferCheckedInstruction(
                sourceTokenAccount,
                mint,
                recipient.ata,
                signer.publicKey,
                toBaseUnits(item.amount_lamports, run.asset_decimals),
                run.asset_decimals,
                [],
                TOKEN_PROGRAM_ID,
              ));
            }
          }

          transactionBytes(transaction);
          transaction.sign(signer);
          const raw = transaction.serialize();
          if (raw.length > MAX_SOLANA_TX_BYTES) throw new Error("Signed transaction exceeds Solana's transaction size limit.");
          if (!transaction.signature) throw new Error("The payout transaction was not signed by the Master Wallet.");
          const signature = base58Encode(transaction.signature);
          const { data: inserted, error: insertError } = await supabase.from("resurgence_payout_batches")
            .insert({
              run_id: runId,
              batch_index: batchIndex,
              attempt_no: attemptNo,
              item_ids: batchItems.map((item) => item.id),
              status: "SIGNED",
              transaction_signature: signature,
              signed_transaction: base64Encode(raw),
              recent_blockhash: latestBlockhash.blockhash,
              last_valid_block_height: latestBlockhash.lastValidBlockHeight,
            })
            .select("id,run_id,batch_index,attempt_no,item_ids,status,transaction_signature,signed_transaction,recent_blockhash,last_valid_block_height,error_message")
            .single();
          if (insertError || !inserted) throw new Error("Could not safely persist the signed transaction before broadcast: " + (insertError?.message ?? "No batch returned."));
          batchToSend = inserted as Batch;
          latestByIndex.set(batchIndex, batchToSend);
        }

        if (!batchToSend?.signed_transaction || !batchToSend.transaction_signature || !batchToSend.recent_blockhash) {
          throw new Error("Payout batch is missing its durable signed transaction data.");
        }
        const rawTransaction = base64Decode(batchToSend.signed_transaction);
        const knownStatus = await getBatchStatus(connection, batchToSend.transaction_signature);
        if (knownStatus && !knownStatus.err &&
            (knownStatus.confirmationStatus === "confirmed" || knownStatus.confirmationStatus === "finalized")) {
          await saveBatchState(supabase, batchToSend.id, { status: "CONFIRMED", confirmed_at: new Date().toISOString(), error_message: null });
          const confirmedBatch = { ...batchToSend, status: "CONFIRMED" as const };
          await settleBatch(supabase, run, confirmedBatch, items);
          confirmedThisCall++;
          continue;
        }
        if (knownStatus?.err) {
          await saveBatchState(supabase, batchToSend.id, { status: "FAILED", error_message: "The Solana network reported an on-chain transaction failure." });
          throw new Error("A payout batch failed on-chain. It is recorded as failed; retry after checking the ledger.");
        }

        const broadcastSignature = await connection.sendRawTransaction(rawTransaction, {
          skipPreflight: false,
          preflightCommitment: "confirmed",
          maxRetries: 5,
        });
        if (broadcastSignature !== batchToSend.transaction_signature) {
          throw new Error("The RPC returned a signature that differs from the persisted signed transaction.");
        }
        await saveBatchState(supabase, batchToSend.id, { status: "SUBMITTED", error_message: null });
        const latestBlockhash = {
          blockhash: batchToSend.recent_blockhash,
          lastValidBlockHeight: Number(batchToSend.last_valid_block_height),
        };
        const confirmation = await connection.confirmTransaction({
          signature: batchToSend.transaction_signature,
          blockhash: latestBlockhash.blockhash,
          lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        }, "confirmed");
        if (confirmation.value.err) {
          await saveBatchState(supabase, batchToSend.id, {
            status: "FAILED",
            error_message: "The Solana network reported an on-chain transaction failure.",
          });
          throw new Error("A payout batch failed on-chain. It is recorded as failed.");
        }

        await saveBatchState(supabase, batchToSend.id, { status: "CONFIRMED", confirmed_at: new Date().toISOString(), error_message: null });
        const confirmedBatch = { ...batchToSend, status: "CONFIRMED" as const };
        await settleBatch(supabase, run, confirmedBatch, items);
        confirmedThisCall++;

        await supabase.from("multisplit_runs")
          .update({ execution_lock_until: new Date(Date.now() + 180_000).toISOString() })
          .eq("id", runId);
      }

      const { error: completeError } = await supabase.from("multisplit_runs")
        .update({ status: "COMPLETED", execution_lock_until: null, execution_error: null })
        .eq("id", runId)
        .eq("status", "PROCESSING");
      if (completeError) throw new Error("All batches confirmed but final run status could not be saved: " + completeError.message);

      return json({
        success: true,
        status: "COMPLETED",
        runId,
        assetType: run.asset_type,
        recipientCount: items.length,
        confirmedBatches: groups.length,
        cluster,
        initiatedBy: user.id,
      }, 200, origin);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The payout failed for an unknown reason.";
      await supabase.from("multisplit_runs")
        .update({ status: "FAILED", execution_lock_until: null, execution_error: message })
        .eq("id", runId)
        .eq("status", "PROCESSING");
      return json({
        error: message,
        status: "FAILED",
        runId,
        batchesConfirmedThisCall: confirmedThisCall,
        safety: "Confirmed batches remain recorded. Expired transactions with unclear status are not automatically rebuilt.",
      }, 409, origin);
    }
  } catch (error) {
    const status = Number((error as { status?: number })?.status ?? 400);
    return json({ error: error instanceof Error ? error.message : "Invalid payout request." }, status, origin);
  }
});
