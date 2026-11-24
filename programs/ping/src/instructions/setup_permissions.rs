//! Rollup: create or update the permission of one pool account, always to its sealed state:
//! Table public; Book private with no members; Desk s private with its seated key (flags 0), or
//! no members when the seat is empty; Round public. House only. Used once per pool for setup and
//! again before every round to re-seal what `unseal` made public; `open_round` requires the Book
//! and all eight Desks sealed (Table.sealed == SEAL_ALL).
use crate::constants::*;
use crate::errors::PingError;
use crate::state::*;
use crate::utils::*;
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID};

#[derive(Accounts)]
pub struct SetupPermissions<'info> {
    pub house: Signer<'info>,
    #[account(mut, seeds = [TABLE_SEED, &table.load()?.table_id.to_le_bytes()], bump = table.load()?.bump)]
    pub table: AccountLoader<'info, Table>,
    /// CHECK: the Book / Desk / Round PDA (checked); omitted when kind = KIND_TABLE
    #[account(mut)]
    pub target: Option<UncheckedAccount<'info>>,
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

pub fn setup_permissions(ctx: Context<SetupPermissions>, kind: u8, index: u64) -> Result<()> {
    let (table_id, seat) = {
        let t = ctx.accounts.table.load()?;
        require_house(&t.house, &ctx.accounts.house.key())?;
        let seat = if kind == KIND_DESK && index < NDESK as u64 { t.seats[index as usize] } else { bytemuck::Zeroable::zeroed() };
        (t.table_id, seat)
    };
    let seeds = account_seeds(kind, table_id, index)?;
    let (is_private, members) = match kind {
        KIND_TABLE | KIND_ROUND => (false, vec![]),
        KIND_BOOK => (true, vec![]),
        _ => (true, desk_members(&seat)),
    };
    let target = match (kind, &ctx.accounts.target) {
        (KIND_TABLE, _) => ctx.accounts.table.to_account_info(),
        (_, Some(t)) => t.to_account_info(),
        _ => return err!(PingError::BadAccount),
    };
    let a = &ctx.accounts;
    set_permission(
        &target,
        &a.permission.to_account_info(),
        &a.ephemeral_vault.to_account_info(),
        &a.magic_program.to_account_info(),
        &a.permission_program.to_account_info(),
        &seeds,
        is_private,
        members,
    )?;
    let bit = match kind {
        KIND_BOOK => SEAL_BOOK,
        KIND_DESK => 1u16 << index,
        _ => 0,
    };
    let mut t = ctx.accounts.table.load_mut()?;
    t.sealed |= bit;
    Ok(())
}
