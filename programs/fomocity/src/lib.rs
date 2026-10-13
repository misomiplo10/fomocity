//! FOMO City: last-buyer-wins game around a token launched on Meteora's Dynamic Bonding
//! Curve (DBC).
//!
//! Playing = buying the token anywhere (Jupiter, Meteora, any wallet). The keeper watches the
//! game's Meteora pools and reports each qualifying buy with `record_buy` (wallet, SOL, block
//! time, transaction signature, all public so anyone can check it against the chain). Each
//! buy adds time to the round's countdown; when it runs out, `settle` pays the whole jackpot
//! to the last buyer in the same instruction and records them in the winners list.
//!
//! The jackpot comes from Meteora trading fees. The game's `treasury` PDA is both the DBC
//! config's `fee_claimer` and the pool's `creator`, so it collects 80% of every
//! bonding-curve trading fee in SOL. After migration it owns the permanently locked DAMM v2
//! LP positions and keeps collecting their SOL fees. Anyone can `harvest_*`; the keeper calls
//! `buyback_*` to swap that SOL for the game token, which is split
//! 70% current jackpot · 20% next-round seed · 10% burned.
//!
//! Funds sit in program-owned accounts that only these instructions can move.
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Burn, Mint, TokenAccount, TokenInterface, TransferChecked};

declare_id!("61MMtvjnH4RgJj21HCPB9KNBdaAVwsThbt5czkDTTN6H");

declare_program!(dynamic_bonding_curve);
declare_program!(cp_amm);

use cp_amm::accounts::Pool as DammPool;
use dynamic_bonding_curve::accounts::{PoolConfig as DbcConfig, VirtualPool as DbcPool};

pub const BPS: u64 = 10_000;
/// Recent buys and winners kept on the Game account for the website.
pub const RECENT_BUYS: usize = 16;
pub const WINNERS_KEPT: usize = 10;

// Buyback output split; jackpot gets the remainder (7_000 bps + dust).
pub const BUYBACK_NEXT_ROUND: u64 = 2_000;
pub const BUYBACK_BURN: u64 = 1_000;

pub const WSOL_MINT: Pubkey = Pubkey::from_str_const("So11111111111111111111111111111111111111112");
const DBC_COLLECT_FEE_QUOTE_TOKEN: u8 = 0;
const DBC_MIGRATION_CREATED_POOL: u8 = 3;
const SWAP_MODE_EXACT_IN: u8 = 0;

#[program]
pub mod fomocity {
    use super::*;

    /// Binds the game to a token that was launched on DBC with the treasury PDA as both
    /// fee claimer and pool creator. Launch order (see scripts/launch.ts):
    /// pre-generate the mint keypair → derive game + treasury → create DBC config with
    /// fee_claimer = treasury → create pool → transfer_pool_creator(treasury) → initialize.
    pub fn initialize(ctx: Context<Initialize>, params: Params, buyback: BuybackConfig) -> Result<()> {
        let treasury = ctx.accounts.treasury.key();
        check_pool(&ctx.accounts)?;
        {
            let pool = ctx.accounts.dbc_pool.load()?;
            require_keys_eq!(pool.pool_state.creator, treasury, FomoError::TreasuryNotCreator);
            let cfg = ctx.accounts.dbc_config.load()?;
            require_keys_eq!(cfg.fee_claimer, treasury, FomoError::TreasuryNotFeeClaimer);
            require!(cfg.collect_fee_mode == DBC_COLLECT_FEE_QUOTE_TOKEN, FomoError::WrongPool);
        }
        init_game(ctx, params, buyback, false)
    }

    /// Attach the game to a token someone else already launched on Meteora DBC. The pool's
    /// fees don't go to the game, so the `harvest_*` instructions won't work; the jackpot is
    /// funded with `fund_sol` (bought back by the keeper, 70/20/10) and `fund_jackpot`.
    pub fn initialize_external(ctx: Context<Initialize>, params: Params, buyback: BuybackConfig) -> Result<()> {
        check_pool(&ctx.accounts)?;
        init_game(ctx, params, buyback, true)
    }

    /// Anyone: add FOMO straight to the jackpot. Goes to the current round while its
    /// countdown is running, otherwise to the next round's seed.
    pub fn fund_jackpot(ctx: Context<FundJackpot>, amount: u64) -> Result<()> {
        require!(amount > 0, FomoError::BadParams);
        let now = Clock::get()?.unix_timestamp;
        let round = &mut ctx.accounts.round;
        let live = !round.settled && now < round.end_ts;
        if live {
            round.jackpot = round.jackpot.checked_add(amount).ok_or(FomoError::Overflow)?;
        } else {
            round.next_round_pot = round.next_round_pot.checked_add(amount).ok_or(FomoError::Overflow)?;
        }
        token_interface::transfer_checked(
            CpiContext::new(ctx.accounts.token_program.key(), TransferChecked {
                from: ctx.accounts.funder_token_account.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.funder.to_account_info(),
            }),
            amount,
            ctx.accounts.mint.decimals,
        )?;
        emit!(JackpotFunded { round: round.id, funder: ctx.accounts.funder.key(), tokens: amount, lamports: 0, to_current_round: live });
        Ok(())
    }

    /// Anyone: send SOL to the game's buyback wallet. The keeper swaps it for FOMO on the
    /// token's pool and splits it like any buyback: 70% jackpot · 20% next round · 10% burned.
    pub fn fund_sol(ctx: Context<FundSol>, lamports: u64) -> Result<()> {
        require!(lamports > 0, FomoError::BadParams);
        anchor_lang::system_program::transfer(
            CpiContext::new(ctx.accounts.system_program.key(), anchor_lang::system_program::Transfer {
                from: ctx.accounts.funder.to_account_info(),
                to: ctx.accounts.wsol_vault.to_account_info(),
            }),
            lamports,
        )?;
        token_interface::sync_native(CpiContext::new(ctx.accounts.token_program.key(), token_interface::SyncNative {
            account: ctx.accounts.wsol_vault.to_account_info(),
        }))?;
        emit!(JackpotFunded { round: ctx.accounts.game.current_round, funder: ctx.accounts.funder.key(), tokens: 0, lamports, to_current_round: false });
        Ok(())
    }

