//! Rollup: call off the round in play (HIDE, LIVE or BELL): cancel its crank, phase ABORTED, the
//! Round record (if any) ABORTED so its Tape refunds. Nothing is made public: the Book and Desks
//! stay sealed and the next `open_round` resets them. House only.
use crate::constants::*;
use crate::errors::PingError;
use crate::state::*;
use crate::utils::*;
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::consts::{MAGIC_CONTEXT_ID, MAGIC_PROGRAM_ID};

#[derive(Accounts)]
pub struct AbortRound<'info> {
    #[account(mut)]
    pub house: Signer<'info>,
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

pub fn abort_round<'info>(ctx: Context<'info, AbortRound<'info>>) -> Result<()> {
    let slot = Clock::get()?.slot;
    let task = {
        let t = ctx.accounts.table.load()?;
        require_house(&t.house, &ctx.accounts.house.key())?;
        require!(t.phase == PH_HIDE || t.phase == PH_LIVE || t.phase == PH_BELL, PingError::BadPhase);
        t.task_id
    };
    cancel_crank(&ctx.accounts.house, &ctx.accounts.magic_context, &ctx.accounts.magic_program, task)?;
    let mut t = ctx.accounts.table.load_mut()?;
    if let Some(rl) = &ctx.accounts.round {
        let mut r = rl.load_mut()?;
        require!(t.recorded == 1 && rl.key() == t.round_key && r.status == RS_OPEN, PingError::BadRound);
        r.status = RS_ABORTED;
        r.reveal_slot = slot;
        r.n_beats = t.beat as u8;
        r.kind = t.kind;
    }
    t.phase = PH_ABORTED;
    t.reveal_slot = slot;
    Ok(())
}
