//! Base (task A3): close a settled Round and its Tape (rent to the house) once every call is claimed or 24 h after close_unix. House only. Stub until A3.
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

pub fn close_round(_ctx: Context<CloseRound>) -> Result<()> {
    err!(PingError::NotImplemented)
}