    /// Keeper-only: report a qualifying FOMO buy seen on the game's Meteora pools. Buys must
    /// be reported in chain order, inside the round, and at least `min_buy_lamports`. Each one
    /// adds `time_add_per_buy` to the countdown, capped at `max_timer` after the buy.
    /// `sig` is the swap's transaction signature, kept in the event so anyone can audit it.
    pub fn record_buy(ctx: Context<RecordBuy>, wallet: Pubkey, lamports: u64, buy_ts: i64, sig: [u8; 64]) -> Result<()> {
        let p = ctx.accounts.game.params;
        let now = Clock::get()?.unix_timestamp;
        let round = &mut ctx.accounts.round;
        require!(!round.settled, FomoError::RoundOver);
        require!(lamports >= p.min_buy_lamports, FomoError::BuyTooSmall);
        require!(buy_ts >= round.start_ts, FomoError::BuyBeforeRound);
        require!(buy_ts < round.end_ts, FomoError::BuyAfterDeadline);
        require!(buy_ts >= round.last_buy_ts && buy_ts <= now, FomoError::BuyOutOfOrder);
        require!(sig != round.last_sig, FomoError::BuyOutOfOrder);

        round.end_ts = (round.end_ts + p.time_add_per_buy).min(buy_ts + p.max_timer);
        round.last_buyer = wallet;
        round.last_buy_ts = buy_ts;
        round.last_sig = sig;
        round.buy_count = round.buy_count.checked_add(1).ok_or(FomoError::Overflow)?;
        round.total_lamports = round.total_lamports.checked_add(lamports).ok_or(FomoError::Overflow)?;

        let game = &mut ctx.accounts.game;
        let i = game.recent_head as usize % RECENT_BUYS;
        game.recent[i] = RecentBuy { round: round.id, wallet, lamports, ts: buy_ts };
        game.recent_head = ((i + 1) % RECENT_BUYS) as u8;

        emit!(BuyRecorded { round: round.id, wallet, lamports, buy_ts, end_ts: round.end_ts, sig });
        Ok(())
    }

    /// Permissionless, once the countdown has run out plus `settle_grace_secs` (time for the
    /// keeper to report buys that landed just before zero). Pays the whole jackpot to the
    /// last buyer in this same instruction, records the winner, and opens the next round.
    /// A round with no buys carries its jackpot over.
    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let p = ctx.accounts.game.params;
        let round = &mut ctx.accounts.round;
        require!(!round.settled, FomoError::AlreadySettled);
        require!(now >= round.end_ts + p.settle_grace_secs, FomoError::TimerRunning);
        round.settled = true;

        let has_winner = round.buy_count > 0;
        require!(ctx.accounts.winner_token_account.is_some() == has_winner, FomoError::WinnerAccountMismatch);
        let carry = if has_winner { round.next_round_pot } else { round.jackpot + round.next_round_pot };
        let paid = if has_winner { round.jackpot } else { 0 };
        if has_winner {
            if paid > 0 {
                pay_from_vault(
                    &ctx.accounts.game,
                    &ctx.accounts.vault,
                    &ctx.accounts.mint,
                    ctx.accounts.winner_token_account.as_ref().unwrap(),
                    &ctx.accounts.token_program,
                    paid,
                )?;
            }
            round.jackpot_paid = true;
            let game = &mut ctx.accounts.game;
            let i = game.winners_head as usize % WINNERS_KEPT;
            game.winners[i] = Winner { round: round.id, wallet: round.last_buyer, amount: paid, ts: now };
            game.winners_head = ((i + 1) % WINNERS_KEPT) as u8;
        } else {
            round.jackpot = 0;
        }

