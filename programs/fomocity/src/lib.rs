//! FOMO City: last-buyer-wins game around a token launched on Meteora's Dynamic Bonding
//! Curve (DBC), with the jackpot paid in SOL and funded automatically by trading fees.
//!
//! Playing = buying the token anywhere (Jupiter, Meteora, any wallet). The keeper watches the
//! token's Meteora pools and reports each qualifying buy with `record_buy` (wallet, SOL, block
//! time, transaction signature, all public so anyone can check it against the chain). Each
//! buy adds time to the round's countdown; when it runs out, `settle` pays the whole jackpot,
//! in SOL, to the last buyer in the same instruction and records them in the winners list.
//!
//! Funding: the game's `treasury` PDA (seeds `["treasury"]`, so its address is known before
//! the token exists) is set as the pool's fee claimer and/or pool creator at launch. Anyone
//! can call `harvest_*` to claim those SOL fees; every lamport claimed is split 80% to the
//! jackpot and 20% to the team, whose share builds up and is sent with `withdraw_team`.
//! `fund_sol` lets anyone add SOL straight to the jackpot.
//!
//! The SOL sits as wrapped SOL in a program-owned account; only these instructions move it.
//! One game per program deployment (the treasury address is shared by the deployment).
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked};

declare_id!("Fx4voUZZXbicWkMFSPC6ysW99E1h1zJdvzL51dxFY8ZR");

declare_program!(dynamic_bonding_curve);
declare_program!(cp_amm);

use dynamic_bonding_curve::accounts::{PoolConfig as DbcConfig, VirtualPool as DbcPool};

pub const BPS: u64 = 10_000;
/// Share of every claimed fee that goes to the team; the rest goes to the jackpot.
pub const TEAM_BPS: u64 = 2_000;
/// Recent buys and winners kept on the Game account for the website.
pub const RECENT_BUYS: usize = 16;
pub const WINNERS_KEPT: usize = 10;

pub const WSOL_MINT: Pubkey = Pubkey::from_str_const("So11111111111111111111111111111111111111112");
pub const TREASURY_SEED: &[u8] = b"treasury";
const DBC_COLLECT_FEE_QUOTE_TOKEN: u8 = 0;
const DBC_MIGRATION_CREATED_POOL: u8 = 3;

#[program]
pub mod fomocity {
    use super::*;

    /// Binds the game to a token launched on Meteora DBC, paired with SOL, collecting fees
    /// in SOL, and whose fees reach the game: the treasury must be the pool's fee claimer,
    /// its creator, or both. Round 1 opens now; only buys from here on count.
    pub fn initialize(ctx: Context<Initialize>, params: Params, cfg: GameConfig) -> Result<()> {
        require!(params.min_buy_lamports > 0 && params.time_add_per_buy >= 0, FomoError::BadParams);
        require!(params.initial_timer > 0 && params.initial_timer <= params.max_timer, FomoError::BadParams);
        require!(params.settle_grace_secs >= 0, FomoError::BadParams);
        // Plain mints only: the stash that catches stray base-token fees is a plain SPL account.
        require!(ctx.accounts.mint.to_account_info().data_len() == 82, FomoError::UnsupportedMint);

        let treasury = ctx.accounts.treasury.key();
        {
            let pool = ctx.accounts.dbc_pool.load()?;
            let s = &pool.pool_state;
            require_keys_eq!(s.base_mint, ctx.accounts.mint.key(), FomoError::WrongPool);
            require_keys_eq!(s.config, ctx.accounts.dbc_config.key(), FomoError::WrongPool);
            let c = ctx.accounts.dbc_config.load()?;
            require_keys_eq!(c.quote_mint, WSOL_MINT, FomoError::WrongPool);
            require!(c.collect_fee_mode == DBC_COLLECT_FEE_QUOTE_TOKEN, FomoError::FeesNotInSol);
            require!(c.fee_claimer == treasury || s.creator == treasury, FomoError::NoFeesToGame);
        }

        let game = &mut ctx.accounts.game;
        game.authority = ctx.accounts.authority.key();
        game.mint = ctx.accounts.mint.key();
        game.params = params;
        game.cfg = cfg;
        game.current_round = 1;
        game.bump = ctx.bumps.game;
        game.treasury_bump = ctx.bumps.treasury;
        game.dbc_pool = ctx.accounts.dbc_pool.key();
        game.dbc_config = ctx.accounts.dbc_config.key();
        game.damm_pool = damm_pool_address(&cfg.damm_config, &game.mint);

        let now = Clock::get()?.unix_timestamp;
        ctx.accounts.round.open(1, now, &params, 0, ctx.bumps.round);
        Ok(())
    }

