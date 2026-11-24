//! Rollup (task A2): start a fresh crank task (same derivation, current slot hash) when Table.beat
//! stalled >= 3 s in HIDE/LIVE (squatted or dead task). House only. Stub until A2.
use crate::constants::*;
use crate::errors::PingError;
use crate::state::*;
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::consts::MAGIC_PROGRAM_ID;

#[derive(Accounts)]
pub struct RescheduleCrank<'info> {
    #[account(mut)]
    pub house: Signer<'info>,
    #[account(mut, seeds = [TABLE_SEED, &table.load()?.table_id.to_le_bytes()], bump = table.load()?.bump)]
    pub table: AccountLoader<'info, Table>,
    #[account(mut, seeds = [BOOK_SEED, &table.load()?.table_id.to_le_bytes()], bump = table.load()?.book_bump)]
    pub book: AccountLoader<'info, Book>,
    #[account(mut, seeds = [DESK_SEED, &table.load()?.table_id.to_le_bytes(), &[0]], bump = table.load()?.desk_bump[0])]
    pub desk0: AccountLoader<'info, Desk>,
    #[account(mut, seeds = [DESK_SEED, &table.load()?.table_id.to_le_bytes(), &[1]], bump = table.load()?.desk_bump[1])]
    pub desk1: AccountLoader<'info, Desk>,
    #[account(mut, seeds = [DESK_SEED, &table.load()?.table_id.to_le_bytes(), &[2]], bump = table.load()?.desk_bump[2])]
    pub desk2: AccountLoader<'info, Desk>,
    #[account(mut, seeds = [DESK_SEED, &table.load()?.table_id.to_le_bytes(), &[3]], bump = table.load()?.desk_bump[3])]
    pub desk3: AccountLoader<'info, Desk>,
    #[account(mut, seeds = [DESK_SEED, &table.load()?.table_id.to_le_bytes(), &[4]], bump = table.load()?.desk_bump[4])]
    pub desk4: AccountLoader<'info, Desk>,
    #[account(mut, seeds = [DESK_SEED, &table.load()?.table_id.to_le_bytes(), &[5]], bump = table.load()?.desk_bump[5])]
    pub desk5: AccountLoader<'info, Desk>,
    #[account(mut, seeds = [DESK_SEED, &table.load()?.table_id.to_le_bytes(), &[6]], bump = table.load()?.desk_bump[6])]
    pub desk6: AccountLoader<'info, Desk>,
    #[account(mut, seeds = [DESK_SEED, &table.load()?.table_id.to_le_bytes(), &[7]], bump = table.load()?.desk_bump[7])]
    pub desk7: AccountLoader<'info, Desk>,
    /// CHECK: magic program
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
    /// CHECK: slot hashes sysvar
    #[account(address = SLOT_HASHES_SYSVAR)]
    pub slot_hashes: UncheckedAccount<'info>,
}

pub fn reschedule_crank(_ctx: Context<RescheduleCrank>) -> Result<()> {
    err!(PingError::NotImplemented)
}
