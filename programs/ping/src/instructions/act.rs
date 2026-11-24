//! Rollup (task A2): the one player action, sent every 250 ms by every seated desk.
//! Wire: discriminator, kind u8, level u8, seq u32 LE, salt [u8; 16]. Touches only the signer's
//! own Desk and the Book; never fails, never logs, constant compute for every input.
//! Stub until A2: does nothing.
use crate::constants::*;
use crate::errors::PingError;
use crate::state::*;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct Act<'info> {
    pub player: Signer<'info>,
    #[account(mut, seeds = [DESK_SEED, &desk.load()?.table_id.to_le_bytes(), &[desk.load()?.index]], bump)]
    pub desk: AccountLoader<'info, Desk>,
    #[account(mut, seeds = [BOOK_SEED, &desk.load()?.table_id.to_le_bytes()], bump)]
    pub book: AccountLoader<'info, Book>,
}

pub fn act(_ctx: Context<Act>, _kind: u8, _level: u8, _seq: u32, _salt: [u8; 16]) -> Result<()> {
    let _ = PingError::NotImplemented;
    Ok(())
}