        let game = &mut ctx.accounts.game;
        game.current_round += 1;
        let p = game.params;
        ctx.accounts.next_round.open(game.current_round, now, &p, carry, ctx.bumps.next_round);
        emit!(Settled { round: round.id, winner: if has_winner { round.last_buyer } else { Pubkey::default() }, jackpot: paid, carry });
        Ok(())
    }

    // ---------- Meteora fee flywheel ----------

    /// Permissionless: claim the treasury's partner + creator trading fees from the DBC
    /// pool. Fees are collected in SOL (QuoteToken mode) into the treasury's WSOL account.
    pub fn harvest_dbc(ctx: Context<HarvestDbc>) -> Result<()> {
        let a = &ctx.accounts;
        let before = a.wsol_vault.amount;
        let game_key = a.game.key();
        let seeds: &[&[u8]] = &[b"treasury", game_key.as_ref(), &[a.game.treasury_bump]];
        let dbc = dynamic_bonding_curve::ID;

        dynamic_bonding_curve::cpi::claim_trading_fee(
            CpiContext::new_with_signer(dbc, dynamic_bonding_curve::cpi::accounts::ClaimTradingFee {
                pool_authority: a.pool_authority.to_account_info(),
                config: a.dbc_config.to_account_info(),
                pool: a.dbc_pool.to_account_info(),
                token_a_account: a.stash.to_account_info(),
                token_b_account: a.wsol_vault.to_account_info(),
                base_vault: a.base_vault.to_account_info(),
                quote_vault: a.quote_vault.to_account_info(),
                base_mint: a.mint.to_account_info(),
                quote_mint: a.quote_mint.to_account_info(),
                fee_claimer: a.treasury.to_account_info(),
                token_base_program: a.token_program.to_account_info(),
                token_quote_program: a.token_program.to_account_info(),
                event_authority: a.event_authority.to_account_info(),
                program: a.dbc_program.to_account_info(),
            }, &[seeds]),
            u64::MAX,
            u64::MAX,
        )?;
        dynamic_bonding_curve::cpi::claim_creator_trading_fee(
            CpiContext::new_with_signer(dbc, dynamic_bonding_curve::cpi::accounts::ClaimCreatorTradingFee {
                pool_authority: a.pool_authority.to_account_info(),
                pool: a.dbc_pool.to_account_info(),
                token_a_account: a.stash.to_account_info(),
                token_b_account: a.wsol_vault.to_account_info(),
                base_vault: a.base_vault.to_account_info(),
                quote_vault: a.quote_vault.to_account_info(),
                base_mint: a.mint.to_account_info(),
                quote_mint: a.quote_mint.to_account_info(),
                creator: a.treasury.to_account_info(),
                token_base_program: a.token_program.to_account_info(),
                token_quote_program: a.token_program.to_account_info(),
                event_authority: a.event_authority.to_account_info(),
                program: a.dbc_program.to_account_info(),
            }, &[seeds]),
            u64::MAX,
            u64::MAX,
        )?;

        ctx.accounts.wsol_vault.reload()?;
        let got = ctx.accounts.wsol_vault.amount - before;
        record_harvest(&mut ctx.accounts.game, Venue::Dbc, got)
    }

    /// Permissionless, once the curve has completed: claim the partner and creator share
    /// of the surplus SOL left over from the final buy. Each side can only claim once.
    pub fn harvest_dbc_surplus(ctx: Context<HarvestDbcSurplus>) -> Result<()> {
        let a = &ctx.accounts;
        let before = a.wsol_vault.amount;
        let (partner_done, creator_done) = {
            let s = a.dbc_pool.load()?.pool_state;
            (s.is_partner_withdraw_surplus != 0, s.is_creator_withdraw_surplus != 0)
        };
        let game_key = a.game.key();
        let seeds: &[&[u8]] = &[b"treasury", game_key.as_ref(), &[a.game.treasury_bump]];
        let dbc = dynamic_bonding_curve::ID;

        if !partner_done {
            dynamic_bonding_curve::cpi::partner_withdraw_surplus(CpiContext::new_with_signer(
                dbc,
                dynamic_bonding_curve::cpi::accounts::PartnerWithdrawSurplus {
                    pool_authority: a.pool_authority.to_account_info(),
                    config: a.dbc_config.to_account_info(),
                    virtual_pool: a.dbc_pool.to_account_info(),
                    token_quote_account: a.wsol_vault.to_account_info(),
                    quote_vault: a.quote_vault.to_account_info(),
                    quote_mint: a.quote_mint.to_account_info(),
                    fee_claimer: a.treasury.to_account_info(),
                    token_quote_program: a.token_program.to_account_info(),
                    event_authority: a.event_authority.to_account_info(),
                    program: a.dbc_program.to_account_info(),
                },
                &[seeds],
            ))?;
        }
        if !creator_done {
            dynamic_bonding_curve::cpi::creator_withdraw_surplus(CpiContext::new_with_signer(
                dbc,
                dynamic_bonding_curve::cpi::accounts::CreatorWithdrawSurplus {
                    pool_authority: a.pool_authority.to_account_info(),
                    config: a.dbc_config.to_account_info(),
                    virtual_pool: a.dbc_pool.to_account_info(),
                    token_quote_account: a.wsol_vault.to_account_info(),
                    quote_vault: a.quote_vault.to_account_info(),
                    quote_mint: a.quote_mint.to_account_info(),
                    creator: a.treasury.to_account_info(),
                    token_quote_program: a.token_program.to_account_info(),
                    event_authority: a.event_authority.to_account_info(),
                    program: a.dbc_program.to_account_info(),
                },
                &[seeds],
            ))?;
        }

        ctx.accounts.wsol_vault.reload()?;
        let got = ctx.accounts.wsol_vault.amount - before;
        record_harvest(&mut ctx.accounts.game, Venue::Dbc, got)
    }

    /// Permissionless, after migration: claim fees from one of the treasury's locked
    /// DAMM v2 LP positions. DAMM checks that the treasury owns the position NFT.
    pub fn harvest_damm(ctx: Context<HarvestDamm>) -> Result<()> {
        let a = &ctx.accounts;
        let before = a.wsol_vault.amount;
        let game_key = a.game.key();
        let seeds: &[&[u8]] = &[b"treasury", game_key.as_ref(), &[a.game.treasury_bump]];

        cp_amm::cpi::claim_position_fee(CpiContext::new_with_signer(
            cp_amm::ID,
            cp_amm::cpi::accounts::ClaimPositionFee {
                pool_authority: a.pool_authority.to_account_info(),
                pool: a.damm_pool.to_account_info(),
                position: a.position.to_account_info(),
                token_a_account: a.stash.to_account_info(),
                token_b_account: a.wsol_vault.to_account_info(),
                token_a_vault: a.token_a_vault.to_account_info(),
                token_b_vault: a.token_b_vault.to_account_info(),
                token_a_mint: a.mint.to_account_info(),
                token_b_mint: a.quote_mint.to_account_info(),
                position_nft_account: a.position_nft_account.to_account_info(),
                signer: a.treasury.to_account_info(),
                token_a_program: a.token_program.to_account_info(),
                token_b_program: a.token_program.to_account_info(),
                event_authority: a.event_authority.to_account_info(),
                program: a.damm_program.to_account_info(),
            },
            &[seeds],
        ))?;

        ctx.accounts.wsol_vault.reload()?;
        let got = ctx.accounts.wsol_vault.amount - before;
        record_harvest(&mut ctx.accounts.game, Venue::Damm, got)
    }

    /// Keeper-only: swap up to `buyback.max_lamports` of harvested SOL for the game token
    /// on the bonding curve. `min_out` comes from an off-chain quote; together with the
    /// size cap and the cooldown it bounds what a sandwich attack can extract.
    pub fn buyback_dbc(mut ctx: Context<BuybackDbc>, amount_in: u64, min_out: u64) -> Result<()> {
        check_buyback(&ctx.accounts.game, &ctx.accounts.wsol_vault, amount_in, min_out)?;
        let a = &ctx.accounts;
        let before = a.stash.amount;
        let game_key = a.game.key();
        let seeds: &[&[u8]] = &[b"treasury", game_key.as_ref(), &[a.game.treasury_bump]];

        dynamic_bonding_curve::cpi::swap2(
            CpiContext::new_with_signer(dynamic_bonding_curve::ID, dynamic_bonding_curve::cpi::accounts::Swap2 {
                pool_authority: a.pool_authority.to_account_info(),
                config: a.dbc_config.to_account_info(),
                pool: a.dbc_pool.to_account_info(),
                input_token_account: a.wsol_vault.to_account_info(),
                output_token_account: a.stash.to_account_info(),
                base_vault: a.base_vault.to_account_info(),
                quote_vault: a.quote_vault.to_account_info(),
                base_mint: a.mint.to_account_info(),
                quote_mint: a.quote_mint.to_account_info(),
                payer: a.treasury.to_account_info(),
                token_base_program: a.token_program.to_account_info(),
                token_quote_program: a.token_program.to_account_info(),
                referral_token_account: None,
                event_authority: a.event_authority.to_account_info(),
                program: a.dbc_program.to_account_info(),
            }, &[seeds]),
            dynamic_bonding_curve::types::SwapParameters2 { amount_0: amount_in, amount_1: min_out, swap_mode: SWAP_MODE_EXACT_IN },
        )?;

        let accs = &mut ctx.accounts;
        accs.stash.reload()?;
        require!(accs.stash.amount - before >= min_out, FomoError::SlippageExceeded);
        distribute_buyback(&mut accs.game, &mut accs.round, &accs.stash, &accs.vault, &accs.mint, &accs.treasury, &accs.token_program, amount_in, Venue::Dbc)
    }

    /// Keeper-only: same as `buyback_dbc`, against the migrated DAMM v2 pool.
    pub fn buyback_damm(mut ctx: Context<BuybackDamm>, amount_in: u64, min_out: u64) -> Result<()> {
        check_buyback(&ctx.accounts.game, &ctx.accounts.wsol_vault, amount_in, min_out)?;
        let a = &ctx.accounts;
        let before = a.stash.amount;
        let game_key = a.game.key();
        let seeds: &[&[u8]] = &[b"treasury", game_key.as_ref(), &[a.game.treasury_bump]];

        cp_amm::cpi::swap2(
            CpiContext::new_with_signer(cp_amm::ID, cp_amm::cpi::accounts::Swap2 {
                pool_authority: a.pool_authority.to_account_info(),
                pool: a.damm_pool.to_account_info(),
                input_token_account: a.wsol_vault.to_account_info(),
                output_token_account: a.stash.to_account_info(),
                token_a_vault: a.token_a_vault.to_account_info(),
                token_b_vault: a.token_b_vault.to_account_info(),
                token_a_mint: a.mint.to_account_info(),
                token_b_mint: a.quote_mint.to_account_info(),
                payer: a.treasury.to_account_info(),
                token_a_program: a.token_program.to_account_info(),
                token_b_program: a.token_program.to_account_info(),
                referral_token_account: None,
                event_authority: a.event_authority.to_account_info(),
                program: a.damm_program.to_account_info(),
            }, &[seeds]),
            cp_amm::types::SwapParameters2 { amount_0: amount_in, amount_1: min_out, swap_mode: SWAP_MODE_EXACT_IN },
        )?;

        let accs = &mut ctx.accounts;
        accs.stash.reload()?;
        require!(accs.stash.amount - before >= min_out, FomoError::SlippageExceeded);
        distribute_buyback(&mut accs.game, &mut accs.round, &accs.stash, &accs.vault, &accs.mint, &accs.treasury, &accs.token_program, amount_in, Venue::Damm)
    }

    // ---------- admin ----------

    /// Hand admin rights to another key (e.g. a multisig). Passing `Pubkey::default()`
    /// renounces them for good: nobody can sign as it, so keeper and buyback limits freeze.
    pub fn set_authority(ctx: Context<Admin>, new_authority: Pubkey) -> Result<()> {
        ctx.accounts.game.authority = new_authority;
        emit!(AuthorityChanged { authority: new_authority });
        Ok(())
    }

    pub fn set_keeper(ctx: Context<Admin>, keeper: Pubkey) -> Result<()> {
        ctx.accounts.game.buyback.keeper = keeper;
        Ok(())
    }

    pub fn set_buyback_limits(ctx: Context<Admin>, max_lamports: u64, min_gap_secs: i64) -> Result<()> {
        require!(max_lamports > 0 && min_gap_secs >= 0, FomoError::BadParams);
        let b = &mut ctx.accounts.game.buyback;
        b.max_lamports = max_lamports;
        b.min_gap_secs = min_gap_secs;
        Ok(())
    }

    /// Fix the DAMM v2 config if the migration used a different one than expected.
    /// Only allowed before the DBC pool has migrated, so it can't redirect live buybacks.
    pub fn set_damm_config(ctx: Context<SetDammConfig>, damm_config: Pubkey) -> Result<()> {
        let progress = ctx.accounts.dbc_pool.load()?.pool_state.migration_progress;
        require!(progress < DBC_MIGRATION_CREATED_POOL, FomoError::AlreadyMigrated);
        let game = &mut ctx.accounts.game;
        game.buyback.damm_config = damm_config;
        game.damm_pool = damm_pool_address(&damm_config, &game.mint);
        Ok(())
    }
}

