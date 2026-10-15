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
  src/towers.js         plaza: towers, jackpot obelisk, last-buyer beam
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
- Each counted buy adds `SECS_PER_BUY` (30s) to the countdown, capped at `MAX_TIMER_SECS` (15 min)
  after the buy. Rounds open at 15 minutes.
- When the countdown hits 0 (plus a `SETTLE_GRACE_SECS` window for late-reported buys), anyone can
  call `settle`, which **pays the whole jackpot to the last buyer in the same instruction** and
  records them in the on-chain winners list (last 10). A round with no buys carries over.
- The program keeps the last 16 counted buys and last 10 winners on the Game account for the site.
- Guards: keeper-only reporting, minimum size, chain order, no duplicates, nothing before the
  round or after the deadline, and payouts only to the last buyer's own token account.

## Where the jackpot comes from

```
traders ──swap (3% fee)──▶ Meteora DBC curve ──(curve fills)──▶ DAMM v2 pool
                                │ fee share, in SOL                  │ LP fees (if the fee address owns positions)
                                ▼                                    ▼
                game fee address (program PDA)  ◀── harvest_dbc / harvest_dbc_surplus / harvest_damm (anyone)
                                │
                     80% jackpot (SOL) · 20% team (SOL)
```

- The game's **fee address** is a program PDA with seeds `["treasury"]`, so it's known before the
  token exists (`npm run fee-address`). The launcher sets it as the pool's fee claimer and/or hands
  it the pool's creator rights; `initialize` refuses a pool whose fees don't reach it, or that
  doesn't collect fees in SOL. See LAUNCH.md.
- Claims are permissionless; every lamport claimed is split 80% to the jackpot, 20% to the team.
  Fees claimed after the clock hits zero go to the next round, so they can't change a decided round.
- The jackpot is held as wrapped SOL and paid out as plain SOL: `settle` moves it into a temporary
  account and closes it to the winner in the same instruction. `withdraw_team` does the same for the
  team's share. `fund_sol` lets anyone add SOL straight to the jackpot.

## Launch, keep, test

```bash
cd scripts && npm install
```

| Command | What it does |
| - | - |
| `./localnet.sh` | Local validator with Meteora DBC, DAMM v2, Metaplex and Token-2022 cloned from mainnet, plus our program. |
| `npm run test:localnet` | End-to-end against the real Meteora programs: launch (flat 3%) → trades → fees claimed 80/20 → a buy recorded → curve completes → migrate → surplus + LP fees → winner paid in SOL → team paid in SOL. |
| `npm run test:rounds` | Game rules on-chain with real Meteora buys: every `record_buy` guard, the countdown math, fees split 80/20, the jackpot paid in SOL to the last buyer at settle (and refused to anyone else), the winners list, carry-over, the vault holding exactly what's owed, the team payout, handing off and renouncing admin. |
| `npm run tracker` | Watches the game's Meteora pools (bonding curve, then DAMM v2) and logs every FOMO buy and sell, from any app or aggregator, with the wallet and the exact SOL in or out of the pool, to `trades.jsonl`. Backfills history on start, then follows live. The game's own buybacks are flagged. Env: `MINT`, optional `TRACKER_LOG`. |
| `npm run test:tracker` | Tracker against real Meteora swaps on localnet: two wallets buying and selling, from history and live. |
| `npm run attach` | Attach the game to a token someone else launched on Meteora DBC, by CA, once its fees are routed to the fee address (see LAUNCH.md). Env: `KEEPER_PUBKEY`, `TEAM_WALLET`, `MINT`. |
| `npm run fund` | Add SOL straight to the jackpot (100%, no team share). Anyone can. |
| `npm run fee-address` | Prints the game's fee address for the launcher. No RPC needed. |
| `npm run test:external` | A token launched by someone else: fees routed by fee claimer (A) or creator transfer (B), launches the game must refuse, 80/20 split and SOL payout for both. |
| `npm run launch` | Our own launch: DBC config (flat 3%, fee address as fee claimer) and pool, creator rights handed to the fee address, game initialized. Env: `AUTHORITY`, `KEEPER_PUBKEY`, `TEAM_WALLET`, optional `MIN_BUY_SOL`, `SECS_PER_BUY`, `MAX_TIMER_SECS`, `SETTLE_GRACE_SECS`, `MIGRATION_SOL`, `TOKEN_*`. |
| `npm run keeper` | Runs the game: reports qualifying Meteora buys with `record_buy`, claims fees (80/20), settles rounds and pays the winner in SOL, pays the team, migrates if Meteora's bots don't, warns when its wallet is low. Env: `KEEPER`, `MINT`. |

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
KEEPER=<keeper.json> MINT=<mint> npm run keeper
```

Build the site with `VITE_CLUSTER=mainnet VITE_RPC_URL=<rpc> VITE_MINT=<mint> npm run build`.
Keep `target/deploy/fomocity-keypair.json` (the program ID) safe and out of git.

### Admin

`set_keeper` and `set_team` are admin-only. `set_authority` hands admin to another key,
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
- [ ] **Revoke the upgrade authority** (or put it behind a multisig + timelock). The rules dialog says nobody can move the pot. That is only true once the program is immutable. The `authority` can still change the keeper and buyback limits until you `set_authority` to a multisig or renounce it.
- [ ] Professional audit. Known risks: FOMO3D block-stuffing near timer end, the keeper being the only reporter of buys.
- [ ] Disclose the Meteora trust points: Meteora operators can pause the migrated DAMM v2 pool or change its fees. That stops trading and fee income (SOL waits in the vault), but they cannot touch the pot or the locked LP. See METEORA.md §10.
- [ ] Legal review for your jurisdictions. This is a paid game of chance and may count as gambling or a security.
- [ ] Only plain SPL mints are accepted (launch with `TokenType.SPLToken`). Token-2022 mints are rejected in `initialize`.
