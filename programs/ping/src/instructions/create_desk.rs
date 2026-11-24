//! Base: create desk `index` of a pool (empty seat). House only.
use crate::constants::*;
use crate::errors::PingError;
use crate::state::*;
use crate::utils::*;
use anchor_lang::prelude::*;

#[derive(Accounts)]
#[instruction(table_id: u64, index: u8)]
pub struct CreateDesk<'info> {
    #[account(mut)]
    pub house: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: AccountLoader<'info, Config>,
    #[account(mut, seeds = [TABLE_SEED, &table_id.to_le_bytes()], bump)]
    pub table: AccountLoader<'info, Table>,
    #[account(init, payer = house, space = DESK_SPACE, seeds = [DESK_SEED, &table_id.to_le_bytes(), &[index]], bump)]
    pub desk: AccountLoader<'info, Desk>,
    pub system_program: Program<'info, System>,
}

pub fn create_desk(ctx: Context<CreateDesk>, table_id: u64, index: u8) -> Result<()> {
    require!((index as usize) < NDESK, PingError::BadSeat);
    let house = ctx.accounts.config.load()?.house;
    require_keys_eq!(house, ctx.accounts.house.key(), PingError::NotHouse);
    {
        let mut t = ctx.accounts.table.load_mut()?;
        require_keys_eq!(t.house, house, PingError::NotHouse);
        t.desk_bump[index as usize] = ctx.bumps.desk;
    }
    transfer_from(
        &ctx.accounts.house.to_account_info(),
        &ctx.accounts.desk.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        permission_rent(),
    )?;
    let mut d = ctx.accounts.desk.load_init()?;
    d.table_id = table_id;
    d.index = index;
    d.resting = STAKE_TENTHS;
    d.layout = LAYOUT_VERSION;
    Ok(())
}