/// Shared by both initializers: sane params, a plain SPL mint, and a SOL-paired DBC pool
/// for exactly this mint.
fn check_pool(a: &Initialize) -> Result<()> {
    // Plain mints only: Token-2022 extensions like transfer fees or hooks would make the
    // vault receive less than we account for and drain later winners.
    require!(a.mint.to_account_info().data_len() == 82, FomoError::UnsupportedMint);
    let pool = a.dbc_pool.load()?;
    let s = &pool.pool_state;
    require_keys_eq!(s.base_mint, a.mint.key(), FomoError::WrongPool);
    require_keys_eq!(s.config, a.dbc_config.key(), FomoError::WrongPool);
    let cfg = a.dbc_config.load()?;
    require_keys_eq!(cfg.quote_mint, WSOL_MINT, FomoError::WrongPool);
    Ok(())
}

fn init_game(ctx: Context<Initialize>, params: Params, buyback: BuybackConfig, external: bool) -> Result<()> {
    require!(params.min_buy_lamports > 0 && params.time_add_per_buy >= 0, FomoError::BadParams);
    require!(params.initial_timer > 0 && params.initial_timer <= params.max_timer, FomoError::BadParams);
    require!(params.settle_grace_secs >= 0, FomoError::BadParams);
    require!(buyback.max_lamports > 0 && buyback.min_gap_secs >= 0, FomoError::BadParams);

    let game = &mut ctx.accounts.game;
    game.authority = ctx.accounts.authority.key();
    game.mint = ctx.accounts.mint.key();
    game.params = params;
    game.current_round = 1;
    game.bump = ctx.bumps.game;
    game.vault_bump = ctx.bumps.vault;
    game.treasury_bump = ctx.bumps.treasury;
    game.dbc_pool = ctx.accounts.dbc_pool.key();
    game.dbc_config = ctx.accounts.dbc_config.key();
    game.damm_pool = damm_pool_address(&buyback.damm_config, &game.mint);
    game.buyback = buyback;
    game.external = external;

    let now = Clock::get()?.unix_timestamp;
    ctx.accounts.round.open(1, now, &params, 0, ctx.bumps.round);
    Ok(())
}