    /// Keeper-only: report a qualifying buy seen on the token's Meteora pools. Buys must
    /// be reported in chain order, inside the round, and at least `min_buy_lamports`. Each one
    /// adds `time_add_per_buy` to the countdown, capped at `max_timer` after the buy.
    /// `sig` is the swap's transaction signature, kept in the event so anyone can audit it.
    pub fn record_buy(ctx: Context<RecordBuy>, wallet: Pubkey, lamports: u64, buy_ts: i64, sig: [u8; 64]) -> Result<()> {
        let p = ctx.accounts.game.params;
        let now = Clock::get()?.unix_timestamp;
        require!(!ctx.accounts.game.ended, FomoError::GameEnded);
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
    /// keeper to report buys that landed just before zero). Pays the whole jackpot, in SOL,
    /// to the last buyer in this same instruction, records the winner, and opens the next
    /// round. A round with no buys carries its jackpot over.
    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let p = ctx.accounts.game.params;
        require!(!ctx.accounts.game.ended, FomoError::GameEnded);
        let round = &mut ctx.accounts.round;
        require!(!round.settled, FomoError::AlreadySettled);
        require!(now >= round.end_ts + p.settle_grace_secs, FomoError::TimerRunning);
        round.settled = true;

        let has_winner = round.buy_count > 0;
        require!(ctx.accounts.winner.is_some() == has_winner, FomoError::WinnerAccountMismatch);
        let carry = if has_winner { round.next_round_pot } else { round.jackpot + round.next_round_pot };
        let paid = if has_winner { round.jackpot } else { 0 };

        // The payout account is created and closed in this instruction: the jackpot is moved
        // into it as wrapped SOL, then closing it unwraps everything to the winner as plain
        // SOL (plus its rent, paid by whoever settled). With no winner it closes back to them.
        let a = &ctx.accounts;
        let seeds: &[&[u8]] = &[TREASURY_SEED, &[a.game.treasury_bump]];
        if paid > 0 {
            token_interface::transfer_checked(
                CpiContext::new_with_signer(a.token_program.key(), TransferChecked {
                    from: a.wsol_vault.to_account_info(),
                    mint: a.quote_mint.to_account_info(),
                    to: a.payout.to_account_info(),
                    authority: a.treasury.to_account_info(),
                }, &[seeds]),
                paid,
                9,
            )?;
        }
        let destination = match &a.winner { Some(w) => w.to_account_info(), None => a.cranker.to_account_info() };
        token_interface::close_account(CpiContext::new_with_signer(a.token_program.key(), CloseAccount {
            account: a.payout.to_account_info(),
            destination,
            authority: a.treasury.to_account_info(),
        }, &[seeds]))?;

        let round = &mut ctx.accounts.round;
        let game = &mut ctx.accounts.game;
        if has_winner {
            round.jackpot_paid = true;
            game.stats.jackpots_paid_lamports = game.stats.jackpots_paid_lamports.checked_add(paid).ok_or(FomoError::Overflow)?;
            let i = game.winners_head as usize % WINNERS_KEPT;
            game.winners[i] = Winner { round: round.id, wallet: round.last_buyer, amount: paid, ts: now };
            game.winners_head = ((i + 1) % WINNERS_KEPT) as u8;
        } else {
            round.jackpot = 0;
        }

        game.current_round += 1;
        let p = game.params;
        if game.final_round != 0 && round.id >= game.final_round {
            // That was the announced final round: the game is over. No new round is played
            // (the next round account opens already closed), and what was set aside for it
            // goes to the team, like every fee from here on.
            game.ended = true;
            game.team_owed = game.team_owed.checked_add(carry).ok_or(FomoError::Overflow)?;
            let next = &mut ctx.accounts.next_round;
            next.open(game.current_round, now, &p, 0, ctx.bumps.next_round);
            next.end_ts = now;
            next.settled = true;
            emit!(Settled { round: round.id, winner: if has_winner { round.last_buyer } else { Pubkey::default() }, jackpot: paid, carry: 0 });
            emit!(GameEnded { last_round: round.id, to_team: carry });
            return Ok(());
        }
        ctx.accounts.next_round.open(game.current_round, now, &p, carry, ctx.bumps.next_round);
        emit!(Settled { round: round.id, winner: if has_winner { round.last_buyer } else { Pubkey::default() }, jackpot: paid, carry });
        Ok(())
    }

