//! Rollup (task A2): a player's burner takes desk `seat` of a house pool (a bot's or an empty
//! desk), one desk per key per pool, never a human-held desk; sets the Desk permission to the
//! burner alone (flags 0). Stub until A2.
use crate::constants::*;
use crate::errors::PingError;
use crate::state::*;
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID};

#[derive(Accounts)]
#[instruction(seat: u8)]
pub struct Join<'info> {
    pub player: Signer<'info>,
    #[account(mut, seeds = [TABLE_SEED, &table.load()?.table_id.to_le_bytes()], bump = table.load()?.bump)]
    pub table: AccountLoader<'info, Table>,
    #[account(mut, seeds = [DESK_SEED, &table.load()?.table_id.to_le_bytes(), &[seat]], bump)]
    pub desk: AccountLoader<'info, Desk>,
    /// CHECK: permission PDA of the target (checked against EphemeralPermission::find_pda)
    #[account(mut)]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: permission program
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: ephemeral rent vault
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: magic program
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

pub fn join(_ctx: Context<Join>, _seat: u8, _name: [u8; 16]) -> Result<()> {
    err!(PingError::NotImplemented)
}