fn bp(amount: u64, bps: u64) -> u64 {
    ((amount as u128) * (bps as u128) / (BPS as u128)) as u64
}

/// Buyback output split: (to_jackpot, to_next_round, burned). Mirrors game.js `splitBuyback`.
pub fn split_buyback(out: u64) -> (u64, u64, u64) {
    let to_next = bp(out, BUYBACK_NEXT_ROUND);
    let burn = bp(out, BUYBACK_BURN);
    (out - to_next - burn, to_next, burn)
}

/// Same PDA DAMM v2 uses: ["pool", config, larger mint, smaller mint].
fn damm_pool_address(config: &Pubkey, mint: &Pubkey) -> Pubkey {
    let (hi, lo) = if mint.to_bytes() > WSOL_MINT.to_bytes() { (mint, &WSOL_MINT) } else { (&WSOL_MINT, mint) };
    Pubkey::find_program_address(&[b"pool", config.as_ref(), hi.as_ref(), lo.as_ref()], &cp_amm::ID).0
}

fn record_harvest(game: &mut Account<Game>, venue: Venue, amount: u64) -> Result<()> {
    game.stats.harvested_lamports = game.stats.harvested_lamports.checked_add(amount).ok_or(FomoError::Overflow)?;
    emit!(Harvested { venue, lamports: amount });
    Ok(())
}

fn check_buyback(game: &Account<Game>, wsol: &InterfaceAccount<TokenAccount>, amount_in: u64, min_out: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let b = &game.buyback;
    require!(amount_in > 0 && amount_in <= b.max_lamports && amount_in <= wsol.amount, FomoError::BadBuybackSize);
    require!(min_out > 0, FomoError::SlippageExceeded);
    require!(now >= game.stats.last_buyback_ts + b.min_gap_secs, FomoError::BuybackCooldown);
    Ok(())
}

/// Splits everything in the stash (the swap output plus any stray base-token fees):
/// 70% to the live round's jackpot, 20% to its next-round seed, 10% burned. If the round
/// has expired but not been settled, the 90% all goes to the next-round seed instead, so
/// a buyback can't top up a jackpot whose winner is already decided.
#[allow(clippy::too_many_arguments)]
fn distribute_buyback<'info>(
    game: &mut Account<'info, Game>,
    round: &mut Account<'info, Round>,
    stash: &InterfaceAccount<'info, TokenAccount>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    treasury: &UncheckedAccount<'info>,
    token_program: &Interface<'info, TokenInterface>,
    lamports_in: u64,
    venue: Venue,
) -> Result<()> {
    let out = stash.amount;
    let (mut to_jackpot, mut to_next, burn) = split_buyback(out);
    let now = Clock::get()?.unix_timestamp;
    if round.settled || now >= round.end_ts {
        to_next += to_jackpot;
        to_jackpot = 0;
    }
    round.jackpot = round.jackpot.checked_add(to_jackpot).ok_or(FomoError::Overflow)?;
    round.next_round_pot = round.next_round_pot.checked_add(to_next).ok_or(FomoError::Overflow)?;

    let game_key = game.key();
    let seeds: &[&[u8]] = &[b"treasury", game_key.as_ref(), &[game.treasury_bump]];
    let prog = token_program.key();
    token_interface::transfer_checked(
        CpiContext::new_with_signer(prog, TransferChecked {
            from: stash.to_account_info(),
            mint: mint.to_account_info(),
            to: vault.to_account_info(),
            authority: treasury.to_account_info(),
        }, &[seeds]),
        to_jackpot + to_next,
        mint.decimals,
    )?;
    if burn > 0 {
        token_interface::burn(
            CpiContext::new_with_signer(prog, Burn {
                mint: mint.to_account_info(),
                from: stash.to_account_info(),
                authority: treasury.to_account_info(),
            }, &[seeds]),
            burn,
        )?;
    }

    let s = &mut game.stats;
    s.last_buyback_ts = now;
    s.spent_lamports = s.spent_lamports.checked_add(lamports_in).ok_or(FomoError::Overflow)?;
    s.bought_tokens = s.bought_tokens.checked_add(out).ok_or(FomoError::Overflow)?;
    s.burned_tokens = s.burned_tokens.checked_add(burn).ok_or(FomoError::Overflow)?;
    emit!(BoughtBack { round: round.id, venue, lamports_in, tokens_out: out, to_jackpot, to_next, burned: burn });
    Ok(())
}

fn pay_from_vault<'info>(
    game: &Account<'info, Game>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    to: &InterfaceAccount<'info, TokenAccount>,
    token_program: &Interface<'info, TokenInterface>,
    amount: u64,
) -> Result<()> {
    let seeds: &[&[u8]] = &[b"game", game.mint.as_ref(), &[game.bump]];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            token_program.key(),
            TransferChecked {
                from: vault.to_account_info(),
                mint: mint.to_account_info(),
                to: to.to_account_info(),
                authority: game.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        mint.decimals,
    )
}