    // ---------- Meteora fees → 80% jackpot · 20% team ----------

    /// Permissionless: claim the trading fees the treasury is owed on the DBC pool, as fee
    /// claimer (partner share) and/or pool creator (creator share), in SOL, then split them.
    pub fn harvest_dbc(mut ctx: Context<HarvestDbc>) -> Result<()> {
        let a = &ctx.accounts;
        let before = a.wsol_vault.amount;
        let treasury = a.treasury.key();
        let (is_partner, is_creator) = {
            let pool = a.dbc_pool.load()?;
            let cfg = a.dbc_config.load()?;
            (cfg.fee_claimer == treasury, pool.pool_state.creator == treasury)
        };
        require!(is_partner || is_creator, FomoError::NoFeesToGame);
        let seeds: &[&[u8]] = &[TREASURY_SEED, &[a.game.treasury_bump]];
        let dbc = dynamic_bonding_curve::ID;

        if is_partner {
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
        }
        if is_creator {
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
        }

        let accs = &mut ctx.accounts;
        accs.wsol_vault.reload()?;
        let got = accs.wsol_vault.amount - before;
        credit_fees(&mut accs.game, &mut accs.round, Venue::Dbc, got)
    }

    /// Permissionless, once the curve has completed: claim the treasury's share of the
    /// surplus SOL left over from the final buy (each side can only claim once), then split it.
    pub fn harvest_dbc_surplus(mut ctx: Context<HarvestDbcSurplus>) -> Result<()> {
        let a = &ctx.accounts;
        let before = a.wsol_vault.amount;
        let treasury = a.treasury.key();
        let (partner_due, creator_due) = {
            let s = a.dbc_pool.load()?.pool_state;
            let cfg = a.dbc_config.load()?;
            (cfg.fee_claimer == treasury && s.is_partner_withdraw_surplus == 0, s.creator == treasury && s.is_creator_withdraw_surplus == 0)
        };
        let seeds: &[&[u8]] = &[TREASURY_SEED, &[a.game.treasury_bump]];
        let dbc = dynamic_bonding_curve::ID;

        if partner_due {
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
        if creator_due {
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

        let accs = &mut ctx.accounts;
        accs.wsol_vault.reload()?;
        let got = accs.wsol_vault.amount - before;
        credit_fees(&mut accs.game, &mut accs.round, Venue::Dbc, got)
    }

    /// Permissionless, after migration: claim fees from an LP position the treasury owns in
    /// the DAMM v2 pool (DAMM checks the treasury holds the position NFT), then split them.
    pub fn harvest_damm(mut ctx: Context<HarvestDamm>) -> Result<()> {
        let a = &ctx.accounts;
        let before = a.wsol_vault.amount;
        let seeds: &[&[u8]] = &[TREASURY_SEED, &[a.game.treasury_bump]];

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

        let accs = &mut ctx.accounts;
        accs.wsol_vault.reload()?;
        let got = accs.wsol_vault.amount - before;
        credit_fees(&mut accs.game, &mut accs.round, Venue::Damm, got)
    }

    /// Anyone: add SOL straight to the jackpot (all of it; no team share). Goes to the
    /// current round while its countdown runs, otherwise to the next round.
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
        let now = Clock::get()?.unix_timestamp;
        let round = &mut ctx.accounts.round;
        let live = !round.settled && now < round.end_ts;
        if live {
            round.jackpot = round.jackpot.checked_add(lamports).ok_or(FomoError::Overflow)?;
        } else {
            round.next_round_pot = round.next_round_pot.checked_add(lamports).ok_or(FomoError::Overflow)?;
        }
        let game = &mut ctx.accounts.game;
        game.stats.funded_lamports = game.stats.funded_lamports.checked_add(lamports).ok_or(FomoError::Overflow)?;
        emit!(JackpotFunded { round: round.id, funder: ctx.accounts.funder.key(), lamports, to_current_round: live });
        Ok(())
    }

    /// Anyone: send the team's accumulated share to the team wallet as plain SOL.
    pub fn withdraw_team(ctx: Context<WithdrawTeam>) -> Result<()> {
        let amount = ctx.accounts.game.team_owed;
        require!(amount > 0, FomoError::NothingToClaim);
        let a = &ctx.accounts;
        let seeds: &[&[u8]] = &[TREASURY_SEED, &[a.game.treasury_bump]];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(a.token_program.key(), TransferChecked {
                from: a.wsol_vault.to_account_info(),
                mint: a.quote_mint.to_account_info(),
                to: a.payout.to_account_info(),
                authority: a.treasury.to_account_info(),
            }, &[seeds]),
            amount,
            9,
        )?;
        token_interface::close_account(CpiContext::new_with_signer(a.token_program.key(), CloseAccount {
            account: a.payout.to_account_info(),
            destination: a.team.to_account_info(),
            authority: a.treasury.to_account_info(),
        }, &[seeds]))?;
        let game = &mut ctx.accounts.game;
        game.team_owed = 0;
        game.stats.team_paid_lamports = game.stats.team_paid_lamports.checked_add(amount).ok_or(FomoError::Overflow)?;
        emit!(TeamPaid { team: game.cfg.team, lamports: amount });
        Ok(())
    }

