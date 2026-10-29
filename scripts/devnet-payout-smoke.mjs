import assert from "node:assert/strict";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createMint,
  createTransferCheckedInstruction,
  getAssociatedTokenAddress,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  unpackAccount,
} from "@solana/spl-token";

const RPC_URL = process.env.SOLANA_DEVNET_RPC_URL || "https://api.devnet.solana.com";
const RECIPIENT_COUNT = 125;
// Keep each new system account rent-exempt on local validator and Devnet.
const SOL_PER_RECIPIENT = 1_000_000;
const TOKEN_DECIMALS = 6;
const TOKEN_BASE_UNITS_PER_RECIPIENT = 1_000n;
const connection = new Connection(RPC_URL, {
  commitment: "confirmed",
  confirmTransactionInitialTimeout: 60_000,
});
const payer = Keypair.generate();
const recipients = Array.from({ length: RECIPIENT_COUNT }, () => Keypair.generate());
const signatures = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fundDevnetPayer() {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const signature = await connection.requestAirdrop(payer.publicKey, 2 * LAMPORTS_PER_SOL);
      const confirmation = await connection.confirmTransaction(signature, "confirmed");
      if (confirmation.value.err) throw new Error("The Devnet airdrop transaction failed.");
      const balance = await connection.getBalance(payer.publicKey, "confirmed");
      if (balance < LAMPORTS_PER_SOL) throw new Error("The Devnet faucet balance was lower than expected.");
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 5) await sleep(attempt * 2500);
    }
  }
  throw new Error(`Could not fund the temporary Devnet payer after five attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function sendTransaction(transaction) {
  const latest = await connection.getLatestBlockhash("confirmed");
  transaction.feePayer = payer.publicKey;
  transaction.recentBlockhash = latest.blockhash;
  transaction.sign(payer);
  const raw = transaction.serialize();
  assert.ok(raw.length <= 1232, `Transaction exceeded Solana packet limit: ${raw.length} bytes`);
  const signature = await connection.sendRawTransaction(raw, {
    skipPreflight: false,
    preflightCommitment: "confirmed",
    maxRetries: 5,
  });
  const confirmation = await connection.confirmTransaction({
    signature,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  }, "confirmed");
  assert.equal(confirmation.value.err, null, `Transaction failed: ${signature}`);
  signatures.push(signature);
  return signature;
}

async function batches(values, size, callback) {
  for (let start = 0; start < values.length; start += size) {
    await callback(values.slice(start, start + size), Math.floor(start / size));
  }
}

async function verifyAllSignatures() {
  for (let start = 0; start < signatures.length; start += 20) {
    const part = signatures.slice(start, start + 20);
    const result = await connection.getSignatureStatuses(part, { searchTransactionHistory: true });
    for (let index = 0; index < part.length; index++) {
      const status = result.value[index];
      assert.ok(status, `Signature status missing: ${part[index]}`);
      assert.equal(status.err, null, `Signature has an on-chain error: ${part[index]}`);
      assert.ok(
        status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized",
        `Signature is not confirmed: ${part[index]}`,
      );
    }
  }
}

async function verifySolRecipients() {
  const keys = recipients.map((recipient) => recipient.publicKey);
  for (let start = 0; start < keys.length; start += 80) {
    const part = keys.slice(start, start + 80);
    const infos = await connection.getMultipleAccountsInfo(part, "confirmed");
    for (let index = 0; index < part.length; index++) {
      assert.ok(infos[index], `SOL recipient account does not exist: ${part[index].toBase58()}`);
      assert.ok(
        BigInt(infos[index].lamports) >= BigInt(SOL_PER_RECIPIENT),
        `SOL recipient balance is too low: ${part[index].toBase58()}`,
      );
    }
  }
}

async function verifyTokenRecipients(mint) {
  const addresses = recipients.map((recipient) =>
    getAssociatedTokenAddressSync(mint, recipient.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)
  );
  for (let start = 0; start < addresses.length; start += 80) {
    const part = addresses.slice(start, start + 80);
    const infos = await connection.getMultipleAccountsInfo(part, "confirmed");
    for (let index = 0; index < part.length; index++) {
      assert.ok(infos[index], `SPL recipient ATA does not exist: ${part[index].toBase58()}`);
      const tokenAccount = unpackAccount(part[index], infos[index], TOKEN_PROGRAM_ID);
      assert.equal(tokenAccount.mint.toBase58(), mint.toBase58());
      assert.equal(tokenAccount.owner.toBase58(), recipients[start + index].publicKey.toBase58());
      assert.equal(tokenAccount.amount, TOKEN_BASE_UNITS_PER_RECIPIENT);
    }
  }
}

async function main() {
  const isLocal = RPC_URL.includes("localhost") || RPC_URL.includes("127.0.0.1");
  console.log(`${isLocal ? "Local validator" : "Solana Devnet"} payout smoke test: ${RECIPIENT_COUNT} ephemeral recipient wallets`);
  console.log(`RPC: ${RPC_URL}`);
  console.log("No production wallet, production signer, or user funds are used.");
  await fundDevnetPayer();

  await batches(recipients, 10, async (group, batchIndex) => {
    const transaction = new Transaction();
    for (const recipient of group) {
      transaction.add(SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: recipient.publicKey,
        lamports: SOL_PER_RECIPIENT,
      }));
    }
    await sendTransaction(transaction);
    console.log(`SOL batch ${batchIndex + 1}: ${group.length} recipients confirmed`);
  });
  await verifySolRecipients();
  console.log(`PASS: all ${RECIPIENT_COUNT} SOL recipient balances verified`);

  const mint = await createMint(
    connection,
    payer,
    payer.publicKey,
    null,
    TOKEN_DECIMALS,
    undefined,
    { commitment: "confirmed" },
    TOKEN_PROGRAM_ID,
  );
  const sourceAccount = await getOrCreateAssociatedTokenAccount(
    connection, payer, mint, payer.publicKey, false, "confirmed", undefined, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  await mintTo(
    connection,
    payer,
    mint,
    sourceAccount.address,
    payer.publicKey,
    BigInt(RECIPIENT_COUNT) * TOKEN_BASE_UNITS_PER_RECIPIENT,
    [],
    { commitment: "confirmed" },
    TOKEN_PROGRAM_ID,
  );

  await batches(recipients, 4, async (group, batchIndex) => {
    const transaction = new Transaction();
    for (const recipient of group) {
      const ata = await getAssociatedTokenAddress(
        mint, recipient.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      );
      transaction.add(createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey, ata, recipient.publicKey, mint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      ));
      transaction.add(createTransferCheckedInstruction(
        sourceAccount.address, mint, ata, payer.publicKey, TOKEN_BASE_UNITS_PER_RECIPIENT,
        TOKEN_DECIMALS, [], TOKEN_PROGRAM_ID,
      ));
    }
    await sendTransaction(transaction);
    console.log(`SPL token batch ${batchIndex + 1}: ${group.length} recipients confirmed`);
  });
  await verifyTokenRecipients(mint);
  await verifyAllSignatures();

  console.log(`PASS: all ${RECIPIENT_COUNT} SPL token recipient balances verified`);
  console.log(`PASS: ${signatures.length} transactions confirmed on ${isLocal ? "the local validator" : "Devnet"}`);
  console.log(`Temporary test token mint: ${mint.toBase58()}`);
  console.log(`Finished. All ephemeral keypairs and test funds are separate from Mainnet.${isLocal ? " This is a local-validator integration test, not a public Devnet test." : ""}`);
}

main().catch((error) => {
  console.error("SOLANA PAYOUT SMOKE TEST FAILED");
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
