# Handoff: relaunch under a new brand

Read this first, then README.md and LAUNCH.md.

## Where things stand (2026-10-15)

- First launch ("FOMO City", token `2PKY…ykzKT`) ran one round and was ended: 56 buys, the
  winner was paid 4.1378 SOL automatically, the program was closed and its deposit refunded.
- Program `61MMtvjn…TN6H` and its fee address `Ch5rw4…vKjD` are **dead forever**. Don't give
  them to anyone; a closed program address can never be reused.
- Relaunching as FOMO City: `web/src/status.js` is back to `phase: 'live'` and the old CA is
  removed from Vercel (`VITE_MINT`), so fomocity.net shows the simulation and "Launching soon"
  until the new token is attached.
- The old wallets on the Mac are being emptied. The relaunch uses **new wallets** made on the
  laptop.

## Relaunch checklist

1. **Setup on the laptop:** clone `misomiplo10/fomocity`, then `npm ci` in `web/` and `scripts/`.
   Install Node 24, Solana CLI 3.x and Rust. Build with
   `cargo build-sbf --tools-version v1.53`. Keep `opt-level = "s"` in Cargo.toml; `"z"`
   overflows the stack.
2. **Rebrand:** new name, logo and banner (`brand/`, `web/public/logo.png`, `banner.png`),
   titles and copy in `web/index.html`, `web/how.html`, `web/src/ui.js` and README (only if
   the look changes).
3. **New program ID:**
   `solana-keygen new -o target/deploy/fomocity-keypair.json --no-bip39-passphrase`. Put the
   address in `declare_id!` in `programs/fomocity/src/lib.rs`, rebuild, and regenerate
   `idls/fomocity.json` via `tools/idl` (run it with `RUSTUP_TOOLCHAIN` unset). Then
   `npm run fee-address` prints the **new** fee address for the launcher.
4. **Add a "final round" switch** (admin-only): the current round finishes and pays its
   winner, no new round opens, and the site shows "FINAL ROUND". Test it on localnet
   (`./localnet.sh`, then the tests in `scripts/`).
5. **New wallets:** deploy (about 2.5 SOL) and keeper (about 0.5 SOL). The team wallet can
   stay `6qETJVFgTnBgtjBZ34SALT92r7b5p9rdC1eBoTYzNN1f`. Put `KEEPER`, `KEEPER_PUBKEY`,
   `TEAM_WALLET` and `HELIUS_API_KEY` in `scripts/.env`.
6. **Deploy** (about 2.07 SOL deposit): `solana program deploy target/deploy/fomocity.so
   --program-id target/deploy/fomocity-keypair.json`.
7. **Launch:** the friend launches on Meteora DBC with SPL Token, SOL quote, fees in SOL,
   flat 3%, fee claimer = the new fee address, creator fee 0%. They send the CA **before
   promoting it**.
8. **Attach right away:** `MINT=<CA> npm run attach` (plan first, then with
   `CONFIRM_MAINNET=yes`). Then start the keeper with `MINT=<CA> npm run keeper`, ideally on a
   server rather than a laptop.
9. **Vercel:** set `VITE_MINT=<CA>` and redeploy. `VITE_CLUSTER=mainnet` and
   `VITE_RPC_URL=/api/rpc` stay; `HELIUS_RPC_URL` must be marked Sensitive.

## Lessons from launch 1

- Mainnet now has **version 1 transactions**, which web3.js 1.x can't decode. The tracker
  fetches raw JSON instead (`fetchTx` in `scripts/tracker.ts`), and that fix is committed.
  Before it, 5 early buys were missed.
- Setting `VITE_MINT` in Vercel **before** the attach makes the site go black, because the
  game doesn't exist yet. Attach first, then redeploy.
- The keeper needs a machine that's always on.

## Ground rules

- **Mainnet only, no devnet.** Show the plan and the cost, and get a clear yes, before every
  mainnet transaction.
- **Mark secrets:** wallet `.json` files, seed phrases, the Helius key and `scripts/.env` are
  secret. Addresses are public. Never paste keys in chat, GitHub or screenshots.
- **The jackpot only ever goes to the round's winner.** There is no admin withdrawal of
  jackpot funds; keep it that way. The team's income is its 20% of fees.
