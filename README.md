# FOMO City

A last-buyer-wins (FOMO3D-style) game set in an endless procedural night city.
Three.js WebGPU frontend (auto-falls back to WebGL2), a Solana Anchor program, and a
game token launched on **Meteora's Dynamic Bonding Curve (DBC)**. Meteora trading fees are
claimed on-chain and used to buy back the token into the jackpot.

```
web/                    Vite + three.js (WebGPU) client
  src/game.js           pure game engine, same math as the on-chain program
  src/sim.js            local backend: bots trading on a simulated Meteora market
  src/solana.js         chain backend, same interface, read-only: program + Meteora pool
  how.html, src/how.js  the "How it works" guide page (/how)
  src/city.js           endless procedural city (chunk streaming, TSL window shader)
  src/towers.js         plaza: towers, jackpot obelisk, last-buyer beam, buyback column
  src/ui.js             HUD, Meteora panel, rules dialog, live feed, name tags
programs/fomocity/      Anchor 1.2 program: recorded buys, timer, auto-paid jackpot, Meteora fee flywheel
idls/                   Meteora DBC + DAMM v2 IDLs (bindings via declare_program!) + our IDL
scripts/                launch, keeper and localnet tests (TypeScript)
tools/idl/              builds idls/fomocity.json without the Anchor CLI
METEORA.md              research notes on every Meteora product, with doc links
LAUNCH.md               every mainnet launch setting: Meteora DBC config, game config, keeper
```

## Run the game (sim mode)

```bash
cd web && npm install && npm run dev
```

Add `?webgl` to the URL to force the WebGL2 fallback. `npm test` checks that the JS engine
matches the program's test vectors.

## Run the game on-chain

The same client talks to the real program when given a cluster and a game mint:

```
http://localhost:5173/?cluster=localnet&mint=<mint printed by npm run launch>
```

The site is **watch-only**: no buy button and no wallet connection. Players play by buying FOMO
anywhere (Jupiter, Meteora, any wallet or bot). The site shows the countdown, the last buyer,
live buys, the jackpot, the Meteora flywheel, recent winners and, bottom right, the token's
contract address ("Launching soon" until `VITE_MINT` is set). The rules pop up every time the
site opens, and `/how` has the full guide. For production builds set `VITE_CLUSTER`,
`VITE_RPC_URL` and `VITE_MINT`; on mainnet the URL can't override the RPC or mint, so a shared
link can't point players at a lookalike game.

## Game rules (identical in `game.js` and `lib.rs`)

- **Play = buy FOMO anywhere.** The keeper's tracker sees every buy on the game's Meteora pools
  (from any app) and reports each one of at least `MIN_BUY_SOL` (default 0.05 SOL) on-chain with
  `record_buy`: wallet, SOL, block time and the swap's transaction signature. Sells never count.
- Each counted buy adds `SECS_PER_BUY` (30s) to the countdown, capped at `MAX_TIMER_SECS` (30 min)
  after the buy. Rounds open at 30 minutes.
- When the countdown hits 0 (plus a `SETTLE_GRACE_SECS` window for late-reported buys), anyone can
  call `settle`, which **pays the whole jackpot to the last buyer in the same instruction** and
  records them in the on-chain winners list (last 10). A round with no buys carries over.
- The program keeps the last 16 counted buys and last 10 winners on the Game account for the site.
- Guards: keeper-only reporting, minimum size, chain order, no duplicates, nothing before the
  round or after the deadline, and payouts only to the last buyer's own token account.

## The Meteora flywheel

```
traders ──swap──▶ DBC bonding curve ──(curve fills)──▶ DAMM v2 pool (LP locked forever)
                        │ 80% of fees, in SOL                 │ LP fees
                        ▼                                     ▼
                  treasury PDA  ◀───────── harvest_dbc / harvest_dbc_surplus / harvest_damm
                        │ keeper: buyback_dbc / buyback_damm (SOL → token)
                        ▼
          70% current jackpot · 20% next-round seed · 10% burned
```

