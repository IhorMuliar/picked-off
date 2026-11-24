//! Base (task A3): resolve the Tape (and staked vaults) from a committed Round: anyone; only when the Round is back on base (owner = program) with status REVEALED or ABORTED; writes Tape.winner / void / resolved, moves no lamports; idempotent. Stub until A3.
use crate::constants::*;
use crate::errors::PingError;
use crate::state::*;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct SettleRound<'info> {
    pub caller: Signer<'info>,
    #[account(seeds = [ROUND_SEED, &round.load()?.table_id.to_le_bytes(), &round.load()?.round.to_le_bytes()], bump)]
    pub round: AccountLoader<'info, Round>,
    #[account(mut, seeds = [TAPE_SEED, &round.load()?.table_id.to_le_bytes(), &round.load()?.round.to_le_bytes()], bump)]
    pub tape: AccountLoader<'info, Tape>,
}

pub fn settle_round(_ctx: Context<SettleRound>) -> Result<()> {
    err!(PingError::NotImplemented)
}