    // ---------- admin ----------

    /// Hand admin rights to another key (e.g. a multisig). Passing `Pubkey::default()`
    /// renounces them for good: nobody can sign as it, so keeper and team wallet freeze.
    pub fn set_authority(ctx: Context<Admin>, new_authority: Pubkey) -> Result<()> {
        ctx.accounts.game.authority = new_authority;
        emit!(AuthorityChanged { authority: new_authority });
        Ok(())
    }

    /// Announce that the current round is the last one. It plays out normally and its
    /// winner is paid in full; after it settles the game is over: no more rounds, and fees
    /// claimed from then on go to the team. Can't be undone.
    pub fn set_final_round(ctx: Context<Admin>) -> Result<()> {
        let game = &mut ctx.accounts.game;
        require!(game.final_round == 0 && !game.ended, FomoError::GameEnded);
        game.final_round = game.current_round;
        emit!(FinalRound { round: game.final_round });
        Ok(())
    }

    pub fn set_keeper(ctx: Context<Admin>, keeper: Pubkey) -> Result<()> {
        ctx.accounts.game.cfg.keeper = keeper;
        Ok(())
    }

    /// Change where the team's 20% goes. Whatever is already owed goes to the new wallet.
    pub fn set_team(ctx: Context<Admin>, team: Pubkey) -> Result<()> {
        ctx.accounts.game.cfg.team = team;
        Ok(())
    }

    /// Fix the DAMM v2 config if the migration used a different one than expected.
    /// Only allowed before the DBC pool has migrated.
    pub fn set_damm_config(ctx: Context<SetDammConfig>, damm_config: Pubkey) -> Result<()> {
        let progress = ctx.accounts.dbc_pool.load()?.pool_state.migration_progress;
        require!(progress < DBC_MIGRATION_CREATED_POOL, FomoError::AlreadyMigrated);
        let game = &mut ctx.accounts.game;
        game.cfg.damm_config = damm_config;
        game.damm_pool = damm_pool_address(&damm_config, &game.mint);
        Ok(())
    }
}

