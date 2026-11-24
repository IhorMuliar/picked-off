//! Rollup, after the bell: end the round. House only (it cancels the crank, whose authority is
//! the house). Cancels the crank (CancelCrankCpi with Table.task_id), fills the Round record of a
//! recorded round (required then): the engine's record bytes (seed, initial levels, bell beat,
//! action log), commit hash = the chain head, totals, Top Desk and its key, seat kinds, slots,
//! the fallback-seed flag; marks it REVEALED. The Table gets totals, Top Desk and commit hash,
//! phase REVEALED, and `sealed` is cleared so the next round must re-seal. The Book and Desks
//! are then made public with `unseal`. Anyone can check the record with `ping_core::verify`.
use crate::constants::*;
use crate::errors::PingError;
use crate::state::*;
use crate::utils::*;
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::consts::{MAGIC_CONTEXT_ID, MAGIC_PROGRAM_ID};

#[derive(Accounts)]
pub struct Reveal<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(mut, seeds = [TABLE_SEED, &table.load()?.table_id.to_le_bytes()], bump = table.load()?.bump)]
    pub table: AccountLoader<'info, Table>,
    #[account(mut, seeds = [BOOK_SEED, &table.load()?.table_id.to_le_bytes()], bump = table.load()?.book_bump)]
    pub book: AccountLoader<'info, Book>,
    #[account(mut, seeds = [ROUND_SEED, &table.load()?.table_id.to_le_bytes(), &table.load()?.round.to_le_bytes()], bump)]
    pub round: Option<AccountLoader<'info, Round>>,
    /// CHECK: magic context (crank task context)
    #[account(mut, address = MAGIC_CONTEXT_ID)]
    pub magic_context: UncheckedAccount<'info>,
    /// CHECK: magic program
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

pub fn reveal<'info>(ctx: Context<'info, Reveal<'info>>) -> Result<()> {
    let slot = Clock::get()?.slot;
    let task = {
        let t = ctx.accounts.table.load()?;
        require_house(&t.house, &ctx.accounts.caller.key())?;
        require!(t.phase == PH_BELL, PingError::BadPhase);
        require!(t.recorded == 0 || ctx.accounts.round.is_some(), PingError::NoRecord);
        t.task_id
    };
    cancel_crank(&ctx.accounts.caller, &ctx.accounts.magic_context, &ctx.accounts.magic_program, task)?;
    let mut t = ctx.accounts.table.load_mut()?;
    let b = ctx.accounts.book.load()?;
    let st = b.state();
    let mut totals = [0u16; NDESK];
    for s in 0..NDESK {
        totals[s] = st.resting[s].checked_add(st.picked[s]).ok_or(PingError::Overflow)?;
    }
    let top = if st.phase == ping_core::BELL { st.top_desk } else { NO_DESK };
    if let Some(rl) = &ctx.accounts.round {
        let mut r = rl.load_mut()?;
        require!(t.recorded == 1 && rl.key() == t.round_key && r.status == RS_OPEN, PingError::BadRound);
        r.hide_end_slot = t.hide_end_slot;
        r.bell_slot = t.bell_slot;
        r.reveal_slot = slot;
        r.commit_hash = st.chain;
        r.totals = totals;
        for s in 0..NDESK {
            r.seat_kind[s] = t.seats[s].kind;
        }
        r.kind = t.kind;
        r.top_desk = top;
        if (top as usize) < NDESK {
            r.top_key = t.seats[top as usize].key;
        }
        r.fallback_seed = st.fallback;
        r.n_beats = t.beat as u8;
        ping_core::RoundRecord::from_state(st, t.table_id, t.round).write(&mut r.record);
        r.status = RS_REVEALED;
    }
    t.totals = totals;
    t.top_desk = top;
    t.commit_hash = st.chain;
    t.reveal_slot = slot;
    t.phase = PH_REVEALED;
    t.sealed = 0;
    Ok(())
}
