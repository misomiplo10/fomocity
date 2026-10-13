# FOMO City launch settings

Every setting the mainnet launch uses: what Meteora's Dynamic Bonding Curve (DBC) is
configured with, what the game is configured with, and which ones are yours to change.
Defaults live in `scripts/lib.ts` (`DEFAULT_LAUNCH`, `launchCurve`) and `scripts/launch.ts`.
Run `npm run launch` without `CONFIRM_MAINNET=yes` to print the exact plan before sending.

## Meteora DBC config: your choices

| Setting | Default | Env / where | Notes |
| - | - | - | - |
| Token name | FOMO City | `TOKEN_NAME` | |
| Symbol | FOMO | `TOKEN_SYMBOL` | |
| Metadata URI | **placeholder** | `TOKEN_URI` | Must be a real JSON (name, symbol, image, description) before launch. |
| Total supply | 1,000,000,000 | `DEFAULT_LAUNCH.totalSupply` | 6 decimals. |
| Migration threshold | 85 SOL | `MIGRATION_SOL` | SOL raised on the curve before it graduates. 10 SOL is the only value Meteora's own bots are documented to auto-migrate; any other value, our keeper migrates (permissionless). |
| Supply into the locked pool at migration | 20% | `DEFAULT_LAUNCH.percentageSupplyOnMigration` | The rest is sold along the curve. |
| Anti-sniper fee | 50% → 1% over 120 s, exponential, 60 steps | `DEFAULT_LAUNCH.antiSniper` | Snipers' fees go to the treasury and on into the pot. |
| Migrated pool fee | 1% (`FixedBps100`) | `DEFAULT_LAUNCH.migrationFeeOption` | DAMM v2 config `Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp`. |

What the defaults produce (computed from the curve):

| | 85 SOL threshold (default) | 10 SOL threshold |
| - | - | - |
| Start price | 2.66e-8 SOL per FOMO | 3.13e-9 SOL per FOMO |
| Start market cap | ≈ 26.6 SOL | ≈ 3.1 SOL |
| Price at graduation | 4.25e-7 SOL per FOMO | 5.0e-8 SOL per FOMO |
| Market cap at graduation | ≈ 425 SOL | ≈ 50 SOL |
| Price increase along the curve | 16× | 16× |

## Meteora DBC config: fixed by the design (don't change)

The program's `initialize` checks several of these and refuses a pool that doesn't match.

| Setting | Value | Why |
| - | - | - |
| Quote token | SOL (wrapped) | Checked on-chain. Buybacks swap SOL. |
| Token type | Plain SPL, immutable, no mint authority | The game rejects Token-2022 mints. No one can mint more. |
| Fee claimer | Game treasury PDA | Checked on-chain. Gets the partner share of fees. |
| Pool creator | Game treasury PDA (handed over right after pool creation) | Checked on-chain. Gets the creator share. Together: 80% of all trading fees (Meteora keeps 20%). |
| Fee collection | In SOL only (`QuoteToken`) | Checked on-chain. |
| Dynamic fee | On | Extra fee in volatile moments, also to the treasury. |
| First-swap-at-min-fee | Off | Lets our program swap through CPI. |
| Pool creation fee | 0 | |
| Migration fee | 0% | |
| Migration target | DAMM v2 | Required by Meteora for new launches. |
| Migrated liquidity | 100% permanently locked (50% partner + 50% creator), both position NFTs owned by the treasury | Nobody can pull liquidity; LP fees keep funding the pot forever. |
| Team allocation / vesting | None | No presale, no team tokens. |
| Activation | By timestamp, immediately | |

## Game config: your choices

| Setting | Default | Env | Notes |
| - | - | - | - |
| Minimum buy that counts | 0.05 SOL | `MIN_BUY_SOL` | SOL into the pool. Smaller buys and all sells are ignored. |
| Seconds added per buy | 30 | `SECS_PER_BUY` | |
| Round timer | 30 min | `MAX_TIMER_SECS` | Each round starts at 30:00 and the countdown never shows more than 30:00. A round ends after a stretch with no counted buys: 30 min if quiet, longer while people keep buying. |
| Settle grace | 60 s | `SETTLE_GRACE_SECS` | Wait after zero before the round can close, so buys made just before zero are still recorded. |
| Keeper key | (required) | `KEEPER_PUBKEY` | Only key allowed to report buys and buy back. Changeable later via `set_keeper`. |
| Max SOL per buyback | 1 SOL | `MAX_BUYBACK_SOL` | Suggest 0.1 for the first hours, then raise via `set_buyback_limits`. |
| Min gap between buybacks | 300 s | `BUYBACK_GAP_SECS` | |

## Game config: fixed in the program

| Rule | Value |
| - | - |
| Winner | Last counted buyer when the countdown hits 0; paid automatically at settle |
| Buyback split | 70% current jackpot · 20% next round · 10% burned |
| Buyback after the timer hits 0 | Goes to the next round |
| Round with no buyers | Jackpot carries over |

## Keeper settings

| Setting | Default | Env |
| - | - | - |
| RPC | (required, use a paid one) | `RPC_URL` |
| Loop interval | 20 s | `INTERVAL_SECS` |
| Skip buybacks while the swap fee is above | 2% | `MAX_FEE_BPS` |
| Smallest buyback | 0.01 SOL | `MIN_BUYBACK_LAMPORTS` |
| Slippage on buybacks | 1% | `SLIPPAGE_BPS` |
| Private sending | off | `JITO_URL`, `JITO_TIP_LAMPORTS` (default 0.0001 SOL) |

## Attach mode: a token someone else launched

Use this when the token is launched on Meteora by someone else (for example on
launch.meteora.ag) instead of with `npm run launch`. The game attaches to it by CA.

**What the launcher must choose on Meteora (DBC):**

| Setting | Must be |
| - | - |
| Token type | **SPL Token** (not Token-2022: the game rejects Token-2022 mints) |
| Quote token | **SOL** |
| Everything else | Their choice (fees, curve, graduation threshold). Fees stay with them. |

**Then the operator (you):**

1. Deploy the program (README "Mainnet launch", deploy step).
2. Dry run, check the plan, then attach for real:
   ```bash
   cd scripts && KEEPER_PUBKEY=<keeper> MINT=<token CA> npm run attach
   cd scripts && KEEPER_PUBKEY=<keeper> MINT=<token CA> CONFIRM_MAINNET=yes npm run attach
   ```
   Same round settings as launch: `MIN_BUY_SOL`, `SECS_PER_BUY`, `MAX_TIMER_SECS`, `SETTLE_GRACE_SECS`,
   `MAX_BUYBACK_SOL`, `BUYBACK_GAP_SECS`. Buys only count from the moment of attaching.
3. Start the keeper with `MINT=<token CA>`. It skips fee harvesting in this mode.
4. In Vercel also set `VITE_JACKPOT_FUNDING=creator`, so the guide page explains the funding
   correctly. The game screen and rules pop-up switch automatically.

**Funding the jackpot** (anyone can do it; the creator can send their trading fees):

```bash
cd scripts && FUNDER=<wallet.json> MINT=<token CA> FUND_SOL=1 npm run fund
cd scripts && FUNDER=<wallet.json> MINT=<token CA> FUND_TOKENS=5000000 npm run fund
```

SOL goes to the game's buyback wallet; the keeper turns it into FOMO (70% jackpot · 20% next
round · 10% burned), once the token's swap fee is below `MAX_FEE_BPS`. FOMO goes straight into
the current round's jackpot. Both show up in the site's live feed. On mainnet both commands
need `CONFIRM_MAINNET=yes`.