- The game's **treasury PDA** is both the DBC config's `fee_claimer` and the pool's `creator`,
  so it receives 80% of every trading fee (Meteora keeps 20%). `initialize` refuses to bind a
  pool where that isn't true.
- Fees are collected in SOL (`CollectFeeMode::QuoteToken`). The launch fee starts at 50% and
  decays to 1% over 2 minutes, so snipers pay into the pot.
- On migration all liquidity is **permanently locked** in DAMM v2, and both position NFTs land
  in the treasury. Their LP fees keep funding buybacks forever.
- Harvests are permissionless. Buybacks are keeper-only because the keeper supplies `min_out`
  from an off-chain quote. On-chain limits bound the damage a bad or compromised keeper can
  do: a per-call SOL cap, a cooldown, a pinned pool and pinned accounts.
- A buyback after the timer hits zero goes to the next round, so it can't top up a jackpot
  whose winner is already decided.

## Launch, keep, test

```bash
cd scripts && npm install
```

| Command | What it does |
| - | - |
| `./localnet.sh` | Local validator with Meteora DBC, DAMM v2, Metaplex and Token-2022 cloned from mainnet, plus our program. |
| `npm run test:localnet` | End-to-end against the real Meteora programs: launch → sniper/normal trades → harvest → buyback (70/20/10 checked to the unit) → keeper/size/cooldown guards → a Meteora buy tracked and recorded as last buyer → curve completes → migrate → surplus + LP fee harvest → DAMM v2 buyback. |
| `npm run test:rounds` | Game rules on-chain with real Meteora buys: every `record_buy` guard, the countdown math, the jackpot paid automatically to the last buyer at settle (and refused to anyone else), the winners list, a buyback after expiry going to the next round, settle, jackpot paid only to the last buyer and only once, a round with no buyers carrying over, the vault holding exactly what's owed, handing off and renouncing admin. |
| `npm run tracker` | Watches the game's Meteora pools (bonding curve, then DAMM v2) and logs every FOMO buy and sell, from any app or aggregator, with the wallet and the exact SOL in or out of the pool, to `trades.jsonl`. Backfills history on start, then follows live. The game's own buybacks are flagged. Env: `MINT`, optional `TRACKER_LOG`. |
| `npm run test:tracker` | Tracker against real Meteora swaps on localnet: two wallets buying and selling plus a game buyback, from history and live. |
| `npm run attach` | Attach the game to a token someone else launched on Meteora DBC, by CA (see LAUNCH.md "Attach mode"). The jackpot is then funded with `npm run fund`. |
| `npm run fund` | Top up the jackpot with SOL (bought back 70/20/10) or FOMO (straight in). Anyone can. |
| `npm run test:external` | Attach mode on localnet: a token launched with someone else's fee wallet, normal setup refused, attach by CA, buys recorded, FOMO and SOL top-ups, winner paid. |
| `npm run launch` | Creates the DBC config and pool, hands pool creator to the treasury, initializes the game. Env: `RPC_URL`, `AUTHORITY`, `KEEPER_PUBKEY`, optional `MIN_BUY_SOL`, `SECS_PER_BUY`, `MAX_TIMER_SECS`, `SETTLE_GRACE_SECS`, `MIGRATION_SOL`, `MAX_BUYBACK_SOL`, `BUYBACK_GAP_SECS`, `TOKEN_*`. |
| `npm run keeper` | Runs the game: tracks Meteora buys and reports qualifying ones with `record_buy`, settles rounds (paying the winner), harvests, migrate if Meteora's keepers haven't, buy back (skips while the swap fee is above `MAX_FEE_BPS`). Env: `RPC_URL`, `KEEPER`, `MINT`, optional `JITO_URL` + `JITO_TIP_LAMPORTS` to send buybacks privately through Jito (not yet tested against a live block engine). |

### Mainnet launch

