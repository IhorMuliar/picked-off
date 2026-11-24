//! Base (task A3): pay one call to its bettor (permissionless, pays only Call.bettor): amount x total / pool[winner] (u128, floor) for a winning call, the amount if void, 0 otherwise; a payout that would leave the bettor below the runtime rent minimum stays owed in Call.owed; closes the Call to the bettor when paid. Stub until A3.
use crate::constants::*;
use crate::errors::PingError;
use crate::state::*;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct ClaimCall<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(mut, seeds = [TAPE_SEED, &tape.load()?.table_id.to_le_bytes(), &tape.load()?.round.to_le_bytes()], bump)]
    pub tape: AccountLoader<'info, Tape>,
    #[account(mut, seeds = [CALL_SEED, tape.key().as_ref(), bettor.key().as_ref()], bump)]
    pub call: AccountLoader<'info, Call>,
    /// CHECK: must equal Call.bettor (checked in the handler)
    #[account(mut)]
    pub bettor: UncheckedAccount<'info>,
}

pub fn claim_call(_ctx: Context<ClaimCall>) -> Result<()> {
    err!(PingError::NotImplemented)
}
