# FOMO City

A last-buyer-wins (FOMO3D-style) game set in an endless procedural night city.
Three.js WebGPU frontend (auto-falls back to WebGL2), Solana Anchor program, and a
game token that trades on a Meteora pool.

```
web/                 Vite + three.js (WebGPU) client
  src/game.js        pure game engine, same math as the on-chain program
  src/sim.js         local backend: bots + 2-minute rounds (default today)
  src/city.js        endless procedural city (chunk streaming, TSL window shader)
  src/towers.js      player plaza: towers, jackpot obelisk, last-buyer beam
  src/ui.js          HUD, rules dialog, live feed, name tags
programs/fomocity/   Anchor 1.2 program: pot, timer, dividends, settlement
```

## Run

```bash
cd web && npm install && npm run dev
```

Add `?webgl` to the URL to force the WebGL2 fallback.

## Game rules (identical in `game.js` and `lib.rs`)

- Floor price: `base + step × floors_sold_this_round` (defaults 1.00 + 0.01).
- Each floor adds 30s to the timer, capped at 24h from now.
- Every buy is split: 50% jackpot · 35% dividends to *existing* holders · 10% next-round seed · 5% dev.
- When the timer hits 0, anyone can call `settle`. The last buyer then calls `claim_jackpot`.
- Dividends are claimable at any time with `claim_dividends`, including after the round ends.

## How Meteora fits

The program is token-agnostic: `initialize` binds it to one mint.

1. Launch the token on Meteora (DBC launchpad, or a DAMM v2 / DLMM pool against SOL/USDC).
2. `initialize` the game with that mint. Players buy the token on Meteora, then spend it on floors.
3. Optional: point the 5% dev cut at a wallet that market-buys and burns the token, or adds Meteora LP.
   That creates real buy pressure from game volume.

## Before mainnet (not done yet)

- [ ] Install Anchor CLI (`cargo install --git https://github.com/solana-foundation/anchor avm && avm install 1.2.1`), then `anchor keys sync` to replace the placeholder program ID.
- [ ] Integration tests on localnet (buy / claim / settle / claim_jackpot, multiple players).
- [ ] `web/src/solana.js` backend: wallet adapter, tx building, event subscription. Same interface as `sim.js`.
- [ ] Settlement crank: a tiny bot that calls `settle` when the timer expires (it's permissionless, so anyone can).
- [ ] **Revoke the upgrade authority** (or put it behind a multisig + timelock). The rules dialog says nobody can move the pot. That is only true once the program is immutable.
- [ ] Professional audit. Known FOMO3D risk: block-stuffing near timer end lets a whale stall others' buys.
- [ ] Legal review for your jurisdictions. This is a paid game of chance and may count as gambling or a security.
- [ ] Only plain SPL mints are accepted. Token-2022 mints with extensions are rejected in `initialize`.
