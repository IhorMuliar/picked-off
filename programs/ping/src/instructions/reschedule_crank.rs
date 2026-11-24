//! Rollup: start a fresh crank task when the round's crank has stalled (squatted, dropped or
//! dead). House only; phase HIDE or LIVE; the current deadline must be at least `STALL_BEATS`
//! beats overdue (3 s at 1.5-s beats), so it never races a crank that is only catching up.
//! The new task id uses the same derivation as `open_round` with the current slot hash, so it is
//! fresh and not computable in advance; it replaces `Table.task_id` (which `reveal` and
//! `abort_round` cancel). An old task that is still alive only produces no-op ticks: the
//! deadline gate resolves each deadline once.
use crate::constants::*;
use crate::errors::PingError;
use crate::state::*;
use crate::utils::*;
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::consts::MAGIC_PROGRAM_ID;

#[derive(Accounts)]
pub struct RescheduleCrank<'info> {
    #[account(mut)]
    pub house: Signer<'info>,
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
    /// CHECK: magic program
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
    /// CHECK: slot hashes sysvar
    #[account(address = SLOT_HASHES_SYSVAR)]
    pub slot_hashes: UncheckedAccount<'info>,
}

pub fn reschedule_crank(ctx: Context<RescheduleCrank>) -> Result<()> {
    let slot = Clock::get()?.slot;
    let (table_id, round, old, interval, iterations, cu) = {
        let t = ctx.accounts.table.load()?;
        require_house(&t.house, &ctx.accounts.house.key())?;
        require!(t.phase == PH_HIDE || t.phase == PH_LIVE, PingError::BadPhase);
        let stalled_at = t.next_deadline_slot.saturating_add(STALL_BEATS.saturating_mul(t.beat_slots));
        require!(slot >= stalled_at, PingError::NotStalled);
        (t.table_id, t.round, t.task_id, t.crank_interval_ms, t.crank_iterations, t.tick_cu_limit)
    };
    let (task, _recent) = task_id(&ctx.accounts.slot_hashes.to_account_info(), table_id, round)?;
    require!(task != old, PingError::NotStalled);
    {
        let mut t = ctx.accounts.table.load_mut()?;
        t.task_id = task;
        t.task_slot = slot;
    }
    let a = &ctx.accounts;
    let pool = [
        a.table.to_account_info(),
        a.book.to_account_info(),
        a.desk0.to_account_info(),
        a.desk1.to_account_info(),
        a.desk2.to_account_info(),
        a.desk3.to_account_info(),
        a.desk4.to_account_info(),
        a.desk5.to_account_info(),
        a.desk6.to_account_info(),
        a.desk7.to_account_info(),
    ];
    // the crank CPI wants references that live as long as the account infos themselves
    let payer: &AccountInfo = Box::leak(Box::new(a.house.to_account_info()));
    let magic: &AccountInfo = Box::leak(Box::new(a.magic_program.to_account_info()));
    schedule_tick_crank(payer, magic, &pool, task, interval, iterations, cu)
}