// ---------- state ----------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace)]
pub struct Params {
    /// Smallest buy (SOL into the pool, in lamports) that counts.
    pub min_buy_lamports: u64,
    /// Seconds each counted buy adds to the countdown.
    pub time_add_per_buy: i64,
    /// The countdown never exceeds this many seconds after the latest buy.
    pub max_timer: i64,
    /// Countdown when a round opens.
    pub initial_timer: i64,
    /// Seconds after zero before anyone can settle, so late-reported buys still count.
    pub settle_grace_secs: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace)]
pub struct BuybackConfig {
    /// The only key allowed to call `buyback_*` (it supplies the `min_out` quote).
    pub keeper: Pubkey,
    /// Max SOL (lamports) per buyback call.
    pub max_lamports: u64,
    /// Minimum seconds between buybacks.
    pub min_gap_secs: i64,
    /// DAMM v2 config the DBC pool migrates into; determines the DAMM pool address.
    pub damm_config: Pubkey,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct FlywheelStats {
    pub harvested_lamports: u64,
    pub spent_lamports: u64,
    pub bought_tokens: u64,
    pub burned_tokens: u64,
    pub last_buyback_ts: i64,
}

#[account]
#[derive(InitSpace)]
pub struct Game {
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub params: Params,
    pub current_round: u64,
    pub dbc_pool: Pubkey,
    pub dbc_config: Pubkey,
    pub damm_pool: Pubkey,
    pub buyback: BuybackConfig,
    pub stats: FlywheelStats,
    /// True when attached to a token launched elsewhere (no fee income; funded by
    /// fund_sol / fund_jackpot instead of harvests).
    pub external: bool,
    /// Ring buffers for the website: latest counted buys and latest winners.
    pub recent: [RecentBuy; RECENT_BUYS],
    pub recent_head: u8,
    pub winners: [Winner; WINNERS_KEPT],
    pub winners_head: u8,
    pub bump: u8,
    pub vault_bump: u8,
    pub treasury_bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct RecentBuy {
    pub round: u64,
    pub wallet: Pubkey,
    pub lamports: u64,
    pub ts: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct Winner {
    pub round: u64,
    pub wallet: Pubkey,
    /// Jackpot paid, in token base units.
    pub amount: u64,
    pub ts: i64,
}

#[account]
#[derive(InitSpace)]
pub struct Round {
    pub id: u64,
    pub start_ts: i64,
    pub end_ts: i64,
    pub buy_count: u32,
    /// Total SOL (lamports) of counted buys this round.
    pub total_lamports: u64,
    pub jackpot: u64,
    pub next_round_pot: u64,
    pub last_buyer: Pubkey,
    pub last_buy_ts: i64,
    pub last_sig: [u8; 64],
    pub settled: bool,
    pub jackpot_paid: bool,
    pub bump: u8,
}

impl Round {
    fn open(&mut self, id: u64, now: i64, p: &Params, seed: u64, bump: u8) {
        self.id = id;
        self.start_ts = now;
        self.end_ts = now + p.initial_timer;
        self.jackpot = seed;
        self.bump = bump;
    }
}

// ---------- accounts ----------

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = WSOL_MINT, mint::token_program = token_program)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(init, payer = authority, space = 8 + Game::INIT_SPACE, seeds = [b"game", mint.key().as_ref()], bump)]
    pub game: Box<Account<'info, Game>>,
    /// CHECK: data-less PDA that signs Meteora claims/swaps and owns the WSOL + stash accounts.
    #[account(seeds = [b"treasury", game.key().as_ref()], bump)]
    pub treasury: UncheckedAccount<'info>,
    #[account(
        init, payer = authority, seeds = [b"vault", mint.key().as_ref()], bump,
        token::mint = mint, token::authority = game, token::token_program = token_program,
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Harvested SOL fees waiting to be spent on buybacks.
    #[account(
        init, payer = authority, seeds = [b"wsol", game.key().as_ref()], bump,
        token::mint = quote_mint, token::authority = treasury, token::token_program = token_program,
    )]
    pub wsol_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Buyback output lands here before it is split.
    #[account(
        init, payer = authority, seeds = [b"stash", game.key().as_ref()], bump,
        token::mint = mint, token::authority = treasury, token::token_program = token_program,
    )]
    pub stash: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(init, payer = authority, space = 8 + Round::INIT_SPACE, seeds = [b"round", game.key().as_ref(), &1u64.to_le_bytes()], bump)]
    pub round: Box<Account<'info, Round>>,
    pub dbc_pool: AccountLoader<'info, DbcPool>,
    pub dbc_config: AccountLoader<'info, DbcConfig>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RecordBuy<'info> {
    #[account(address = game.buyback.keeper @ FomoError::NotKeeper)]
    pub keeper: Signer<'info>,
    #[account(mut)]
    pub game: Box<Account<'info, Game>>,
    #[account(mut, seeds = [b"round", game.key().as_ref(), &game.current_round.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(mut, has_one = mint)]
    pub game: Box<Account<'info, Game>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, seeds = [b"round", game.key().as_ref(), &game.current_round.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(
        init, payer = cranker, space = 8 + Round::INIT_SPACE,
        seeds = [b"round", game.key().as_ref(), &(game.current_round + 1).to_le_bytes()], bump,
    )]
    pub next_round: Box<Account<'info, Round>>,
    #[account(mut, seeds = [b"vault", mint.key().as_ref()], bump = game.vault_bump)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// The last buyer's token account; required exactly when the round has a winner.
    /// Funds can only ever go to an account owned by the last buyer.
    #[account(mut, token::mint = mint, token::authority = round.last_buyer, token::token_program = token_program)]
    pub winner_token_account: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FundJackpot<'info> {
    pub funder: Signer<'info>,
    #[account(has_one = mint)]
    pub game: Box<Account<'info, Game>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, seeds = [b"round", game.key().as_ref(), &game.current_round.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(mut, token::mint = mint, token::authority = funder, token::token_program = token_program)]
    pub funder_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [b"vault", mint.key().as_ref()], bump = game.vault_bump)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct FundSol<'info> {
    #[account(mut)]
    pub funder: Signer<'info>,
    pub game: Box<Account<'info, Game>>,
    #[account(mut, seeds = [b"wsol", game.key().as_ref()], bump)]
    pub wsol_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Accounts shared by every DBC call. Pool and config are pinned to the ones recorded
