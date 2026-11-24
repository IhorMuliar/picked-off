//! Any layer: returns PROGRAM_VERSION (u32 LE) as return data. Simulate it on the rollup to see
//! which binary the rollup runs after an upgrade.
use crate::constants::*;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct Version<'info> {
    pub caller: Signer<'info>,
}

pub fn version(_ctx: Context<Version>) -> Result<()> {
    anchor_lang::solana_program::program::set_return_data(&PROGRAM_VERSION.to_le_bytes());
    Ok(())
}