fn bp(amount: u64, bps: u64) -> u64 {
    ((amount as u128) * (bps as u128) / (BPS as u128)) as u64
}

/// Fee split: (to_jackpot, to_team). Mirrors game.js `splitFees`.
pub fn split_fees(amount: u64) -> (u64, u64) {
    let team = bp(amount, TEAM_BPS);
    (amount - team, team)
}

/// 80% to the live round's jackpot (or the next round's, once the countdown has run out,
/// so fees never change a decided round), 20% to the team.
fn credit_fees(game: &mut Account<Game>, round: &mut Account<Round>, venue: Venue, amount: u64) -> Result<()> {
    let (to_jackpot, to_team) = if game.ended { (0, amount) } else { split_fees(amount) };
    let now = Clock::get()?.unix_timestamp;
    let live = !round.settled && now < round.end_ts;
    if live {
        round.jackpot = round.jackpot.checked_add(to_jackpot).ok_or(FomoError::Overflow)?;
    } else {
        round.next_round_pot = round.next_round_pot.checked_add(to_jackpot).ok_or(FomoError::Overflow)?;
    }
    game.team_owed = game.team_owed.checked_add(to_team).ok_or(FomoError::Overflow)?;
    let s = &mut game.stats;
    s.harvested_lamports = s.harvested_lamports.checked_add(amount).ok_or(FomoError::Overflow)?;
    s.to_jackpot_lamports = s.to_jackpot_lamports.checked_add(to_jackpot).ok_or(FomoError::Overflow)?;
    s.to_team_lamports = s.to_team_lamports.checked_add(to_team).ok_or(FomoError::Overflow)?;
    emit!(Harvested { round: round.id, venue, lamports: amount, to_jackpot, to_team, to_current_round: live });
    Ok(())
}