/// at `initialize`; the vaults are checked by DBC itself against the pool.
#[derive(Accounts)]
pub struct HarvestDbc<'info> {
    #[account(mut, has_one = mint, has_one = dbc_pool, has_one = dbc_config)]
    pub game: Box<Account<'info, Game>>,
    /// CHECK: PDA signer, verified by seeds.
    #[account(seeds = [b"treasury", game.key().as_ref()], bump = game.treasury_bump)]
    pub treasury: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"wsol", game.key().as_ref()], bump)]
    pub wsol_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [b"stash", game.key().as_ref()], bump)]
    pub stash: Box<InterfaceAccount<'info, TokenAccount>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = WSOL_MINT)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: pinned via game.dbc_pool.
    #[account(mut)]
    pub dbc_pool: UncheckedAccount<'info>,
    /// CHECK: pinned via game.dbc_config.
    pub dbc_config: UncheckedAccount<'info>,
    /// CHECK: validated by DBC.
    #[account(mut)]
    pub base_vault: UncheckedAccount<'info>,
    /// CHECK: validated by DBC.
    #[account(mut)]
    pub quote_vault: UncheckedAccount<'info>,
    /// CHECK: validated by DBC (fixed address).
    pub pool_authority: UncheckedAccount<'info>,
    /// CHECK: validated by DBC (event CPI PDA).
    pub event_authority: UncheckedAccount<'info>,
    pub dbc_program: Program<'info, dynamic_bonding_curve::program::DynamicBondingCurve>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct HarvestDbcSurplus<'info> {
    #[account(mut, has_one = dbc_pool, has_one = dbc_config)]
    pub game: Box<Account<'info, Game>>,
    /// CHECK: PDA signer, verified by seeds.
    #[account(seeds = [b"treasury", game.key().as_ref()], bump = game.treasury_bump)]
    pub treasury: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"wsol", game.key().as_ref()], bump)]
    pub wsol_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = WSOL_MINT)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub dbc_pool: AccountLoader<'info, DbcPool>,
    /// CHECK: pinned via game.dbc_config.
    pub dbc_config: UncheckedAccount<'info>,
    /// CHECK: validated by DBC.
    #[account(mut)]
    pub quote_vault: UncheckedAccount<'info>,
    /// CHECK: validated by DBC (fixed address).
    pub pool_authority: UncheckedAccount<'info>,
    /// CHECK: validated by DBC (event CPI PDA).
    pub event_authority: UncheckedAccount<'info>,
    pub dbc_program: Program<'info, dynamic_bonding_curve::program::DynamicBondingCurve>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct HarvestDamm<'info> {
    #[account(mut, has_one = mint, has_one = damm_pool)]
    pub game: Box<Account<'info, Game>>,
    /// CHECK: PDA signer, verified by seeds.
    #[account(seeds = [b"treasury", game.key().as_ref()], bump = game.treasury_bump)]
    pub treasury: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"wsol", game.key().as_ref()], bump)]
    pub wsol_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [b"stash", game.key().as_ref()], bump)]
    pub stash: Box<InterfaceAccount<'info, TokenAccount>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = WSOL_MINT)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: pinned via game.damm_pool (derived from the DAMM config).
    pub damm_pool: UncheckedAccount<'info>,
    /// CHECK: validated by DAMM (must belong to damm_pool).
    #[account(mut)]
    pub position: UncheckedAccount<'info>,
    /// CHECK: validated by DAMM (must hold the position NFT, owned by treasury).
    pub position_nft_account: UncheckedAccount<'info>,
    /// CHECK: validated by DAMM.
    #[account(mut)]
    pub token_a_vault: UncheckedAccount<'info>,
    /// CHECK: validated by DAMM.
    #[account(mut)]
    pub token_b_vault: UncheckedAccount<'info>,
    /// CHECK: validated by DAMM (fixed address).
    pub pool_authority: UncheckedAccount<'info>,
    /// CHECK: validated by DAMM (event CPI PDA).
    pub event_authority: UncheckedAccount<'info>,
    pub damm_program: Program<'info, cp_amm::program::CpAmm>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct BuybackDbc<'info> {
    #[account(address = game.buyback.keeper @ FomoError::NotKeeper)]
    pub keeper: Signer<'info>,
    #[account(mut, has_one = mint, has_one = dbc_pool, has_one = dbc_config)]
    pub game: Box<Account<'info, Game>>,
    #[account(mut, seeds = [b"round", game.key().as_ref(), &game.current_round.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    /// CHECK: PDA signer, verified by seeds.
    #[account(seeds = [b"treasury", game.key().as_ref()], bump = game.treasury_bump)]
    pub treasury: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"wsol", game.key().as_ref()], bump)]
    pub wsol_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [b"stash", game.key().as_ref()], bump)]
    pub stash: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [b"vault", mint.key().as_ref()], bump = game.vault_bump)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = WSOL_MINT)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: pinned via game.dbc_pool.
    #[account(mut)]
    pub dbc_pool: UncheckedAccount<'info>,
    /// CHECK: pinned via game.dbc_config.
    pub dbc_config: UncheckedAccount<'info>,
    /// CHECK: validated by DBC.
    #[account(mut)]
    pub base_vault: UncheckedAccount<'info>,
    /// CHECK: validated by DBC.
    #[account(mut)]
    pub quote_vault: UncheckedAccount<'info>,
    /// CHECK: validated by DBC (fixed address).
    pub pool_authority: UncheckedAccount<'info>,
    /// CHECK: validated by DBC (event CPI PDA).
    pub event_authority: UncheckedAccount<'info>,
    pub dbc_program: Program<'info, dynamic_bonding_curve::program::DynamicBondingCurve>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct BuybackDamm<'info> {
    #[account(address = game.buyback.keeper @ FomoError::NotKeeper)]
    pub keeper: Signer<'info>,
    #[account(mut, has_one = mint, has_one = damm_pool)]
    pub game: Box<Account<'info, Game>>,
    #[account(mut, seeds = [b"round", game.key().as_ref(), &game.current_round.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    /// CHECK: PDA signer, verified by seeds.
    #[account(seeds = [b"treasury", game.key().as_ref()], bump = game.treasury_bump)]
    pub treasury: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"wsol", game.key().as_ref()], bump)]
    pub wsol_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [b"stash", game.key().as_ref()], bump)]
    pub stash: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [b"vault", mint.key().as_ref()], bump = game.vault_bump)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = WSOL_MINT)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: pinned via game.damm_pool; token order checked below.
    #[account(mut, constraint = damm_pool_mints_ok(&damm_pool, &mint.key()) @ FomoError::WrongPool)]
    pub damm_pool: UncheckedAccount<'info>,
    /// CHECK: validated by DAMM.
    #[account(mut)]
    pub token_a_vault: UncheckedAccount<'info>,
    /// CHECK: validated by DAMM.
    #[account(mut)]
    pub token_b_vault: UncheckedAccount<'info>,
    /// CHECK: validated by DAMM (fixed address).
    pub pool_authority: UncheckedAccount<'info>,
    /// CHECK: validated by DAMM (event CPI PDA).
    pub event_authority: UncheckedAccount<'info>,
    pub damm_program: Program<'info, cp_amm::program::CpAmm>,
    pub token_program: Interface<'info, TokenInterface>,
}

