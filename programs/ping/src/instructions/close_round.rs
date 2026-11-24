//! Base: close a Round record and its Tape, all lamports to the house. House only.
//! Allowed once the Tape is resolved and every call is claimed, or `TAPE_CLOSE_AFTER_SECS` (24 h)
//! after `Tape.close_unix`; whatever is still in the Tape then (its rent, the floor remainder of
//! the payouts, and after the timeout any unclaimed calls) goes to the house. The Ledger keeps
//! record numbers increasing, so a closed (table, round) can never be created again.
use crate::constants::*;
use crate::errors::PingError;
use crate::state::*;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct CloseRound<'info> {
    #[account(mut)]
    pub house: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: AccountLoader<'info, Config>,
    #[account(mut, seeds = [ROUND_SEED, &round.load()?.table_id.to_le_bytes(), &round.load()?.round.to_le_bytes()], bump)]
    pub round: AccountLoader<'info, Round>,
    #[account(mut, seeds = [TAPE_SEED, &round.load()?.table_id.to_le_bytes(), &round.load()?.round.to_le_bytes()], bump)]
    pub tape: AccountLoader<'info, Tape>,
}

pub fn close_round(ctx: Context<CloseRound>) -> Result<()> {
    require_keys_eq!(ctx.accounts.config.load()?.house, ctx.accounts.house.key(), PingError::NotHouse);
    {
        require!(ctx.accounts.round.load()?.status != RS_OPEN, PingError::RoundInPlay);
        let t = ctx.accounts.tape.load()?;
        let timeout = t.close_unix.checked_add(TAPE_CLOSE_AFTER_SECS).ok_or(PingError::Overflow)?;
        let done = t.resolved != 0 && t.open_calls == 0;
        require!(done || Clock::get()?.unix_timestamp >= timeout, PingError::TapeOpen);
    }
    let house = ctx.accounts.house.to_account_info();
    ctx.accounts.tape.close(house.clone())?;
    ctx.accounts.round.close(house)
}
