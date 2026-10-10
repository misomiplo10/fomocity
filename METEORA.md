# Meteora integration research (for FOMO City)

Researched 2026-10-10 from docs.meteora.ag (fetched as raw `.md` via the `llms.txt` index), launch.meteora.ag (HTML and JS bundle), the MeteoraAg GitHub org, and npm. Where a statement comes from reading program source rather than the docs, it says so.

Doc index: https://docs.meteora.ag/llms.txt (the full product list is there).

---

## 0. Quick reference

| Thing | Value |
| - | - |
| DBC program (mainnet = devnet) | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` |
| DBC pool authority PDA | `FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM` |
| DAMM v2 (`cp_amm`) program | `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` |
| DAMM v2 pool authority PDA | `HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC` |
| DAMM v1 (legacy) | `Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB` |
| DLMM (`lb_clmm`) | `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` |
| Locker | `LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn` |
| Dynamic Vault (legacy) | `24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi` |
| Dynamic Fee Sharing | `dfsdo2UqvwfN8DuUVrMRNfQe11VaiNoKcMqLHVvDPzh` (fee vault authority `EYqHRdtepv1KKUkPAYMBYpSfiGfNd8sa55ZtswodTfBS`) |
| Zap | `zapvX9M3uf5pvy4wRPAbQgdQsM1xmuiFnkfHKPvwMiz` |
| Presale Vault (beta) | `presSVxnf9UU8jMxhgSMqaRwNiT36qeBdNeTRKjTdbj` |
| Alpha Vault | `vaU6kP7iNEGkbmPkLmZfGwiGxd4Mob24QQCie5R9kd2` |
| Stake2Earn (legacy, DAMM v1 only) | `FEESngU3neckdwib9X3KWqdL7Mjmqk9XNp3uh5JbP4KP` |
| DBC migration keepers | `Asi5DTGEeiso6k7ya6ndDabEZ7DRCgfTpCBLPH5E3aQs`, `DeQ8dPv6ReZNQ45NfiWwS5CchWpB2BVq1QMyNV8L2uSW` |
| Manual migrator UI | https://migrator.meteora.ag (mainnet + devnet) |

npm packages (latest versions as of the research date):

| Package | Version | Main export |
| - | - | - |
| `@meteora-ag/dynamic-bonding-curve-sdk` | 1.5.13 | `DynamicBondingCurveClient` |
| `@meteora-ag/cp-amm-sdk` (DAMM v2) | 1.5.1 | `CpAmm` |
| `@meteora-ag/dlmm` | 1.9.14 | `DLMM` (default export) |
| `@meteora-ag/zap-sdk` | 1.3.2 | |
| `@meteora-ag/dynamic-fee-sharing-sdk` | 1.1.0 | |
| `@meteora-ag/alpha-vault` | 1.1.16 | |
| `@meteora-ag/presale` | 0.1.1 | |

Both DBC and DAMM v2 are built on **Anchor 1.0.2** (from the repo `Cargo.toml`). FOMO City uses Anchor 1.2.1.

---

## 1. Dynamic Bonding Curve (DBC)

Sources: https://docs.meteora.ag/core-products/dbc/what-is-dbc · /core-products/dbc/launch-configurations · /core-products/dbc/fees/overview · /core-products/dbc/fees/fee-scheduler · /core-products/dbc/fees/dynamic-fees · /core-products/dbc/migration-and-liquidity · /core-products/dbc/surplus-and-leftover · /core-products/dbc/accounts-and-permissions · /core-products/dbc/universal-curve · /developer-guides/dbc/index · /developer-guides/dbc/program/instructions

### How a launch works
1. A **partner** (launchpad) creates a reusable `PoolConfig` (the "config key"). It fixes the quote mint, curve, fees, token type, migration target, LP distribution, `fee_claimer` and `leftover_receiver`. Anyone can pay to create one.
2. A **creator** calls `initialize_virtual_pool_with_spl_token` (or `..._with_token2022`) against that config. This creates the base mint, its metadata and a **virtual pool**. With standard configs, mint authority is revoked at launch.
3. Traders `swap`/`swap2` against the curve. Every buy adds quote to the pool.
4. When `quote_reserve >= migration_quote_threshold`, curve trading stops. The pool moves to `PostBondingCurve` (if locked vesting is configured) or straight to `LockedVesting`.
5. Migration (`migration_damm_v2`) creates a DAMM v2 pool at the discovered price, creates position NFTs, applies the locks, and hands ownership to the partner and creator. The pool then reaches `CreatedPool`.
6. Cleanup: surplus, migration fee and leftover claims.

Migration states: `PreBondingCurve` → `PostBondingCurve` → `LockedVesting` → `CreatedPool`.

### Curve config (Universal Curve)
- The curve is `sqrt_start_price` plus **1 to 16 curve points**. Each point has an upper sqrt price and a liquidity value, and each segment is a constant-product range. Prices must strictly increase.
- The program derives the migration price from `migration_quote_threshold`, `sqrt_start_price` and the points. It also computes `swap_base_amount`.
- Sqrt price bounds: `4295048016` up to `79226673521066979257578248091`.
- Base token decimals must be 6 to 9.
- Supply is either **dynamic** (minted from the curve with a 25% swap buffer) or **fixed** (`pre_migration_token_supply` / `post_migration_token_supply`). Fixed supply requires a non-default `leftover_receiver`.
- SDK builders all return `ConfigParameters`: `buildCurve` (percentageSupplyOnMigration plus migrationQuoteThreshold), `buildCurveWithMarketCap` (initialMarketCap/migrationMarketCap), `buildCurveWithTwoSegments`, `buildCurveWithMidPrice`, `buildCurveWithLiquidityWeights` (16 weights), and `buildCurveWithCustomSqrtPrices`.

### Migration
- New configs **must** use DAMM v2 (`MigrationOption.MET_DAMM_V2 = 1`). DAMM v1 is rejected for new configs.
- **Migrated pool fee options** (`MigrationFeeOption`): 0=25 bps, 1=30, 2=100, 3=200, 4=400, 5=600, 6=Customizable (DAMM v2 only, 10 to 1000 bps). The DAMM v2 config keys are:
  `7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd` (25), `2nHK1kju6XjphBLbNxpM5XRGFj7p9U8vvNzyZiha1z6k` (30), `Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp` (100), `2c4cYd4reUYVRAB9kUUkrq55VPyy2FNQ3FDL4o12JXmq` (200), `AkmQWebAwFvWk55wBoCr5D62C6VVDTzi84NJuD9H7cFD` (400), `DbCRBj8McvPYHJG1ukj8RE15h2dCNUdTAESG49XpQ44u` (600), `A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck` (customizable).
- Customizable migrated pools can set the collect fee mode (`QuoteToken` / `OutputToken` / `Compounding` plus `compoundingFeeBps`), dynamic fee on/off, and a DAMM v2 **market-cap fee scheduler** (`endingBaseFeeBps`, `numberOfPeriod`, `priceMultiple`, `schedulerExpirationDuration`).
- **Migrated-liquidity split** must total 100% across partner {unlocked, permanent-locked, vesting} and creator {unlocked, permanent-locked, vesting}. At least **10% must still be locked one day after migration**. Vesting is capped at 2 years.
- **Optional migration fee**: `feePercentage` is 0 to 99% of the migration quote, and `creatorFeePercentage` is that fee's creator share. It is withdrawn with `withdraw_migration_fee`.
- There is a fixed **0.2% protocol liquidity migration fee** on top of that.
- **Mainnet keepers auto-migrate** when `migration_quote_threshold` matches a supported quote: **SOL 10**, **USDC 750**, USD1 750, JupUSD 750, JUP 1500, MET 1500, TRUMP 100, VIRTUAL 42000. They also migrate Stock Tokens at 750 USD or more, and Jupiter-verified quote tokens with an organic score above 50 and a notional value above 750 USD. Otherwise, use the SDK `migrateToDammV2` or migrator.meteora.ag.
  - *Unverified:* whether "matches" means "equals" or "at least" for SOL and USDC. The Stock Token wording says "at least". To be safe, plan to run your own migration (SDK or migrator UI) if your threshold differs.

### Fees (bonding phase)
- Fee = base fee + optional dynamic fee. The denominator is 1e9. **Minimum base fee is 0.25%** (`2_500_000`) and the **total cap is 99%**.
- Base fee modes (`BaseFeeMode`): `FeeSchedulerLinear=0`, `FeeSchedulerExponential=1`, and `RateLimiter=2`, which is **deprecated and rejected** for new configs. A fixed fee is a scheduler with period, number and reduction all set to 0.
  - Scheduler fields are cliff fee, `number_of_period`, `period_frequency` and `reduction_factor`. The SDK helper `getFeeSchedulerParams` takes `startingFeeBps`, `endingFeeBps`, `numberOfPeriod` and `totalDuration`.
  - The schedule is measured from activation (`ActivationType.Slot=0 | Timestamp=1`).
- Dynamic fee: a volatility accumulator. The SDK helper caps it at 20% of the base fee.
- **Anti-sniper** options:
  - A high starting scheduler fee (up to 99%) that decays linearly or exponentially.
  - The dynamic fee.
  - `enableFirstSwapWithMinFee`, which lets the creator's bundled first buy, in the same tx as pool init, pay the minimum fee. It only works top-level, not through CPI.
- Collect fee mode (`CollectFeeMode`): `QuoteToken=0` (all fees in SOL/USDC) or `OutputToken=1`.
- **Fee split:**
  - Protocol takes **20%** of the trading fee. A referral, if present, gets 20% *of the protocol fee*.
  - The remaining **80%** splits between partner and creator by `creatorTradingFeePercentage` (0 to 100).
  - Fees **accrue on the virtual pool and are claimable at any time**. You don't have to wait for migration.
- Pool creation fee: optional, 0.001 to 100 SOL, paid by the creator at launch. Partner gets 90%, protocol 10%.
- Surplus: quote above the threshold on the final buy. Protocol gets 20%. The remaining 80% splits partner/creator by the same creator percentage, and each side claims once.

### Claiming (instructions / SDK)
| Who | Instruction | Signer check | SDK |
| - | - | - | - |
| Partner | `claim_trading_fee(max_amount_a, max_amount_b)` | `config.fee_claimer` (access_control `is_partner_fee_claimer`) | `client.partner.claimPartnerTradingFee` / `claimPartnerTradingFeeToReceiver` |
| Creator | `claim_creator_trading_fee(max_base, max_quote)` | `pool.creator` (access_control `is_pool_creator`) | `client.creator.claimCreatorTradingFee` / `...ToReceiver` |
| Partner/creator | `partner_withdraw_surplus` / `creator_withdraw_surplus` | as above | `partnerWithdrawSurplus` / `creatorWithdrawSurplus` |
| Partner/creator | `withdraw_migration_fee(flag)` | as above | `partnerWithdrawMigrationFee` / `creatorWithdrawMigrationFee` |
| Partner | `claim_partner_pool_creation_fee` | fee_claimer | `claimPartnerPoolCreationFee` |
| Creator | `transfer_pool_creator` | current creator | `client.creator.transferPoolCreator` |

Two points from the program source (`programs/dynamic-bonding-curve/src/lib.rs` and `instructions/creator/*`) matter for us:
- The `creator` and `fee_claimer` signers are plain `Signer`s compared against stored pubkeys. **A PDA can be either one**, and it signs via `invoke_signed`.
- The destination token accounts (`token_a_account`/`token_b_account`) are unconstrained.
- `transfer_pool_creator` always works in `PreBondingCurve`. It has extra conditions after `CreatedPool`, and those only apply to DAMM v1.

### Quote tokens
- Any SPL quote mint is permissionless: SOL (`So111...112`, as WSOL through SPL Token), USDC, and so on.
- Token-2022 quote mints work permissionlessly only with `MetadataPointer`/`TokenMetadata` extensions and zero transfer fee. Others need a Meteora-issued **token badge**.
- The Token-2022 native mint is rejected as a quote mint.

---

## 2. launch.meteora.ag

Source: https://launch.meteora.ag (HTML and lazy-loaded JS chunks inspected), plus https://docs.meteora.ag/invent/scaffold/fun-launch and /invent/launch-pools/dbc-token-launch-pool

- **What it is:** a landing page for Meteora launch products (DLMM, DAMM v1, DAMM v2, DBC, plus Presale Vault, Dynamic Fee Sharing, Alpha Vault and Stake2Earn). Each card links to docs or the migrator.
- **The DBC card's "Configure Now" button** opens a wallet-connected modal (`dynamicBondingCurve.createConfigKey`). It is a **partner/launchpad DBC config-key generator**, not a creator token-launch form.
  - Fields, taken from the bundle strings: Quote Mint, Build Curve Mode, Total Token Supply, Token Type, Token Update Authority, Base Fee Mode with starting/ending fee bps, number of periods and total duration, Dynamic Fees, Collect Fee Mode, Creator Trading Fee %, Pool Creation Fee, and Enable First Swap With Min Fee.
  - Migration fields: Migration Option, Migration Fee Option, Migration Fee %, Creator Migration Fee %, Migrated Pool Collect Fee Mode, Pool Fee BPS, and a market-cap scheduler with price multiple.
  - LP fields: Partner/Creator LP %, Locked LP % and vesting.
  - Also: Locked Vesting, Fee Claimer, Leftover Receiver, an optional Transfer Hook, "Create Metadata" (partner metadata), and a "My Configs" list.
  - Its help text says the fee claimer wallet "will collect all the fees launched using your config key".
- **How a creator then launches:** through a front-end that uses the config key. Options are your own app (SDK `client.creator.createPool` / `createPoolWithFirstBuy`), the open-source **Fun Launch** scaffold in `MeteoraAg/meteora-invent` (`POOL_CONFIG_KEY` env), or the **Meteora Invent studio CLI** (`studio/config/dbc_config.jsonc`, actions `dbc-create-config` and `dbc-create-pool`).
- Third-party launchpads like Bags and Believe-style apps run on their own DBC partner configs. There is no single "Meteora launchpad config" that creators must use.
- *Not verified:* I did not connect a wallet or submit the modal.

---

## 3. DAMM v2 (CP-AMM)

Sources: https://docs.meteora.ag/core-products/damm-v2/what-is-damm-v2 · /core-products/damm-v2/fees/overview · /fees/time-scheduler · /fees/market-cap-scheduler · /core-products/damm-v2/nft-positions · /core-products/damm-v2/compounding-liquidity · /core-products/damm-v2/token-2022-support · /developer-guides/damm-v2/index · /developer-guides/damm-v2/pool-fee-configs · /developer-guides/damm-v2/program/instructions · /developer-guides/damm-v2/typescript-sdk/reference

- **Pool creation** has three paths:
  - `initialize_pool`: static config. PDA = `"pool"` + config + sorted mints. SDK `createPool`.
  - `initialize_pool_with_dynamic_config`: needs the config's `pool_creator_authority` signer. SDK `createCustomPoolWithDynamicConfig`.
  - `initialize_customizable_pool`: no config. PDA = `"customizable_pool"` + sorted mints. SDK `createCustomPool`, which returns `{tx, pool, position}`.
  - Helpers: `preparePoolCreationParams` and `preparePoolCreationSingleSide`.
- **Liquidity** is either a concentrated fixed range (`sqrt_min_price`/`sqrt_max_price`) or full-range **Compounding** (`compounding_fee_bps` of the LP fee is re-added to reserves).
- **Fees:** total = min(base + dynamic, cap). The denominator is 1e9. Base fee is 1 bps to 99%.
  - Protocol takes 20%. A referral gets 20% of protocol. LPs get the rest.
  - Base modes: `FeeTimeSchedulerLinear=0`, `FeeTimeSchedulerExponential=1`, `RateLimiter=2` (deprecated), `FeeMarketCapSchedulerLinear=3`, `FeeMarketCapSchedulerExponential=4`. The market-cap modes lower the fee only as the sqrt price rises by `sqrt_price_step_bps`, and fall back to the final fee after `scheduler_expiration_duration`.
  - The dynamic fee is a volatility accumulator.
  - Collect modes: `BothToken=0`, `OnlyB=1` (quote only), `Compounding=2`.
- **Position NFTs:** each position is a Token-2022 NFT (name "Meteora Position NFT", symbol "MPN"). Whoever holds it controls the position.
  - A position can be split (`split_position2`) and has unlocked, vesting and permanent-locked buckets. **Locked liquidity still earns fees.**
  - From source: **delegate permissions** (`update_delegate_permission`, bits AddLiquidity, RemoveLiquidity(ToOwner), ClaimPositionFee(ToOwner), ClaimReward(ToOwner), LockPosition). An SPL delegate with `amount=0` can claim fees *to the owner*. That suits a keeper claiming on behalf of a PDA owner.
- **Claiming fees:** `claim_position_fee`, SDK `claimPositionFee` / `claimPositionFee2`. Accounts: pool authority, pool, position, user token A/B accounts, vaults, mints, `position_nft_account` (amount==1), signer (NFT owner or permitted delegate), token programs, and event CPI accounts.
  - Unclaimed amounts: `getUnClaimLpFee(poolState, positionState)`.
- **Locking:** `permanent_lock_position` (`permanentLockPosition`), `lock_position` / `lock_inner_position` for vesting (`lockPosition`), and `refresh_vesting`.
- **Swaps:** `swap2` with `SwapMode` ExactIn/PartialFill/ExactOut (`amount_0`/`amount_1` semantics as in DBC). Quote with `getQuote2`.
- **Liquidity mining:** up to 2 reward tokens per pool (`initializeReward`, `fundReward`, `claimReward`).
- SDK client: `const cpAmm = new CpAmm(connection)`.

---

## 4. DLMM (brief)

Sources: https://docs.meteora.ag/core-products/dlmm/what-is-dlmm · /core-products/dlmm/strategies-and-use-cases · /developer-guides/dlmm/typescript-sdk/getting-started

- Concentrated liquidity in discrete **price bins**. Trades inside a bin have zero slippage, and only the active bin trades.
- Bin step is up to 400 bps. Bin arrays hold 70 bins. `PositionV2` can extend to 1,400 bins.
- Liquidity shapes (strategies): **Spot**, **Curve**, **Bid-Ask**.
- Fees are a base fee plus a variable (volatility) fee. There is a collect-fee mode (input token or token Y).
- Pools run in one of two modes: liquidity-mining rewards *or* limit orders, not both.
- SDK: `const dlmmPool = await DLMM.create(connection, poolPubkey)`. Methods include `swapQuote`, `swap`, `swapExactOut`, `initializePositionAndAddLiquidityByStrategy`, `claimSwapFee`, `claimAllRewards`, `placeLimitOrder` and `seedLiquidity`.
- For a game token, DLMM is mainly useful for an active market-maker or treasury bid-ask ladder. It is not needed for launch.

---

## 5. Helper and legacy products (brief, with fit for a game)

| Product | What it does | Useful for FOMO City? |
| - | - | - |
| **Dynamic Fee Sharing** (/helper-products/dynamic-fee-sharing/*) | Fee vault for **one mint** with 2 to 5 fixed recipients and shares, which are immutable. A **PDA vault** can be funded *directly by claim actions*: DBC `ClaimTradingFee`, `ClaimCreatorTradingFee`, `Partner/CreatorWithdrawSurplus`, `WithdrawMigrationFee`, and DAMM v2 `ClaimPositionFee`, `ClaimReward`. Needs single-token fee mode (DBC `QuoteToken`, DAMM v2 `OnlyB`/`Compounding`). Each recipient claims by signing. | **Maybe.** It is a no-code way to split SOL fees, for example jackpot-treasury PDA 80% and dev 20%. Our own program can do the same split more flexibly, so it is optional. |
| **Alpha Vault** (/helper-products/alpha-vault/*) | Pre-launch quote deposits that buy in the pool's pre-activation window (pro-rata or FCFS, optional vesting). Works with DLMM and DAMM v1/v2 launch pools. **Not DBC.** | Low. It only matters for a whitelisted fair launch on a DAMM v2 or DLMM pool. |
| **Presale Vault** (beta) (/helper-products/presale-vault/*) | Standalone presale (Fixed Price, FCFS or Pro Rata), up to 5 registries, refunds, vesting, unsold burn or return. | Low to medium. Use it only if you want a presale instead of a bonding curve. |
| **Zap** (/helper-products/zap/*) | Zap in and out for DAMM v2 and DLMM positions. Zap-out swaps received tokens via DAMM v2, DLMM or Jupiter v6. | Low. It is a UX helper. |
| **Dynamic Vault** (legacy) | Single-asset lending-yield vault with LP shares. | No. |
| **Stake2Earn** (legacy) | Top-N stakers earn **DAMM v1** lock-escrow fees. | No. It is DAMM v1 only, and DBC can no longer migrate to v1. |
| DAMM v1 (legacy) | Older constant-product AMM. | No. |

---

## 6. CPI from an Anchor program

Sources: https://docs.meteora.ag/developer-guides/dbc/rust-integration/cpi · /developer-guides/dbc/rust-integration/library · /developer-guides/damm-v2/rust-integration/cpi · https://github.com/MeteoraAg/cpi-examples

**Bindings**
- Either use the crate with the `cpi` feature:
  - `dynamic-bonding-curve = { git = "https://github.com/MeteoraAg/dynamic-bonding-curve", features=["cpi"] }`
  - `cp-amm` from `MeteoraAg/damm-v2` with `features=["cpi"]`
- Or generate bindings from the IDL. The DBC IDL is in `dynamic-bonding-curve-sdk/.../idl.json` and the DAMM v2 one is `damm-v2-sdk/src/idl/cp_amm.json`.
- Both programs use Anchor 1.0.2. Since we are on 1.2.1, **`declare_program!` from pinned IDLs** is probably the least painful route. *Unverified:* that the crates themselves compile cleanly alongside 1.2.1.

**Rust quote libraries (pure math, usable on-chain or in a keeper)**
- `dynamic-bonding-curve-sdk` crate: `quote_exact_in`, `quote_exact_out`, `quote_partial_fill`.
- DAMM v2 `rust-sdk` crate.

**DBC CPI suitability (per docs)**
- Fee claims: good.
- Swaps: possible.
- Pool creation: heavy.
- Migration: advanced; prefer the keeper or SDK.

**DBC `swap2` accounts** (from `ix_swap.rs`)
- `pool_authority`, `config`, `pool`, `input_token_account`, `output_token_account`, `base_vault`, `quote_vault`, `base_mint`, `quote_mint`, `payer` (Signer, which can be a PDA), `token_base_program`, `token_quote_program`, optional `referral_token_account`, plus `event_authority` and `program`.
- Args: `SwapParameters2 { amount_0, amount_1, swap_mode }`.
- Remaining accounts: the instructions sysvar is needed only for rate-limiter pools or pools with first-swap-min-fee enabled. Leave `enableFirstSwapWithMinFee` off if you want plain CPI swaps.

**DBC claim accounts**
- `pool_authority`, `pool`, `token_a_account`, `token_b_account` (destinations), `base_vault`, `quote_vault`, `base_mint`, `quote_mint`, `creator` (or `fee_claimer` for the partner variant, which also takes `config`), the token programs, and event CPI accounts.

**DAMM v2 `swap2`**
- `pool_authority`, `pool`, `input_token_account`, `output_token_account`, `token_a_vault`, `token_b_vault`, `token_a_mint`, `token_b_mint`, `payer`, `token_a_program`, `token_b_program`, optional `referral_token_account`, `event_authority`, `program`.
- The docs warn: do not hand-order accounts; use generated bindings.

**DAMM v2 `claim_position_fee`:** see section 3.

**Examples repo**
- `MeteoraAg/cpi-examples` (Anchor 0.31) covers only **DLMM swap** and **DAMM v1** (swap, init pool, lock, claim fee), plus m3m3.
- There is **no DBC or DAMM v2 CPI example repo**. Use the DBC repo's `tests/*.ts` and the DAMM v2 `tests/*.ts` (for example `claimPositionFee.test.ts`, `swap.test.ts`, `delegatePosition.test.ts`) as account-order references.

**Gotchas**
- DBC wraps downstream CPIs with lamport, owner and data-length invariant checks (`AccountInvariantViolation`).
- Wrapped SOL accounts must be prepared explicitly; the SDK does this for you, CPI does not.
- Token program per mint must match.
- Slippage limits should be passed in, not computed blindly, because an on-chain buyback can be sandwiched.

---

## 7. TypeScript SDK cheat-sheet

**DBC (`@meteora-ag/dynamic-bonding-curve-sdk`)**
```ts
const client = DynamicBondingCurveClient.create(connection, "confirmed");
// partner
const cfg = buildCurveWithMarketCap({...})  // or buildCurve / buildCurveWithCustomSqrtPrices ...
await client.partner.createConfig({ config, feeClaimer, leftoverReceiver, payer, quoteMint: NATIVE_MINT, ...cfg });
// creator
await client.creator.createPool({ baseMint, config, name, symbol, uri, payer, poolCreator });
await client.creator.createPoolWithFirstBuy({...});            // bundled dev buy
// quote + swap
const q = client.pool.swapQuote2({ virtualPool, config, swapBaseForQuote:false, swapMode: SwapMode.ExactIn,
                                   amountIn, slippageBps, hasReferral:false, eligibleForFirstSwapWithMinFee:false, currentPoint });
await client.pool.swap2({ owner, payer, pool, swapBaseForQuote:false, swapMode: SwapMode.ExactIn, amountIn,
                          minimumAmountOut: q.minimumAmountOut, referralTokenAccount: null });
// fees
await client.state.getPoolFeeBreakdown(pool);   // claimable partner/creator
await client.partner.claimPartnerTradingFeeToReceiver({ feeClaimer, payer, pool, maxBaseAmount, maxQuoteAmount, receiver });
await client.creator.claimCreatorTradingFeeToReceiver({ creator, payer, pool, maxBaseAmount, maxQuoteAmount, receiver });
await client.creator.transferPoolCreator({...});
// migration / progress
await client.state.getPoolQuoteTokenCurveProgress(pool);
await client.migration.migrateToDammV2({ payer, pool, dammConfig });
deriveDbcPoolAddress(quoteMint, baseMint, config); deriveDammV2PoolAddress(...)
```

**DAMM v2 (`@meteora-ag/cp-amm-sdk`)**
- Setup: `const cp = new CpAmm(connection)`.
- Create pool: `createPool`, `createCustomPool`, `createCustomPoolWithDynamicConfig`, `preparePoolCreationParams`.
- Swap: `getQuote2` then `swap2`.
- Claim fees: `getPositionsByUser` / `getUserPositionByPool`, then `claimPositionFee2`. `getUnClaimLpFee` shows what is pending.
- Lock: `permanentLockPosition`, `lockPosition`.
- Liquidity: `addLiquidity`, `removeLiquidity`.

**DLMM (`@meteora-ag/dlmm`)**
- Setup: `DLMM.create(connection, pool)`.
- Swap: `swapQuote` then `swap`.
- Fees: `claimSwapFee`.

---

## 8. Token-2022 support

Sources: https://docs.meteora.ag/core-products/dbc/token-2022-support · /core-products/dbc/transfer-hook-pools · /core-products/damm-v2/token-2022-support · /core-products/dlmm/token-2022-support

**DBC base tokens**
- DBC can launch SPL (`TokenType.SPLToken=0`, Metaplex metadata) or Token-2022 (`=1`, with MetadataPointer and TokenMetadata initialized by DBC).
- Token-2022 launches must migrate to DAMM v2.
- Transfer-hook launches use a separate path: `create_config_with_transfer_hook`, `TransferHookPool`, `swap2_with_transfer_hook`, `claim_*_fee2`. The hook is **revoked at curve completion**.
- Other base extensions are not supported.

**DBC quote tokens**
- SPL or plain Token-2022 with metadata extensions only, and zero transfer fee. Anything else needs a badge.

**DAMM v2**
- Permissionless extensions: `TransferFeeConfig`, `MetadataPointer`, `TokenMetadata`, and `TransferHook` only when both its program and authority are unset.
- Others (permanent delegate, interest-bearing, pausable, non-transferable, and so on) need a **token badge**, applied for via Google Form and Discord.
- Position NFTs are Token-2022.

**Dynamic Fee Sharing**
- Supports only `TransferFeeConfig`/`MetadataPointer`/`TokenMetadata` Token-2022 mints.

**Relevance to FOMO City:** `initialize` requires `mint.data_len() == 82`, so it takes plain mints only. **Launch with `TokenType.SPLToken`.** That produces an 82-byte SPL mint with Metaplex metadata, which is compatible. A DBC Token-2022 launch would carry metadata extensions and be rejected by our program.

---

## 9. Recommended integration design for FOMO City

**Goal:** the game token launches on DBC, and Meteora trading fees (paid in SOL) flow back into the token jackpot through buybacks. Snipers and early traders end up funding the pot.

### 9.1 Launch configuration (create once via SDK or launch.meteora.ag)
**Token and quote**
- `quoteMint = WSOL`.
- `tokenType = SPLToken`, 6 decimals.
- `tokenAuthorityOption = Immutable` (mint authority is revoked anyway).

**Curve**
- `buildCurveWithMarketCap` (or `buildCurve`), with `migrationQuoteThreshold` that one of the mainnet keeper thresholds accepts. **10 SOL qualifies** but is small; a larger value works if you run the migration yourself (see the 9.4 caveat).

**Bonding-phase fees**
- `collectFeeMode = QuoteToken`, so every fee is SOL.
- `baseFeeMode = FeeSchedulerExponential`, for example 50% decaying to 1% over about 120 s.
- `dynamicFeeEnabled = true`.
- `enableFirstSwapWithMinFee = false`, which keeps CPI swaps simple.

**Fee recipients and creator**
- `feeClaimer` = **game treasury PDA**, for example `seeds = [b"meteora", game]`.
- Launch from a deployer wallet, then immediately `transfer_pool_creator` to the **same PDA**.
- With both roles on the PDA, the game receives **80% of all DBC trading fees** (the protocol keeps 20%), and `creatorTradingFeePercentage` doesn't matter.
- `poolCreationFee = 0`.

**Migration**
- `migrationOption = MET_DAMM_V2` with `migrationFeeOption = Customizable` (or the 100 or 200 bps fixed option).
- Migrated pool: `collectFeeMode = QuoteToken` (OnlyB, SOL fees), with an optional market-cap scheduler.
- `migrationFee.feePercentage`: 0 to 5%.

**Liquidity distribution**
- For example **partner 50% permanently locked + creator 50% permanently locked**. Liquidity is locked forever but **its position NFTs land in the PDA and keep earning SOL fees**, so the jackpot keeps getting funded after migration.
- If you want to rebalance later, keep about 10 to 20% as `partnerLiquidityPercentage` (unlocked).

### 9.2 New program instructions (fomocity)
1. **`harvest_dbc`** (permissionless crank, before migration)
   - CPI `claim_trading_fee` (PDA as `fee_claimer`) and `claim_creator_trading_fee` (PDA as `creator`) into a PDA-owned WSOL account.
   - After curve completion, also CPI `partner_withdraw_surplus`, `creator_withdraw_surplus` and `withdraw_migration_fee`.
2. **`harvest_damm_v2`** (permissionless, after migration)
   - CPI `claim_position_fee` for each PDA-owned position NFT.
   - Store the position pubkeys in `Game` once they are known. The pool PDA comes from `deriveDammV2PoolAddress(config, baseMint, WSOL)`.
3. **`buyback`** (crank-gated)
   - CPI `swap2` on DBC while `migration_progress == PreBondingCurve`, otherwise DAMM v2 `swap2`, ExactIn WSOL → game token. `payer` is the PDA.
   - Deposit the output into the existing `vault`.
   - Credit it with a split, for example **70% to the current round's jackpot, 20% to next-round seed, 10% burned** (SPL `burn` from the PDA account, which gives you "buyback-and-burn").
   - Keep the existing 5% dev cut on player buys as is. Alternatively, take the dev share from harvested SOL *before* the buyback instead.
4. **MEV and slippage safeguards for `buyback`**
   - Cap SOL spent per call and enforce a minimum slot gap.
   - Require `min_out` from an authorized keeper, which quotes off-chain with `swapQuote2` / `getQuote2`.
   - Or compute an on-chain floor with the `dynamic-bonding-curve-sdk` `quote_exact_in` against pre-trade state and reject if the price moved more than X bps since the last recorded price.
   - Submit through a Jito bundle or private RPC.
   - Store the DBC pool, config, DAMM v2 pool and vault pubkeys in `Game` and validate them with `address =` constraints, so a crank cannot redirect funds.
5. **Bindings:** use `declare_program!(dynamic_bonding_curve)` and `declare_program!(cp_amm)` from IDLs pinned under `idls/`. Mirror account order from the repos' TypeScript tests. Test on devnet, where the program IDs are the same, using the migrator UI for devnet migration.

### 9.3 Why this design
- It needs **no changes to game rules**. Players still spend the token on floors, and the jackpot just grows from outside revenue.
- Early anti-sniper fees (up to 99%) go straight into the pot, which turns sniping into jackpot marketing.
- Buybacks create steady buy pressure. Burns are optional and add a deflationary story.
- The flow survives migration: DBC fees before, locked DAMM v2 LP fees after, and both are claimable by the PDA through CPI.

### 9.4 Alternatives and caveats
- **Simpler v1:** skip the on-chain buyback. Run an off-chain keeper that claims fees with `claimPartnerTradingFeeToReceiver`/`claimCreatorTradingFeeToReceiver` into a treasury wallet, swaps with the SDK, and calls a new `fund_jackpot(amount)` instruction. Less trustless, but much faster to ship.
- Dynamic Fee Sharing can split SOL fees between the treasury PDA and the dev wallet without code, but recipients must sign to claim and the split can never be edited.
- If the migration threshold isn't on the keeper list, migrate yourself with `client.migration.migrateToDammV2`, using DAMM v2 config key `A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck` for customizable fees.

### 9.5 Things I could not verify
- How the keeper threshold "matches" rule works (exact value or minimum).
- That Meteora's crates compile with Anchor 1.2.1. `declare_program!` from the IDL is the suggested workaround.
- How the launch.meteora.ag config modal behaves end to end. I read its fields from the JS bundle but did not submit it.
- Whether any DBC instruction rejects CPI callers. I found no such check in `swap`/`claim` source: `payer`/`creator` are plain `Signer`s, and the only CPI-related restriction found is that the first-swap-min-fee path must be top-level.

### 9.6 Verified on localnet (2026-10-10)
Tested end to end against the real mainnet DBC and DAMM v2 programs cloned into `solana-test-validator` (`scripts/localnet.test.ts`):
- `declare_program!` with the IDLs in `idls/` compiles under **Anchor 1.2.1** (needs a direct `bytemuck` dependency for the zero-copy account types).
- A PDA works as `fee_claimer` and as `creator` via `invoke_signed`: `claim_trading_fee`, `claim_creator_trading_fee`, `partner_withdraw_surplus` and `creator_withdraw_surplus` all succeed through CPI. Claimed amounts equal `partner_quote_fee + creator_quote_fee` exactly.
- CPI `swap2` succeeds on both DBC (with `enableFirstSwapWithMinFee = false`) and DAMM v2.
- Migration to DAMM v2 with config `Hv8Lm…` (FixedBps100) places both position NFTs in the treasury PDA, and `claim_position_fee` through CPI works.
- Migrated pool layout: token A = base (our token), token B = WSOL. The DAMM pool address is `["pool", config, max(mintA, mintB), min(mintA, mintB)]`, so the program derives it from the config at `initialize`.
- Localnet needs two extra clones: the DBC pool authority `FhVo3…` (it pays rent for the DAMM accounts at migration; on mainnet it holds about 69 SOL) and mainnet Token-2022 (the validator's built-in version fails the position-NFT metadata realloc).

## 10. DAMM v2 source review (github.com/MeteoraAg/cp-amm → MeteoraAg/damm-v2)

`cp-amm` redirects to the DAMM v2 repo; `programs/cp-amm` is the program FOMO City migrates into and CPIs for `swap2` and `claim_position_fee`. Read 2026-10-10 at repo version 0.2.4.

- **Operators can pause pools and change fees.** `set_pool_status` (permission `SetPoolStatus`) and `update_pool_fees` (`UpdatePoolFees`) let Meteora-whitelisted operator accounts disable a pool or change its fees after launch. A disabled pool rejects swaps (`can_swap` requires `PoolStatus::Enable`), so `buyback_damm` would fail and SOL would pile up in the WSOL vault until it is re-enabled. Operators cannot move LP or user funds.
- **Fee claims are not gated by pool status.** `claim_position_fee` only checks that the NFT account holds the position (`amount == 1`), that the signer is the owner or a permitted delegate, and that `delegated_amount == 0`. The treasury can keep harvesting LP fees even while a pool is paused.
- **The single-swap rule doesn't apply to us.** `validate_single_swap_instruction` (no CPI deeper than stack height 2, no other swap on the same pool in the transaction) only runs for `RateLimiter` pools. That mode is deprecated and our migrated pool doesn't use it, so CPI buybacks are allowed (confirmed on localnet).
- **Swaps go through a pinocchio fast path** (`ix_p_swap.rs`, dispatched in `entrypoint.rs`) that still emits Anchor-style CPI events. It works through CPI.
- **Permanent lock is final.** Locked liquidity can't be removed by anyone, but it still earns fees.
- **Delegates (0.2.2+)** let an owner grant `ClaimPositionFeeToOwner` to another key. We don't need this, because the PDA claims directly.
- **Version drift.** The repo's `Cargo.toml` says 0.2.4 while the SDK IDL we pinned says 0.2.5, so the deployed program may be ahead of the public source. Our localnet test ran the deployed mainnet bytecode, so behaviour is verified. An audit should still diff the deployed program against the source.
