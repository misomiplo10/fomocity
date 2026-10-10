# FOMO City

A last-buyer-wins (FOMO3D-style) game set in an endless procedural night city.
Three.js WebGPU frontend (auto-falls back to WebGL2), a Solana Anchor program, and a
game token launched on **Meteora's Dynamic Bonding Curve (DBC)**. Meteora trading fees are
claimed on-chain and used to buy back the token into the jackpot.

```
web/                    Vite + three.js (WebGPU) client
  src/game.js           pure game engine, same math as the on-chain program
  src/sim.js            local backend: floor-buying bots + a simulated Meteora market
  src/city.js           endless procedural city (chunk streaming, TSL window shader)
  src/towers.js         plaza: towers, jackpot obelisk, last-buyer beam, buyback column
  src/ui.js             HUD, Meteora panel, rules dialog, live feed, name tags
programs/fomocity/      Anchor 1.2 program: pot, timer, dividends, Meteora fee flywheel
idls/                   Meteora DBC + DAMM v2 IDLs (bindings via declare_program!)
scripts/                launch, keeper and a localnet end-to-end test (TypeScript)
tools/idl/              builds target/idl/fomocity.json without the Anchor CLI
METEORA.md              research notes on every Meteora product, with doc links
```

## Run the game (sim mode)

```bash
cd web && npm install && npm run dev
```

Add `?webgl` to the URL to force the WebGL2 fallback. `npm test` checks that the JS engine
matches the program's test vectors.

## Game rules (identical in `game.js` and `lib.rs`)

- Floor price: `base + step × floors_sold_this_round` (defaults 1.00 + 0.01).
- Each floor adds 30s to the timer, capped at 24h from now.
- Every floor buy is split: 50% jackpot · 35% dividends to *existing* holders · 10% next-round seed · 5% dev.
- When the timer hits 0, anyone can call `settle`. The last buyer then calls `claim_jackpot`.
- Dividends are claimable at any time with `claim_dividends`, including after the round ends.

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
| `npm run test:localnet` | End-to-end against the real Meteora programs: launch → sniper/normal trades → harvest → buyback (70/20/10 checked to the unit) → keeper/size/cooldown guards → floor buys → curve completes → migrate → surplus + LP fee harvest → DAMM v2 buyback. |
| `npm run launch` | Creates the DBC config and pool, hands pool creator to the treasury, initializes the game. Env: `RPC_URL`, `AUTHORITY`, `KEEPER_PUBKEY`, optional `MIGRATION_SOL`, `MAX_BUYBACK_SOL`, `BUYBACK_GAP_SECS`, `DEV_WALLET`, `TOKEN_*`. |
| `npm run keeper` | Loop: settle expired rounds, harvest, migrate if Meteora's keepers haven't, buy back (skips while the swap fee is above `MAX_FEE_BPS`). Env: `RPC_URL`, `KEEPER`, `MINT`. |

Build the program and IDL (no Anchor CLI needed):

```bash
cd programs/fomocity && cargo build-sbf --tools-version v1.53
cd ../.. && cargo build --manifest-path tools/idl/Cargo.toml && env -u RUSTUP_TOOLCHAIN tools/idl/target/debug/fomocity-idl
```

Platform tools v1.53 are needed because Anchor 1.2's dependencies use Rust edition 2024.
The default tools in Solana CLI 3.0 ship Cargo 1.84, which can't build them.

## Before mainnet (not done yet)

- [ ] `web/src/solana.js` backend: wallet adapter, tx building, event subscription. Same interface as `sim.js` (including `market`).
- [ ] Devnet dry run of `launch.ts` + `keeper.ts`, with the real 85 SOL threshold.
- [ ] Decide the migration threshold. Meteora's keepers auto-migrate SOL pools at exactly 10 SOL (the "equals vs at least" rule is unverified). Otherwise our keeper migrates; it's permissionless.
- [ ] Send keeper buybacks through Jito bundles or a private RPC to limit sandwiching.
- [ ] **Revoke the upgrade authority** (or put it behind a multisig + timelock). The rules dialog says nobody can move the pot. That is only true once the program is immutable. The `authority` can still change the keeper and buyback limits; consider removing or timelocking those too.
- [ ] Professional audit. Known risks: FOMO3D block-stuffing near timer end, buyback sandwiching within `min_out`.
- [ ] Disclose the Meteora trust points: Meteora operators can pause the migrated DAMM v2 pool or change its fees. That stops buybacks (SOL waits in the vault), but they cannot touch the pot or the locked LP. See METEORA.md §10.
- [ ] Legal review for your jurisdictions. This is a paid game of chance and may count as gambling or a security.
- [ ] Only plain SPL mints are accepted (launch with `TokenType.SPLToken`). Token-2022 mints are rejected in `initialize`.
