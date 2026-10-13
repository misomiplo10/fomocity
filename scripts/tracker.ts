// Buy tracker: records every FOMO buy and sell on the game's Meteora pools (bonding curve
// and, after graduation, DAMM v2), from any app or aggregator, with the wallet and SOL
// amount. Appends one JSON line per trade to TRACKER_LOG (default trades.jsonl).
//
//   MINT=<mint> npm run tracker      (RPC from scripts/.env: Helius recommended)
//
// It backfills from the pools' history on start, then follows them live over the RPC
// websocket. Already-recorded signatures are skipped, so restarts are safe.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { deriveDammV2PoolAuthority, deriveDbcPoolAuthority } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { NATIVE_MINT } from '@solana/spl-token';
import { Connection, Keypair, PublicKey, type VersionedTransactionResponse } from '@solana/web3.js';
import { fomocity, gameAddresses, readGame, redactUrl, rpcUrl } from './lib.ts';

export type Trade = {
  sig: string;
  slot: number;
  time: number | null;     // unix seconds (block time)
  venue: 'dbc' | 'damm';
  side: 'buy' | 'sell';
  wallet: string;          // owner of the token account that received / sent FOMO
  tokens: string;          // FOMO base units moved (6 decimals), as a string (u64)
  lamports: string;        // SOL into the pool for a buy, out of the pool for a sell
  game: boolean;           // true for the game's own buybacks (never a player)
};

/**
 * Extracts FOMO trades on one of our pools from a confirmed transaction, using token
 * balance changes, so it works for swaps sent directly or routed through Jupiter etc.
 * `quoteVault` is the pool's WSOL vault; its change is the exact SOL in/out of that pool.
 */
export function parseTrades(
  tx: VersionedTransactionResponse,
  opts: { mint: PublicKey; quoteVault: PublicKey; venue: Trade['venue']; gameOwners: Set<string> },
): Trade[] {
  const meta = tx.meta;
  if (!meta || meta.err) return [];
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: meta.loadedAddresses ?? undefined });
  const mint = opts.mint.toBase58();
  const poolAuthorities = new Set([deriveDbcPoolAuthority().toBase58(), deriveDammV2PoolAuthority().toBase58()]);

  // Quote vault delta = SOL into (+) or out of (−) this pool in this transaction.
  let vaultDelta = 0n;
  const wsol = NATIVE_MINT.toBase58();
  const amountAt = (list: typeof meta.preTokenBalances, idx: number, m: string) =>
    BigInt(list?.find((b) => b.accountIndex === idx && b.mint === m)?.uiTokenAmount.amount ?? '0');
  const vaultIdx = keys.staticAccountKeys.concat(keys.accountKeysFromLookups?.writable ?? [], keys.accountKeysFromLookups?.readonly ?? [])
    .findIndex((k) => k.equals(opts.quoteVault));
  if (vaultIdx < 0) return [];
  vaultDelta = amountAt(meta.postTokenBalances, vaultIdx, wsol) - amountAt(meta.preTokenBalances, vaultIdx, wsol);
  if (vaultDelta === 0n) return [];

  // FOMO balance change per owner, excluding the pools themselves.
  const deltas = new Map<string, bigint>();
  const add = (owner: string | undefined, v: bigint) => {
    if (!owner || poolAuthorities.has(owner)) return;
    deltas.set(owner, (deltas.get(owner) ?? 0n) + v);
  };
  for (const b of meta.postTokenBalances ?? []) if (b.mint === mint) add(b.owner, BigInt(b.uiTokenAmount.amount));
  for (const b of meta.preTokenBalances ?? []) if (b.mint === mint) add(b.owner, -BigInt(b.uiTokenAmount.amount));

  const side: Trade['side'] = vaultDelta > 0n ? 'buy' : 'sell';
  // The trader is the owner whose FOMO moved the most in the trade's direction.
  let best: [string, bigint] | null = null;
  for (const [owner, d] of deltas) {
    const moved = side === 'buy' ? d : -d;
    if (moved > 0n && (!best || moved > best[1])) best = [owner, moved];
  }
  if (!best) return [];
  return [{
    sig: tx.transaction.signatures[0],
    slot: tx.slot,
    time: tx.blockTime ?? null,
    venue: opts.venue,
    side,
    wallet: best[0],
    tokens: best[1].toString(),
    lamports: (vaultDelta < 0n ? -vaultDelta : vaultDelta).toString(),
    game: opts.gameOwners.has(best[0]),
  }];
}

