//! FOMO City: last-buyer-wins game paid in an SPL token (traded on Meteora).
//!
//! Math mirrors web/src/game.js exactly. Every buy:
//!   50% jackpot · 35% dividends to existing floor holders · 10% next-round seed · 5% dev
//! The dev cut is sent straight to `dev_token_account`; everything else sits in a
//! program-owned vault that only these instructions can move.
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

declare_id!("11111111111111111111111111111111");

pub const ACC_PRECISION: u128 = 1_000_000_000_000;
pub const BPS: u64 = 10_000;
pub const SPLIT_DIVIDENDS: u64 = 3_500;
pub const SPLIT_NEXT_ROUND: u64 = 1_000;
pub const SPLIT_DEV: u64 = 500;
// jackpot gets the remainder (5_000 bps + rounding dust)

#[program]
pub mod fomocity {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, params: Params) -> Result<()> {
        require!(params.max_floors_per_buy > 0 && params.initial_timer > 0, FomoError::BadParams);
        require!(params.initial_timer <= params.max_timer, FomoError::BadParams);
        // Plain mints only: Token-2022 extensions like transfer fees or hooks would make
        // the vault receive less than we account for and drain later claimers.
        require!(ctx.accounts.mint.to_account_info().data_len() == 82, FomoError::UnsupportedMint);
        let game = &mut ctx.accounts.game;
        game.authority = ctx.accounts.authority.key();
        game.mint = ctx.accounts.mint.key();
        game.dev_token_account = ctx.accounts.dev_token_account.key();
        game.params = params;
        game.current_round = 1;
        game.bump = ctx.bumps.game;
        game.vault_bump = ctx.bumps.vault;

        let now = Clock::get()?.unix_timestamp;
        ctx.accounts.round.open(1, now, &params, 0, ctx.bumps.round);
        Ok(())
    }

    /// Buy `n` floors. `max_cost` protects against the price moving under you.
    pub fn buy(ctx: Context<Buy>, n: u32, max_cost: u64) -> Result<()> {
        let game = &ctx.accounts.game;
        let p = game.params;
        let now = Clock::get()?.unix_timestamp;
        let round = &mut ctx.accounts.round;
        require!(!round.settled && now < round.end_ts, FomoError::RoundOver);
        require!(now >= round.start_ts, FomoError::NotStarted);
        require!(n >= 1 && n <= p.max_floors_per_buy, FomoError::BadFloorCount);

        let cost = cost_of(&p, round.total_floors, n as u64)?;
        require!(cost <= max_cost, FomoError::SlippageExceeded);

        let to_div = bp(cost, SPLIT_DIVIDENDS);
        let to_next = bp(cost, SPLIT_NEXT_ROUND);
        let to_dev = bp(cost, SPLIT_DEV);
        let mut to_jackpot = cost - to_div - to_next - to_dev;

        if round.total_floors > 0 {
            let inc = (to_div as u128) * ACC_PRECISION / (round.total_floors as u128);
            round.acc_per_floor = round.acc_per_floor.checked_add(inc).ok_or(FomoError::Overflow)?;
        } else {
            to_jackpot += to_div;
        }
        round.jackpot = round.jackpot.checked_add(to_jackpot).ok_or(FomoError::Overflow)?;
        round.next_round_pot = round.next_round_pot.checked_add(to_next).ok_or(FomoError::Overflow)?;

        let player = &mut ctx.accounts.player_round;
        if player.floors == 0 && player.reward_debt == 0 {
            player.round = round.id;
            player.owner = ctx.accounts.buyer.key();
            player.bump = ctx.bumps.player_round;
        }
        player.floors = player.floors.checked_add(n as u64).ok_or(FomoError::Overflow)?;
        player.reward_debt = player
            .reward_debt
            .checked_add(((n as u128) * round.acc_per_floor / ACC_PRECISION) as u64)
            .ok_or(FomoError::Overflow)?;

        round.total_floors += n as u64;
        round.last_buyer = ctx.accounts.buyer.key();
        round.end_ts = (round.end_ts + n as i64 * p.time_add_per_floor).min(now + p.max_timer);

        let decimals = ctx.accounts.mint.decimals;
        let prog = ctx.accounts.token_program.key();
        token_interface::transfer_checked(
            CpiContext::new(prog, TransferChecked {
                from: ctx.accounts.buyer_token_account.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.buyer.to_account_info(),
            }),
            cost - to_dev,
            decimals,
        )?;
        token_interface::transfer_checked(
            CpiContext::new(prog, TransferChecked {
                from: ctx.accounts.buyer_token_account.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.dev_token_account.to_account_info(),
                authority: ctx.accounts.buyer.to_account_info(),
            }),
            to_dev,
            decimals,
        )?;

        emit!(Bought { round: round.id, buyer: round.last_buyer, floors: n, cost, total_floors: round.total_floors, end_ts: round.end_ts, jackpot: round.jackpot });
        Ok(())
    }

    /// Withdraw accrued dividends for a round (works during or after the round).
    pub fn claim_dividends(ctx: Context<ClaimDividends>) -> Result<()> {
        let round = &ctx.accounts.round;
        let player = &mut ctx.accounts.player_round;
        let owed = ((player.floors as u128) * round.acc_per_floor / ACC_PRECISION) as u64 - player.reward_debt;
        require!(owed > 0, FomoError::NothingToClaim);
        player.reward_debt += owed;
        player.claimed += owed;
        pay_from_vault(&ctx.accounts.game, &ctx.accounts.vault, &ctx.accounts.mint, &ctx.accounts.owner_token_account, &ctx.accounts.token_program, owed)?;
        emit!(Claimed { round: round.id, owner: player.owner, amount: owed });
        Ok(())
    }

    /// Permissionless: anyone can close out an expired round and open the next one.
    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let game = &mut ctx.accounts.game;
        let round = &mut ctx.accounts.round;
        require!(!round.settled, FomoError::AlreadySettled);
        require!(now >= round.end_ts, FomoError::TimerRunning);
        round.settled = true;

        let has_winner = round.total_floors > 0;
        let carry = if has_winner { round.next_round_pot } else { round.jackpot + round.next_round_pot };
        if !has_winner {
            round.jackpot = 0;
        }
        game.current_round += 1;
        let p = game.params;
        ctx.accounts.next_round.open(game.current_round, now, &p, carry, ctx.bumps.next_round);
        emit!(Settled { round: round.id, winner: round.last_buyer, jackpot: round.jackpot, carry });
        Ok(())
    }

    /// The last buyer of a settled round withdraws the jackpot.
    pub fn claim_jackpot(ctx: Context<ClaimJackpot>) -> Result<()> {
        let round = &mut ctx.accounts.round;
        require!(round.settled, FomoError::TimerRunning);
        require!(!round.jackpot_claimed && round.jackpot > 0, FomoError::NothingToClaim);
        round.jackpot_claimed = true;
        let amount = round.jackpot;
        pay_from_vault(&ctx.accounts.game, &ctx.accounts.vault, &ctx.accounts.mint, &ctx.accounts.winner_token_account, &ctx.accounts.token_program, amount)?;
        Ok(())
    }
}

