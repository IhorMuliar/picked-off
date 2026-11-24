//! Rollup crank body, every 250 ms. Permissionless and harmless: it resolves at most one deadline
//! per call, and only when the public gate opens:
//!   phase HIDE or LIVE, `slot >= Table.next_deadline_slot`, and, at the HIDE end with VRF
//!   enabled, either the VRF output has arrived (`Table.vrf_fulfils > 0`) or the deadline is
//!   `VRF_WAIT_BEATS` beats overdue (then the engine draws the fallback seed from the HIDE salts
//!   and the slot, and `Table.fallback_seed` / `Round.fallback_seed` record it).
//! The gate itself is computed with masks from public fields, so every closed-gate call costs the
//! same in every phase. Past the gate the rules engine resolves the HIDE end or one live beat in
//! place in the Book, every Desk gets its result and the public row is rewritten; all of it is
//! branch-free (the bell-only writes are masks), so every resolving call costs the same whatever
//! the hidden state. Never an error, no logs.
use crate::constants::*;
use crate::state::*;
use crate::utils::SyscallHasher;
use anchor_lang::prelude::*;
use ping_core::mask::{eq, lt, nz, sel, sel_bytes};

#[derive(Accounts)]
pub struct Tick<'info> {
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
}

/// 1 when this call may resolve a deadline (public fields only, no branches).
fn gate(t: &Table, slot: u64) -> u64 {
    let ph = t.phase as u64;
    let active = eq(ph, PH_HIDE as u64) | eq(ph, PH_LIVE as u64);
    // slots stay far below 2^63, as `lt` requires
    let due = 1 ^ lt(slot, t.next_deadline_slot);
    let vrf_on = nz(t.vrf_queue.to_bytes().iter().fold(0u64, |a, x| a | *x as u64));
    let waited = 1 ^ lt(slot, t.next_deadline_slot.saturating_add(VRF_WAIT_BEATS.saturating_mul(t.beat_slots)));
    let vrf_wait = eq(ph, PH_HIDE as u64) & vrf_on & eq(t.vrf_fulfils as u64, 0) & (1 ^ waited);
    active & due & (1 ^ vrf_wait)
}

pub fn tick(ctx: Context<Tick>) -> Result<()> {
    let slot = Clock::get()?.slot;
    let mut t = ctx.accounts.table.load_mut()?;
    t.tick_calls = t.tick_calls.wrapping_add(1);
    if gate(&t, slot) == 0 {
        return Ok(());
    }
    let was_hide = eq(t.phase as u64, PH_HIDE as u64);
    let mut out = ping_core::BeatOut::zeroed();
    let fallback;
    {
        let mut b = ctx.accounts.book.load_mut()?;
        let st = b.state_mut();
        ping_core::tick::<SyscallHasher, ping_core::NoSink>(st, t.table_id, t.round, slot, &mut ping_core::NoSink, &mut out);
        fallback = st.fallback as u64;
    }
    let bi = (out.beat as usize) % RESULT_SLOTS;
    let a = &ctx.accounts;
    let desks = [&a.desk0, &a.desk1, &a.desk2, &a.desk3, &a.desk4, &a.desk5, &a.desk6, &a.desk7];
    for (s, dl) in desks.iter().enumerate() {
        let mut d = dl.load_mut()?;
        let o = out.desks[s];
        d.results_mut()[bi] = o;
        d.resting = o.resting;
        d.picked = o.picked;
        d.level = o.level;
        d.next_algo = o.next_algo;
        d.beat = out.beat;
        d.result_slot = slot;
        d.phase = out.phase;
        d.pending_kind = 0;
        d.pending_level = 0;
    }
    let is_bell = eq(out.phase as u64, PH_BELL as u64);
    let mut count = t.print_count as u64;
    for s in 0..NDESK {
        let fill = out.desks[s].fill_amt as u64;
        let has = nz(fill);
        let pi = (count as usize) % PRINTS;
        let old = t.prints[pi];
        t.prints[pi] = Print {
            tenths: sel(has, fill, old.tenths as u64) as u16,
            beat: sel(has, out.beat as u64, old.beat as u64) as u16,
            desk: sel(has, s as u64, old.desk as u64) as u8,
            _pad: 0,
        };
        count += has;
        t.beat_fill[s] = fill as u16;
        t.totals[s] = sel(is_bell, out.totals[s] as u64, t.totals[s] as u64) as u16;
    }
    t.print_count = count as u32;
    t.picked = out.picked;
    t.beat = out.beat;
    t.chain_head = out.chain;
    t.beat_counts[(out.beat as usize) % BEAT_SLOTS_RING] = [out.pings, out.fills];
    t.top_desk = sel(is_bell, out.top_desk as u64, t.top_desk as u64) as u8;
    let mut commit = t.commit_hash;
    sel_bytes(is_bell, &out.chain, &mut commit);
    t.commit_hash = commit;
    t.bell_slot = sel(is_bell, slot, t.bell_slot);
    t.hide_end_slot = sel(was_hide, slot, t.hide_end_slot);
    t.fallback_seed = sel(was_hide, fallback, t.fallback_seed as u64) as u8;
    t.phase = out.phase;
    t.resolves = t.resolves.wrapping_add(1);
    // live beats keep their absolute deadlines (a late beat is caught up, never skipped); the
    // first live beat is timed from the HIDE end, which may have waited for the VRF output
    let base = sel(was_hide, slot, t.next_deadline_slot);
    t.next_deadline_slot = base.wrapping_add(t.beat_slots);
    Ok(())
}