/// The CPI passes our token as token A and WSOL as token B; refuse a pool laid out the
/// other way round rather than swap in the wrong direction.
fn damm_pool_mints_ok(pool: &AccountInfo, mint: &Pubkey) -> bool {
    if pool.owner != &cp_amm::ID {
        return false;
    }
    let Ok(data) = pool.try_borrow_data() else { return false };
    let Ok(p) = DammPool::try_deserialize(&mut &data[..]) else { return false };
    p.token_a_mint == *mint && p.token_b_mint == WSOL_MINT
}

#[derive(Accounts)]
pub struct Admin<'info> {
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority)]
    pub game: Box<Account<'info, Game>>,
}

#[derive(Accounts)]
pub struct SetDammConfig<'info> {
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority, has_one = dbc_pool)]
    pub game: Box<Account<'info, Game>>,
    pub dbc_pool: AccountLoader<'info, DbcPool>,
}

// ---------- events & errors ----------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum Venue {
    Dbc,
    Damm,
}

#[event]
pub struct BuyRecorded { pub round: u64, pub wallet: Pubkey, pub lamports: u64, pub buy_ts: i64, pub end_ts: i64, pub sig: [u8; 64] }
#[event]
pub struct Settled { pub round: u64, pub winner: Pubkey, pub jackpot: u64, pub carry: u64 }
#[event]
pub struct AuthorityChanged { pub authority: Pubkey }
#[event]
pub struct JackpotFunded { pub round: u64, pub funder: Pubkey, pub tokens: u64, pub lamports: u64, pub to_current_round: bool }
#[event]
pub struct Harvested { pub venue: Venue, pub lamports: u64 }
#[event]
pub struct BoughtBack { pub round: u64, pub venue: Venue, pub lamports_in: u64, pub tokens_out: u64, pub to_jackpot: u64, pub to_next: u64, pub burned: u64 }

#[error_code]
pub enum FomoError {
    #[msg("Round is over")] RoundOver,
    #[msg("Buy is below the minimum that counts")] BuyTooSmall,
    #[msg("Buy happened before this round started")] BuyBeforeRound,
    #[msg("Buy happened after the countdown ran out")] BuyAfterDeadline,
    #[msg("Buys must be reported once each, in chain order")] BuyOutOfOrder,
    #[msg("Winner token account must be passed exactly when the round has a winner")] WinnerAccountMismatch,
    #[msg("Cost exceeds max_cost")] SlippageExceeded,
    #[msg("Arithmetic overflow")] Overflow,
    #[msg("Round already settled")] AlreadySettled,
    #[msg("Timer still running")] TimerRunning,
    #[msg("Invalid params")] BadParams,
    #[msg("Mint has Token-2022 extensions")] UnsupportedMint,
    #[msg("Pool or config does not belong to this game's token")] WrongPool,
    #[msg("Treasury PDA must be the DBC pool creator")] TreasuryNotCreator,
    #[msg("Treasury PDA must be the DBC config fee claimer")] TreasuryNotFeeClaimer,
    #[msg("Only the keeper can buy back")] NotKeeper,
    #[msg("Buyback amount out of range")] BadBuybackSize,
    #[msg("Buyback cooldown still running")] BuybackCooldown,
    #[msg("DBC pool already migrated")] AlreadyMigrated,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buyback_split_matches_js_engine() {
        // Same vectors as web/src/game.test.js
        assert_eq!(split_buyback(1_000_000), (700_000, 200_000, 100_000));
        assert_eq!(split_buyback(12_345_679), (8_641_977, 2_469_135, 1_234_567));
        assert_eq!(split_buyback(7), (6, 1, 0));
        for out in [1u64, 9, 10_001, 999_999_999_999] {
            let (j, n, b) = split_buyback(out);
            assert_eq!(j + n + b, out);
        }
    }

    #[test]
    fn damm_pool_pda_depends_on_config() {
        let cfg = Pubkey::new_unique();
        let m = Pubkey::new_unique();
        assert_eq!(damm_pool_address(&cfg, &m), damm_pool_address(&cfg, &m));
        assert_ne!(damm_pool_address(&cfg, &m), damm_pool_address(&Pubkey::new_unique(), &m));
    }
}