/** Watches the game's pools and calls `onTrade` for each new trade, oldest first. */
export async function track(connection: Connection, mint: PublicKey, onTrade: (t: Trade) => void, opts: { seen?: Set<string>; live?: boolean } = {}) {
  const program = fomocity(connection, Keypair.generate());
  const g = await readGame(program, mint);
  const { DynamicBondingCurveClient } = await import('@meteora-ag/dynamic-bonding-curve-sdk');
  const { CpAmm } = await import('@meteora-ag/cp-amm-sdk');
  const dbcPool = (await new DynamicBondingCurveClient(connection, 'confirmed').state.getPool(g.data.dbcPool))!.poolState;
  const gameOwners = new Set([gameAddresses(mint).treasury.toBase58(), gameAddresses(mint).game.toBase58()]);
  const seen = opts.seen ?? new Set<string>();

  type Venue = { pool: PublicKey; quoteVault: PublicKey; venue: Trade['venue'] };
  const venues: Venue[] = [{ pool: g.data.dbcPool, quoteVault: dbcPool.quoteVault, venue: 'dbc' }];
  const addDamm = async () => {
    if (venues.some((v) => v.venue === 'damm')) return;
    const info = await connection.getAccountInfo(g.data.dammPool);
    if (!info) return; // not migrated yet
    const ps = await new CpAmm(connection).fetchPoolState(g.data.dammPool);
    const v: Venue = { pool: g.data.dammPool, quoteVault: ps.tokenBVault, venue: 'damm' };
    venues.push(v);
    await backfill(v);
    if (opts.live) subscribe(v);
  };

  // Transactions are processed one at a time so trades are emitted in order.
  let chain = Promise.resolve();
  const handle = (sig: string, v: Venue) => {
    chain = chain.then(async () => {
      if (seen.has(sig)) return;
      const tx = await connection.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      if (!tx) return;
      seen.add(sig);
      for (const t of parseTrades(tx, { mint, quoteVault: v.quoteVault, venue: v.venue, gameOwners })) onTrade(t);
    }).catch((e) => console.error('tracker:', sig, e?.message ?? e));
    return chain;
  };

  async function backfill(v: Venue) {
    const sigs: string[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await connection.getSignaturesForAddress(v.pool, { before, limit: 1000 }, 'confirmed');
      const fresh = page.filter((s) => !s.err && !seen.has(s.signature));
      sigs.push(...fresh.map((s) => s.signature));
      if (page.length < 1000 || fresh.length < page.length) break;
      before = page[page.length - 1].signature;
    }
    for (const sig of sigs.reverse()) await handle(sig, v);
  }

  function subscribe(v: Venue) {
    connection.onLogs(v.pool, ({ signature, err }) => { if (!err) handle(signature, v); }, 'confirmed');
  }

  await backfill(venues[0]);
  if (opts.live) subscribe(venues[0]);
  await addDamm();
  // Pick up the DAMM v2 pool once the curve graduates.
  if (opts.live) setInterval(() => addDamm().catch(() => {}), 30_000);
  await chain;
}

// ---------- CLI ----------

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = rpcUrl();
  const mint = new PublicKey(process.env.MINT ?? (() => { throw new Error('set MINT'); })());
  const out = process.env.TRACKER_LOG ?? 'trades.jsonl';
  const seen = new Set<string>();
  if (existsSync(out)) for (const line of readFileSync(out, 'utf8').split('\n')) if (line) seen.add(JSON.parse(line).sig);
  console.log(`tracker: ${redactUrl(url)} mint ${mint.toBase58()} → ${out} (${seen.size} already recorded)`);
  await track(new Connection(url, 'confirmed'), mint, (t) => {
    appendFileSync(out, JSON.stringify(t) + '\n');
    const sol = (Number(t.lamports) / 1e9).toFixed(4);
    console.log(`${t.side.toUpperCase()} ${t.wallet} ${sol} SOL ${t.venue}${t.game ? ' (game buyback)' : ''} ${t.sig}`);
  }, { seen, live: true });
}
