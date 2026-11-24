//! Rollup, after the reveal: make the Book or Desk s public (anyone can read the finished round).
//! House only, phase REVEALED only. The next round's `setup_permissions` re-seals.
use crate::constants::*;
use crate::errors::PingError;
use crate::state::*;
use crate::utils::*;
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID};

#[derive(Accounts)]
pub struct Unseal<'info> {
    pub house: Signer<'info>,
    #[account(mut, seeds = [TABLE_SEED, &table.load()?.table_id.to_le_bytes()], bump = table.load()?.bump)]
    pub table: AccountLoader<'info, Table>,
    /// CHECK: the Book or Desk PDA (checked)
    #[account(mut)]
    pub target: UncheckedAccount<'info>,
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

pub fn unseal(ctx: Context<Unseal>, kind: u8, index: u64) -> Result<()> {
    let table_id = {
        let t = ctx.accounts.table.load()?;
        require_house(&t.house, &ctx.accounts.house.key())?;
        require!(t.phase == PH_REVEALED, PingError::BadPhase);
        t.table_id
    };
    require!(kind == KIND_BOOK || kind == KIND_DESK, PingError::BadKind);
    let seeds = account_seeds(kind, table_id, index)?;
    let a = &ctx.accounts;
    set_permission(
        &a.target.to_account_info(),
        &a.permission.to_account_info(),
        &a.ephemeral_vault.to_account_info(),
        &a.magic_program.to_account_info(),
        &a.permission_program.to_account_info(),
        &seeds,
        false,
        vec![],
    )?;
    let bit = if kind == KIND_BOOK { SEAL_BOOK } else { 1u16 << index };
    let mut t = ctx.accounts.table.load_mut()?;
    t.sealed &= !bit;
    Ok(())
}
