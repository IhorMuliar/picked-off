//! Base (task A3): one spectator call of Config.call_lamports on desk `desk`, one per burner per round (Call is `init`), rejected at or after Tape.close_unix or once resolved. Stub until A3.
use crate::constants::*;
use crate::errors::PingError;
use crate::state::*;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct PlaceCall<'info> {
    #[account(mut)]
    pub bettor: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: AccountLoader<'info, Config>,
    #[account(mut, seeds = [TAPE_SEED, &tape.load()?.table_id.to_le_bytes(), &tape.load()?.round.to_le_bytes()], bump)]
    pub tape: AccountLoader<'info, Tape>,
    #[account(init, payer = bettor, space = CALL_SPACE, seeds = [CALL_SEED, tape.key().as_ref(), bettor.key().as_ref()], bump)]
    pub call: AccountLoader<'info, Call>,
    pub system_program: Program<'info, System>,
}

pub fn place_call(_ctx: Context<PlaceCall>, _desk: u8) -> Result<()> {
    err!(PingError::NotImplemented)
}
