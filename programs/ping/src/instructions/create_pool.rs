//! Base: create a pool's Table (public row), Book (sealed book) and Ledger (base-only record
//! counter). House only. Desks come from `create_desk`; then each account is delegated.
use crate::constants::*;
use crate::errors::PingError;
use crate::state::*;
use crate::utils::*;
use anchor_lang::prelude::*;

#[derive(Accounts)]
#[instruction(table_id: u64)]
pub struct CreatePool<'info> {
    #[account(mut)]
    pub house: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: AccountLoader<'info, Config>,
    #[account(init, payer = house, space = TABLE_SPACE, seeds = [TABLE_SEED, &table_id.to_le_bytes()], bump)]
    pub table: AccountLoader<'info, Table>,
    #[account(init, payer = house, space = BOOK_SPACE, seeds = [BOOK_SEED, &table_id.to_le_bytes()], bump)]
    pub book: AccountLoader<'info, Book>,
    #[account(init, payer = house, space = LEDGER_SPACE, seeds = [LEDGER_SEED, &table_id.to_le_bytes()], bump)]
    pub ledger: AccountLoader<'info, Ledger>,
    pub system_program: Program<'info, System>,
}

/// `table_float`: extra lamports for the Table, which pays the Round commits on the rollup.
pub fn create_pool(ctx: Context<CreatePool>, table_id: u64, kind: u8, table_float: u64) -> Result<()> {
    let cfg = *ctx.accounts.config.load()?;
    require_keys_eq!(cfg.house, ctx.accounts.house.key(), PingError::NotHouse);
    require!(kind == TABLE_HOUSE || kind == TABLE_STAKED, PingError::BadKind);
    let rent = permission_rent();
    let house = ctx.accounts.house.to_account_info();
    let sys = ctx.accounts.system_program.to_account_info();
    transfer_from(&house, &ctx.accounts.table.to_account_info(), &sys, rent.checked_add(table_float).ok_or(PingError::Overflow)?)?;
    transfer_from(&house, &ctx.accounts.book.to_account_info(), &sys, rent)?;
    {
        let mut t = ctx.accounts.table.load_init()?;
        t.table_id = table_id;
        t.kind = kind;
        t.phase = PH_IDLE;
        t.top_desk = NO_DESK;
        t.house = cfg.house;
        t.vrf_queue = cfg.vrf_queue;
        t.beat_slots = cfg.beat_slots;
        t.hide_slots = cfg.hide_slots;
        t.crank_interval_ms = cfg.crank_interval_ms;
        t.crank_iterations = cfg.crank_iterations;
        t.tick_cu_limit = cfg.tick_cu_limit;
        t.bell_min = cfg.bell_min;
        t.bell_max = cfg.bell_max;
        t.bump = ctx.bumps.table;
        t.book_bump = ctx.bumps.book;
        t.layout = LAYOUT_VERSION;
    }
    {
        let mut b = ctx.accounts.book.load_init()?;
        b.table_id = table_id;
        // engine state stays all-zero (IDLE) until the first open_round
        b.layout = LAYOUT_VERSION;
    }
    let mut l = ctx.accounts.ledger.load_init()?;
    l.table_id = table_id;
    l.bump = ctx.bumps.ledger;
    l.layout = LAYOUT_VERSION;
    Ok(())
}