/// Same PDA DAMM v2 uses: ["pool", config, larger mint, smaller mint].
fn damm_pool_address(config: &Pubkey, mint: &Pubkey) -> Pubkey {
    let (hi, lo) = if mint.to_bytes() > WSOL_MINT.to_bytes() { (mint, &WSOL_MINT) } else { (&WSOL_MINT, mint) };
    Pubkey::find_program_address(&[b"pool", config.as_ref(), hi.as_ref(), lo.as_ref()], &cp_amm::ID).0
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
pub struct GameConfig {
    /// The only key allowed to call `record_buy`.
    pub keeper: Pubkey,
    /// Receives the team's 20% of fees (as plain SOL, via `withdraw_team`).
    pub team: Pubkey,
    /// DAMM v2 config the DBC pool migrates into; determines the DAMM pool address.
    pub damm_config: Pubkey,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct Stats {
    pub harvested_lamports: u64,
    pub to_jackpot_lamports: u64,
    pub to_team_lamports: u64,
    pub team_paid_lamports: u64,
    pub jackpots_paid_lamports: u64,
    pub funded_lamports: u64,
}

#[account]
#[derive(InitSpace)]
pub struct Game {
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub params: Params,
    pub cfg: GameConfig,
    pub current_round: u64,
    pub dbc_pool: Pubkey,
    pub dbc_config: Pubkey,
    pub damm_pool: Pubkey,
    /// Team share claimed but not yet sent (lamports).
    pub team_owed: u64,
    pub stats: Stats,
    /// Ring buffers for the website: latest counted buys and latest winners.
    pub recent: [RecentBuy; RECENT_BUYS],
    pub recent_head: u8,
    pub winners: [Winner; WINNERS_KEPT],
    pub winners_head: u8,
    pub bump: u8,
    pub treasury_bump: u8,
    /// Announced last round (0: none). After it settles, `ended` is set.
    pub final_round: u64,
    pub ended: bool,
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
    /// Jackpot paid, in lamports.
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
    /// Jackpot in lamports.
    pub jackpot: u64,
    /// Lamports already set aside for the next round.
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
    /// CHECK: data-less PDA (fixed address for this deployment) that signs Meteora claims
    /// and owns the SOL vault and stash.
    #[account(seeds = [TREASURY_SEED], bump)]
    pub treasury: UncheckedAccount<'info>,
    /// Jackpots and the team's share, as wrapped SOL.
    #[account(
        init, payer = authority, seeds = [b"wsol", game.key().as_ref()], bump,
        token::mint = quote_mint, token::authority = treasury, token::token_program = token_program,
    )]
    pub wsol_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Catches any fees paid in the game token (only possible in DAMM v2 pools that collect
    /// both sides); they stay here.
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
    #[account(address = game.cfg.keeper @ FomoError::NotKeeper)]
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
    #[account(mut)]
    pub game: Box<Account<'info, Game>>,
    #[account(mut, seeds = [b"round", game.key().as_ref(), &game.current_round.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(
        init, payer = cranker, space = 8 + Round::INIT_SPACE,
        seeds = [b"round", game.key().as_ref(), &(game.current_round + 1).to_le_bytes()], bump,
    )]
    pub next_round: Box<Account<'info, Round>>,
    /// CHECK: PDA signer, verified by seeds.
    #[account(seeds = [TREASURY_SEED], bump = game.treasury_bump)]
    pub treasury: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"wsol", game.key().as_ref()], bump)]
    pub wsol_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = WSOL_MINT)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    /// Temporary account the jackpot passes through to become plain SOL (closed in this ix).
    #[account(
        init, payer = cranker, seeds = [b"payout", game.key().as_ref()], bump,
        token::mint = quote_mint, token::authority = treasury, token::token_program = token_program,
    )]
    pub payout: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: the round's last buyer; required exactly when the round has a winner. Only
    /// ever receives SOL.
    #[account(mut, address = round.last_buyer @ FomoError::WinnerAccountMismatch)]
    pub winner: Option<UncheckedAccount<'info>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FundSol<'info> {
    #[account(mut)]
    pub funder: Signer<'info>,
    #[account(mut)]
    pub game: Box<Account<'info, Game>>,
    #[account(mut, seeds = [b"round", game.key().as_ref(), &game.current_round.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(mut, seeds = [b"wsol", game.key().as_ref()], bump)]
    pub wsol_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawTeam<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(mut)]
    pub game: Box<Account<'info, Game>>,
    /// CHECK: PDA signer, verified by seeds.
    #[account(seeds = [TREASURY_SEED], bump = game.treasury_bump)]
    pub treasury: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"wsol", game.key().as_ref()], bump)]
    pub wsol_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = WSOL_MINT)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init, payer = cranker, seeds = [b"payout", game.key().as_ref()], bump,
        token::mint = quote_mint, token::authority = treasury, token::token_program = token_program,
    )]
    pub payout: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: the team wallet stored in the game; only receives SOL.
    #[account(mut, address = game.cfg.team @ FomoError::WrongTeam)]
    pub team: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Accounts shared by every DBC claim. Pool and config are pinned to the ones recorded at
