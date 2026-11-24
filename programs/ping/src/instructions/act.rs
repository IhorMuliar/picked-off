//! Rollup: the one player action, sent every 250 ms by every seated desk.
//! Wire: discriminator, kind u8, level u8, seq u32 LE, salt [u8; 16]. Touches only the signer's
//! own Desk and the Book; never fails, never logs, and does the same work for every input.
//!
//! `ok` = (signer is the Desk's key) AND (seq > Desk.last_seq) AND (the Book belongs to the
//! Desk's table), computed as a 0/1 mask. Only when `ok` is 1 does anything change: the ack
//! (`last_seq`, `ack_slot`, `acts`), the engine's `record_act` (salt fold and placement in HIDE,
//! pending choice in LIVE), and the Desk's echo of its own accepted choice. Wrong key, stale
//! seq, wrong phase, unknown kind and out-of-range level are all the same masked no-op.
//!
//! Account checks are owner + discriminator only (constant cost). A seeds check would search for
//! the bump, whose cost differs per account; it is not needed: only this program creates Desk
//! and Book accounts, always at their PDA, and `Book.table_id` binds the Book to the Desk.
use crate::constants::*;
use crate::state::*;
use crate::utils::SyscallHasher;
use anchor_lang::prelude::*;
use ping_core::mask::{eq, lt, nz, op, sel};

#[derive(Accounts)]
pub struct Act<'info> {
    pub player: Signer<'info>,
    #[account(mut)]
    pub desk: AccountLoader<'info, Desk>,
    #[account(mut)]
    pub book: AccountLoader<'info, Book>,
}

#[inline(always)]
fn word(b: &[u8; 32], i: usize) -> u64 {
    u64::from_le_bytes([b[8 * i], b[8 * i + 1], b[8 * i + 2], b[8 * i + 3], b[8 * i + 4], b[8 * i + 5], b[8 * i + 6], b[8 * i + 7]])
}

pub fn act(ctx: Context<Act>, kind: u8, level: u8, seq: u32, salt: [u8; 16]) -> Result<()> {
    let slot = Clock::get()?.slot;
    let pk = ctx.accounts.player.key().to_bytes();
    let mut d = ctx.accounts.desk.load_mut()?;
    let mut b = ctx.accounts.book.load_mut()?;
    let dk = d.key.to_bytes();
    let mut diff = 0u64;
    for i in 0..4 {
        diff |= op(word(&pk, i) ^ word(&dk, i));
    }
    let same_table = eq(b.table_id ^ d.table_id, 0);
    let ok = (1 ^ nz(diff)) & lt(d.last_seq as u64, seq as u64) & same_table;
    d.last_seq = sel(ok, seq as u64, d.last_seq as u64) as u32;
    d.ack_slot = sel(ok, slot, d.ack_slot);
    d.acts = (d.acts as u64).wrapping_add(ok) as u32;
    let s = d.index as usize % NDESK;
    let st = b.state_mut();
    ping_core::record_act::<SyscallHasher>(st, s, kind, level, &salt, ok);
    // echo the desk's own accepted choice (its placement in HIDE, its pending choice in LIVE)
    d.placed = sel(ok, st.placed[s] as u64, d.placed as u64) as u8;
    d.level = sel(ok & st.placed[s] as u64 & eq(st.phase as u64, PH_HIDE as u64), st.level[s] as u64, d.level as u64) as u8;
    d.pending_kind = sel(ok, st.pending_kind[s] as u64, d.pending_kind as u64) as u8;
    d.pending_level = sel(ok, st.pending_level[s] as u64, d.pending_level as u64) as u8;
    Ok(())
}
