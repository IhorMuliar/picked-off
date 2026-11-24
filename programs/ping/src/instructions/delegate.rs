//! Base: delegate one pool account (Table, Book, Desk s) or one Round to the pinned validator.
//! House only; one account per instruction; the PDA is derived here from (kind, table, index).
use crate::constants::*;
use crate::errors::PingError;
use crate::state::*;
use crate::utils::*;
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::delegate;
use ephemeral_rollups_sdk::cpi::DelegateConfig;

#[delegate]
#[derive(Accounts)]
pub struct DelegatePda<'info> {
    #[account(mut)]
    pub house: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: AccountLoader<'info, Config>,
    /// CHECK: checked against the PDA derived from (kind, table_id, index)
    #[account(mut, del)]
    pub pda: UncheckedAccount<'info>,
    /// CHECK: must be Config.tee_validator
    #[account(address = config.load()?.tee_validator @ PingError::BadValidator)]
    pub validator: UncheckedAccount<'info>,
}

pub fn delegate(ctx: Context<DelegatePda>, kind: u8, table_id: u64, index: u64) -> Result<()> {
    let house = ctx.accounts.config.load()?.house;
    require_keys_eq!(house, ctx.accounts.house.key(), PingError::NotHouse);
    let seeds = account_seeds(kind, table_id, index)?;
    expect_pda(&ctx.accounts.pda.to_account_info(), &seeds)?;
    let s: Vec<&[u8]> = seeds.iter().map(|v| v.as_slice()).collect();
    ctx.accounts.delegate_pda(
        &ctx.accounts.house,
        &s,
        DelegateConfig { validator: Some(ctx.accounts.validator.key()), ..Default::default() },
    )?;
    Ok(())
}