fn bp(amount: u64, bps: u64) -> u64 {
    ((amount as u128) * (bps as u128) / (BPS as u128)) as u64
}

/// n * base + step * (n * sold + n(n-1)/2)
pub fn cost_of(p: &Params, sold: u64, n: u64) -> Result<u64> {
    let (sold, n) = (sold as u128, n as u128);
    let c = n * p.base_price as u128 + p.price_step as u128 * (n * sold + n * (n - 1) / 2);
    u64::try_from(c).map_err(|_| FomoError::Overflow.into())
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
    pub base_price: u64,
    pub price_step: u64,
    pub time_add_per_floor: i64,
    pub max_timer: i64,
    pub initial_timer: i64,
    pub max_floors_per_buy: u32,
}

#[account]
#[derive(InitSpace)]
pub struct Game {
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub dev_token_account: Pubkey,
    pub params: Params,
    pub current_round: u64,
    pub bump: u8,
    pub vault_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Round {
    pub id: u64,
    pub start_ts: i64,
    pub end_ts: i64,
    pub total_floors: u64,
    pub jackpot: u64,
    pub next_round_pot: u64,
    pub acc_per_floor: u128,
    pub last_buyer: Pubkey,
    pub settled: bool,
    pub jackpot_claimed: bool,
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

#[account]
#[derive(InitSpace)]
pub struct PlayerRound {
    pub round: u64,
    pub owner: Pubkey,
    pub floors: u64,
    pub reward_debt: u64,
    pub claimed: u64,
    pub bump: u8,
}

// ---------- accounts ----------

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(token::mint = mint, token::token_program = token_program)]
    pub dev_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(init, payer = authority, space = 8 + Game::INIT_SPACE, seeds = [b"game", mint.key().as_ref()], bump)]
    pub game: Account<'info, Game>,
    #[account(
        init, payer = authority, seeds = [b"vault", mint.key().as_ref()], bump,
        token::mint = mint, token::authority = game, token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(init, payer = authority, space = 8 + Round::INIT_SPACE, seeds = [b"round", game.key().as_ref(), &1u64.to_le_bytes()], bump)]
    pub round: Account<'info, Round>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Buy<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(has_one = mint, has_one = dev_token_account)]
    pub game: Account<'info, Game>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, seeds = [b"round", game.key().as_ref(), &game.current_round.to_le_bytes()], bump = round.bump)]
    pub round: Account<'info, Round>,
    #[account(
        init_if_needed, payer = buyer, space = 8 + PlayerRound::INIT_SPACE,
        seeds = [b"player", round.key().as_ref(), buyer.key().as_ref()], bump,
    )]
    pub player_round: Account<'info, PlayerRound>,
    #[account(mut, token::mint = mint, token::authority = buyer, token::token_program = token_program)]
    pub buyer_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, seeds = [b"vault", mint.key().as_ref()], bump = game.vault_bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub dev_token_account: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimDividends<'info> {
    pub owner: Signer<'info>,
    #[account(has_one = mint)]
    pub game: Account<'info, Game>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(seeds = [b"round", game.key().as_ref(), &round.id.to_le_bytes()], bump = round.bump)]
    pub round: Account<'info, Round>,
    #[account(mut, has_one = owner, seeds = [b"player", round.key().as_ref(), owner.key().as_ref()], bump = player_round.bump)]
    pub player_round: Account<'info, PlayerRound>,
    #[account(mut, token::mint = mint, token::token_program = token_program)]
    pub owner_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, seeds = [b"vault", mint.key().as_ref()], bump = game.vault_bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(mut)]
    pub game: Account<'info, Game>,
    #[account(mut, seeds = [b"round", game.key().as_ref(), &game.current_round.to_le_bytes()], bump = round.bump)]
    pub round: Account<'info, Round>,
    #[account(
        init, payer = cranker, space = 8 + Round::INIT_SPACE,
        seeds = [b"round", game.key().as_ref(), &(game.current_round + 1).to_le_bytes()], bump,
    )]
    pub next_round: Account<'info, Round>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimJackpot<'info> {
    #[account(has_one = mint)]
    pub game: Account<'info, Game>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, seeds = [b"round", game.key().as_ref(), &round.id.to_le_bytes()], bump = round.bump)]
    pub round: Account<'info, Round>,
    /// Anyone may crank this, but funds only ever go to the winner's token account.
    #[account(mut, token::mint = mint, token::authority = round.last_buyer, token::token_program = token_program)]
    pub winner_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, seeds = [b"vault", mint.key().as_ref()], bump = game.vault_bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

// ---------- events & errors ----------

#[event]
pub struct Bought { pub round: u64, pub buyer: Pubkey, pub floors: u32, pub cost: u64, pub total_floors: u64, pub end_ts: i64, pub jackpot: u64 }
#[event]
pub struct Claimed { pub round: u64, pub owner: Pubkey, pub amount: u64 }
#[event]
pub struct Settled { pub round: u64, pub winner: Pubkey, pub jackpot: u64, pub carry: u64 }

#[error_code]
pub enum FomoError {
    #[msg("Round is over")] RoundOver,
    #[msg("Round has not started")] NotStarted,
    #[msg("Floor count out of range")] BadFloorCount,
    #[msg("Cost exceeds max_cost")] SlippageExceeded,
    #[msg("Arithmetic overflow")] Overflow,
    #[msg("Nothing to claim")] NothingToClaim,
    #[msg("Round already settled")] AlreadySettled,
    #[msg("Timer still running")] TimerRunning,
    #[msg("Invalid params")] BadParams,
    #[msg("Mint has Token-2022 extensions")] UnsupportedMint,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cost_matches_js_engine() {
        let p = Params { base_price: 1_000_000, price_step: 10_000, time_add_per_floor: 30, max_timer: 86_400, initial_timer: 86_400, max_floors_per_buy: 100 };
        // first 20 floors: 20 * 1.00 + 0.01 * 190 = 21.90
        assert_eq!(cost_of(&p, 0, 20).unwrap(), 21_900_000);
        // floors 21..26 after 20 sold: 6 * 1.00 + 0.01 * (120 + 15) = 7.35
        assert_eq!(cost_of(&p, 20, 6).unwrap(), 7_350_000);
        // split always sums to cost
        let c = cost_of(&p, 7, 3).unwrap();
        let (d, nx, dv) = (bp(c, SPLIT_DIVIDENDS), bp(c, SPLIT_NEXT_ROUND), bp(c, SPLIT_DEV));
        assert!(c - d - nx - dv >= c / 2);
    }
}
