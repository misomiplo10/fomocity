# FOMO City launch settings

How the game is set up on mainnet: what the token's launch on Meteora must look like, the
game's settings, and the keeper. The game attaches to the token after it launches.

## How the money flows

- Every trade of the token pays a trading fee on Meteora (Meteora keeps 20% of it).
- The game's **fee address** receives the fee share it's entitled to, in SOL.
- The keeper claims those fees every few minutes and the program splits them:
  **80% to the jackpot, 20% to the team**.
- When a round's clock hits zero, the program pays the whole jackpot **in SOL** to the last
  buyer. The team's share is sent to the team wallet in SOL once it reaches 0.1 SOL.

## The game's fee address

```
35Pix3NhWMeiHr3W9BPiVJt2iSjpJKY6Qd4xE7LXd9JC
```

(For program `Fx4voUZZXbicWkMFSPC6ysW99E1h1zJdvzL51dxFY8ZR`, relaunch 2026-10-15. The first launch's
`Ch5rw4…vKjD` is dead: never use it.)

Print it any time with `cd scripts && npm run fee-address`. It's controlled by the game program
(no private key exists for it) and depends only on the program ID, so it's the same before and
after the token exists.

## What the launcher must set on Meteora (DBC)

| Setting | Must be | Why |
| - | - | - |
| Token type | **SPL Token** (not Token-2022) | The game rejects Token-2022 mints. |
| Quote token | **SOL** | The jackpot is paid in SOL. |
| Collect fee mode | **Quote token (SOL)** | Fees must arrive in SOL; the game refuses otherwise. |
| Trading fee | **Flat 3%** (start = end, no decay) | Agreed: no sniper tax. |
| Fees to the game | One of the two ways below | Otherwise the game refuses to attach. |

**Routing the fees to the game, either:**

1. **Fee claimer field** (if the launch tool has one, like Meteora's own): set it to the fee
   address above, and set the **creator trading fee to 0%** so the whole non-Meteora share goes
   to the game. If the creator share is above 0%, that part stays with the launcher.
2. **Creator transfer** (if the tool keeps the fee claimer for itself): right after launch, the
   launcher transfers the pool's creator rights to the fee address (one transaction). The game
   then gets the creator share of fees; the platform keeps its partner share.

Optional but recommended: lock the migrated liquidity, and give the creator's LP share to the
fee address before graduation (option 2 does this automatically), so fees keep funding the
jackpot after the token moves to the regular pool.

## Game settings (set when attaching)

| Setting | Default | Env |
| - | - | - |
| Minimum buy that counts | 0.05 SOL | `MIN_BUY_SOL` |
| Seconds added per buy | 30 | `SECS_PER_BUY` |
| Round timer | 30 min | `MAX_TIMER_SECS` (rounds start at 30:00 and never show more) |
| Settle grace | 60 s | `SETTLE_GRACE_SECS` |
| Keeper key | (required) | `KEEPER_PUBKEY`; changeable later with `set_keeper` |
| Team wallet | (required) | `TEAM_WALLET`; changeable later with `set_team` |

These are fixed in the program: 80% jackpot / 20% team; an admin-announced final round (it plays out
and pays its winner in full, then no more rounds and later fees go to the team); fees after zero go to the next round;
a round with no buys carries its jackpot over.

## Keeper settings

| Setting | Default | Env |
| - | - | - |
| RPC | Helius from `scripts/.env` | `HELIUS_API_KEY` or `RPC_URL` |
| Loop interval | 20 s | `INTERVAL_SECS` |
| Smallest fee claim | 0.01 SOL | `MIN_HARVEST_SOL` |
| Team payout threshold | 0.1 SOL | `TEAM_MIN_SOL` |
| Low-balance warning | 0.2 SOL | `LOW_BALANCE_SOL` |

## Commands

```bash
cd scripts && npm run fee-address                                             # the address for the launcher
cd scripts && KEEPER_PUBKEY=<keeper> TEAM_WALLET=<team> MINT=<CA> npm run attach    # plan only
cd scripts && KEEPER_PUBKEY=<keeper> TEAM_WALLET=<team> MINT=<CA> CONFIRM_MAINNET=yes npm run attach
cd scripts && KEEPER=~/.config/solana/fomocity-keeper.json MINT=<CA> npm run keeper
cd scripts && FUNDER=<wallet.json> MINT=<CA> FUND_SOL=1 npm run fund          # optional top-up, 100% to the jackpot
cd scripts && MINT=<CA> npm run final-round                                    # plan only: announce the last round
cd scripts && MINT=<CA> CONFIRM_MAINNET=yes npm run final-round                # only when the team decides to end
```

`npm run launch` does our own launch instead (flat 3%, fee address as fee claimer and creator, game
attached in the same run). Optional `FIRST_BUY_SOL=<n>`: the launching wallet buys that much in the
pool-creation transaction itself (the token's first trade; not a game buy, since the game starts after).
