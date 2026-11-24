//! Rollup crank body, every 250 ms. Permissionless and harmless: a no-op unless the public phase
//! is HIDE or LIVE and `slot >= Table.next_deadline_slot`; then it resolves exactly one deadline
//! (the HIDE end or one live beat) with the rules engine, in place in the Book, writes every
//! Desk's result and the public row. Never an error, no logs. Everything after the public gate
//! is branch-free: the bell-only writes are masks, not ifs.
//! (Task A2 owns verifying the constant compute of this path.)
use crate::constants::*;
use crate::utils::SyscallHasher;
use ping_core::mask::{eq, nz, sel};
use crate::state::*;
use anchor_lang::prelude::*;

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

pub fn tick(ctx: Context<Tick>) -> Result<()> {
    let slot = Clock::get()?.slot;
    let mut t = ctx.accounts.table.load_mut()?;
    t.tick_calls = t.tick_calls.wrapping_add(1);
    // public gate: phase and slot only (one unsigned compare for "HIDE or LIVE", so both phases
    // take the same path)
    if t.phase.wrapping_sub(PH_HIDE) > PH_LIVE - PH_HIDE || slot < t.next_deadline_slot {
        return Ok(());
    }
    let was_hide = eq(t.phase as u64, PH_HIDE as u64);
    let mut out = ping_core::BeatOut::zeroed();
    {
        let mut b = ctx.accounts.book.load_mut()?;
        ping_core::tick::<SyscallHasher, ping_core::NoSink>(b.state_mut(), t.table_id, t.round, slot, &mut ping_core::NoSink, &mut out);
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
    t.commit_hash = if_mask(is_bell, &out.chain, &t.commit_hash);
    t.bell_slot = sel(is_bell, slot, t.bell_slot);
    t.hide_end_slot = sel(was_hide, slot, t.hide_end_slot);
    t.phase = out.phase;
    t.resolves = t.resolves.wrapping_add(1);
    t.next_deadline_slot = t.next_deadline_slot.saturating_add(t.beat_slots);
    Ok(())
}

fn if_mask(m: u64, a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let mut r = *b;
    ping_core::mask::sel_bytes(m, a, &mut r);
    r
}