**Helius setup.** Copy `scripts/.env.example` to `scripts/.env` (gitignored) and set
`HELIUS_API_KEY`; launch, attach, keeper and tracker use it, and logs mask the key. The website
never sees a Helius key: it calls its own relay, `api/rpc.js` (a Vercel function), which forwards
only read-only RPC methods to Helius. In Vercel set `HELIUS_RPC_URL` (secret, a separate
`fomocity-website` key) and `VITE_RPC_URL=/api/rpc`. Through the relay the site polls instead of
using websockets.

All settings, defaults and what's fixed by design are in [LAUNCH.md](LAUNCH.md).

There's no devnet stage. `npm run test:localnet` and `npm run test:rounds` already run against
Meteora's real mainnet program bytecode. Budget about 5 SOL: program deploy ≈ 4.3 SOL rent
(refundable if the program is ever closed), plus launch and keeper fees. Use a paid RPC.

```bash
cd programs/fomocity && cargo build-sbf --tools-version v1.53 && cd ../..
solana program deploy -u <rpc> target/deploy/fomocity.so --program-id target/deploy/fomocity-keypair.json
cd scripts
RPC_URL=<rpc> AUTHORITY=<wallet.json> KEEPER_PUBKEY=<keeper> npm run launch                     # prints the plan, sends nothing
RPC_URL=<rpc> AUTHORITY=<wallet.json> KEEPER_PUBKEY=<keeper> CONFIRM_MAINNET=yes npm run launch  # launches
RPC_URL=<rpc> KEEPER=<keeper.json> MINT=<mint> JITO_URL=https://mainnet.block-engine.jito.wtf npm run keeper
```

Build the site with `VITE_CLUSTER=mainnet VITE_RPC_URL=<rpc> VITE_MINT=<mint> npm run build`.
Keep `target/deploy/fomocity-keypair.json` (the program ID) safe and out of git.

### Admin

`set_keeper` and `set_buyback_limits` are admin-only. `set_authority` hands admin to another key,
such as a multisig. `set_authority` with the default pubkey (`11111111111111111111111111111111`)
renounces it for good, which freezes the keeper and limits.

Build the program and IDL (no Anchor CLI needed):

```bash
cd programs/fomocity && cargo build-sbf --tools-version v1.53
cd ../.. && cargo build --manifest-path tools/idl/Cargo.toml && env -u RUSTUP_TOOLCHAIN tools/idl/target/debug/fomocity-idl
```

Platform tools v1.53 are needed because Anchor 1.2's dependencies use Rust edition 2024.
The default tools in Solana CLI 3.0 ship Cargo 1.84, which can't build them.

## Before mainnet (not done yet)

- [x] Watch-only site with live buys and winners (tested on localnet with real Meteora buys and the keeper).
- [ ] The keeper is a trust point: it decides which buys get reported. Publish `recorded.jsonl` / the BuyRecorded events and keep the tracker open-source so anyone can re-check rounds.
- [ ] Host the keeper with alerting (it's a long-running Node process).
- [ ] Decide the migration threshold. Meteora's keepers auto-migrate SOL pools at exactly 10 SOL (the "equals vs at least" rule is unverified). Otherwise our keeper migrates; it's permissionless.
- [ ] Turn on Jito sending for buybacks (`JITO_URL`) and verify it on mainnet with a tiny buyback.
- [ ] **Revoke the upgrade authority** (or put it behind a multisig + timelock). The rules dialog says nobody can move the pot. That is only true once the program is immutable. The `authority` can still change the keeper and buyback limits until you `set_authority` to a multisig or renounce it.
- [ ] Professional audit. Known risks: FOMO3D block-stuffing near timer end, buyback sandwiching within `min_out`.
- [ ] Disclose the Meteora trust points: Meteora operators can pause the migrated DAMM v2 pool or change its fees. That stops buybacks (SOL waits in the vault), but they cannot touch the pot or the locked LP. See METEORA.md §10.
- [ ] Legal review for your jurisdictions. This is a paid game of chance and may count as gambling or a security.
- [ ] Only plain SPL mints are accepted (launch with `TokenType.SPLToken`). Token-2022 mints are rejected in `initialize`.
