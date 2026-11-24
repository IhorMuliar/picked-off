//! Rollup (task A2): VRF fulfil for the round's seed. Writes Book.vrf once per round (HIDE only);
//! the Table gets only the fulfil count and slot. Never fails. Stub until A2: does nothing.
use crate::constants::*;
use crate::errors::PingError;
use crate::state::*;
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::vrf_callback;

#[vrf_callback]
#[derive(Accounts)]
pub struct VrfCallback<'info> {
    #[account(mut, seeds = [TABLE_SEED, &table.load()?.table_id.to_le_bytes()], bump = table.load()?.bump)]
    pub table: AccountLoader<'info, Table>,
    #[account(mut, seeds = [BOOK_SEED, &table.load()?.table_id.to_le_bytes()], bump = table.load()?.book_bump)]
    pub book: AccountLoader<'info, Book>,
}

pub fn vrf_callback(_ctx: Context<VrfCallback>, _randomness: [u8; 32]) -> Result<()> {
    let _ = PingError::NotImplemented;
    Ok(())
}