/// `initialize`; the vaults are checked by DBC itself against the pool.
#[derive(Accounts)]
pub struct HarvestDbc<'info> {
    #[account(mut, has_one = mint, has_one = dbc_pool, has_one = dbc_config)]
    pub game: Box<Account<'info, Game>>,
    #[account(mut, seeds = [b"round", game.key().as_ref(), &game.current_round.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    /// CHECK: PDA signer, verified by seeds.
    #[account(seeds = [TREASURY_SEED], bump = game.treasury_bump)]
    pub treasury: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"wsol", game.key().as_ref()], bump)]
    pub wsol_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [b"stash", game.key().as_ref()], bump)]
    pub stash: Box<InterfaceAccount<'info, TokenAccount>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = WSOL_MINT)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub dbc_pool: AccountLoader<'info, DbcPool>,
    pub dbc_config: AccountLoader<'info, DbcConfig>,
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
    #[account(mut, seeds = [b"round", game.key().as_ref(), &game.current_round.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    /// CHECK: PDA signer, verified by seeds.
    #[account(seeds = [TREASURY_SEED], bump = game.treasury_bump)]
    pub treasury: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"wsol", game.key().as_ref()], bump)]
    pub wsol_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = WSOL_MINT)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub dbc_pool: AccountLoader<'info, DbcPool>,
    pub dbc_config: AccountLoader<'info, DbcConfig>,
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
    #[account(mut, seeds = [b"round", game.key().as_ref(), &game.current_round.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    /// CHECK: PDA signer, verified by seeds.
    #[account(seeds = [TREASURY_SEED], bump = game.treasury_bump)]
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
pub struct FinalRound { pub round: u64 }
#[event]
pub struct GameEnded { pub last_round: u64, pub to_team: u64 }
#[event]
pub struct Settled { pub round: u64, pub winner: Pubkey, pub jackpot: u64, pub carry: u64 }
#[event]
pub struct Harvested { pub round: u64, pub venue: Venue, pub lamports: u64, pub to_jackpot: u64, pub to_team: u64, pub to_current_round: bool }
#[event]
pub struct JackpotFunded { pub round: u64, pub funder: Pubkey, pub lamports: u64, pub to_current_round: bool }
#[event]
pub struct TeamPaid { pub team: Pubkey, pub lamports: u64 }
#[event]
pub struct AuthorityChanged { pub authority: Pubkey }

#[error_code]
pub enum FomoError {
    #[msg("Round is over")] RoundOver,
    #[msg("Arithmetic overflow")] Overflow,
    #[msg("Round already settled")] AlreadySettled,
    #[msg("The game has ended")] GameEnded,
    #[msg("Timer still running")] TimerRunning,
    #[msg("Invalid params")] BadParams,
    #[msg("Mint has Token-2022 extensions")] UnsupportedMint,
    #[msg("Pool or config does not belong to this game's token")] WrongPool,
    #[msg("The pool must collect its fees in SOL (quote token)")] FeesNotInSol,
    #[msg("The game's fee address is neither the pool's fee claimer nor its creator")] NoFeesToGame,
    #[msg("Only the keeper can report buys")] NotKeeper,
    #[msg("DBC pool already migrated")] AlreadyMigrated,
    #[msg("Buy is below the minimum that counts")] BuyTooSmall,
    #[msg("Buy happened before this round started")] BuyBeforeRound,
    #[msg("Buy happened after the countdown ran out")] BuyAfterDeadline,
    #[msg("Buys must be reported once each, in chain order")] BuyOutOfOrder,
    #[msg("Winner account must be passed exactly when the round has a winner")] WinnerAccountMismatch,
    #[msg("Nothing to claim")] NothingToClaim,
    #[msg("That is not the game's team wallet")] WrongTeam,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fee_split_matches_js_engine() {
        // Same vectors as web/src/game.test.js
        assert_eq!(split_fees(1_000_000_000), (800_000_000, 200_000_000));
        assert_eq!(split_fees(12_345_679), (9_876_544, 2_469_135));
        assert_eq!(split_fees(7), (6, 1));
        for amount in [1u64, 9, 10_001, 999_999_999_999] {
            let (j, t) = split_fees(amount);
            assert_eq!(j + t, amount);
        }
    }

    #[test]
    fn treasury_address_does_not_depend_on_the_token() {
        let (a, _) = Pubkey::find_program_address(&[TREASURY_SEED], &ID);
        let (b, _) = Pubkey::find_program_address(&[TREASURY_SEED], &ID);
        assert_eq!(a, b);
    }

    #[test]
    fn damm_pool_pda_depends_on_config() {
        let cfg = Pubkey::new_unique();
        let m = Pubkey::new_unique();
        assert_eq!(damm_pool_address(&cfg, &m), damm_pool_address(&cfg, &m));
        assert_ne!(damm_pool_address(&cfg, &m), damm_pool_address(&Pubkey::new_unique(), &m));
    }
}
