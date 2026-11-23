//! Ping: the game program behind Picked Off. Skeleton only; the game logic is not written yet.
#![allow(unexpected_cfgs)]
#![allow(deprecated)]

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::ephemeral;

declare_id!("5eP2A36T97mwaGHf6XoHZU6VoKh1NGxA2QwvtJhAJ6ms");

#[ephemeral]
#[program]
pub mod ping {
    use super::*;

    pub fn initialize(_ctx: Context<Initialize>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    pub payer: Signer<'info>,
}
