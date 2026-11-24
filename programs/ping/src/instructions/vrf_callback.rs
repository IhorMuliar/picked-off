//! Rollup: VRF fulfil for the round's seed. Only the VRF program's scoped identity can sign it
//! (injected and checked by `#[vrf_callback]`); Table and Book are bound by seeds. During HIDE the
//! first output is stored in the private Book (`ping_core::set_vrf`, first one wins) and the
//! public Table counts the fulfil; in any other phase (a late or duplicate fulfil, or one that
//! lands after the round already started on the fallback seed) it changes nothing. Never fails,
//! no logs.
use crate::constants::*;
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

pub fn vrf_callback(ctx: Context<VrfCallback>, randomness: [u8; 32]) -> Result<()> {
    let slot = Clock::get()?.slot;
    let mut t = ctx.accounts.table.load_mut()?;
    if t.phase != PH_HIDE {
        return Ok(());
    }
    let mut b = ctx.accounts.book.load_mut()?;
    if b.round != t.round {
        return Ok(());
    }
    let st = b.state_mut();
    let first = st.vrf_set == 0;
    ping_core::set_vrf(st, &randomness);
    if first {
        b.vrf_slot = slot;
        t.vrf_fulfil_slot = slot;
    }
    t.vrf_fulfils = t.vrf_fulfils.saturating_add(1);
    Ok(())
}
