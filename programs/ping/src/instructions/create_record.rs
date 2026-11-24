//! Base: create the Round record and its Tape for round `round_no` of a pool. House only.
//! Send `delegate(KIND_ROUND, table_id, round_no)` in the same transaction.
use crate::constants::*;
use crate::errors::PingError;
use crate::state::*;
use anchor_lang::prelude::*;

#[derive(Accounts)]
#[instruction(table_id: u64, round_no: u64)]
pub struct CreateRecord<'info> {
    #[account(mut)]
    pub house: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: AccountLoader<'info, Config>,
    #[account(mut, seeds = [LEDGER_SEED, &table_id.to_le_bytes()], bump)]
    pub ledger: AccountLoader<'info, Ledger>,
    #[account(init, payer = house, space = ROUND_SPACE, seeds = [ROUND_SEED, &table_id.to_le_bytes(), &round_no.to_le_bytes()], bump)]
    pub round: AccountLoader<'info, Round>,
    #[account(init, payer = house, space = TAPE_SPACE, seeds = [TAPE_SEED, &table_id.to_le_bytes(), &round_no.to_le_bytes()], bump)]
    pub tape: AccountLoader<'info, Tape>,
    pub system_program: Program<'info, System>,
}

pub fn create_record(ctx: Context<CreateRecord>, table_id: u64, round_no: u64, planned_start_unix: i64) -> Result<()> {
    let cfg = *ctx.accounts.config.load()?;
    require_keys_eq!(cfg.house, ctx.accounts.house.key(), PingError::NotHouse);
    {
        let mut l = ctx.accounts.ledger.load_mut()?;
        // record numbers only go up, so a closed (table, round) can never be recreated
        require!(round_no > l.last_record_round, PingError::BadRound);
        l.last_record_round = round_no;
        l.records = l.records.checked_add(1).ok_or(PingError::Overflow)?;
    }
    {
        let mut r = ctx.accounts.round.load_init()?;
        r.table_id = table_id;
        r.round = round_no;
        r.planned_start_unix = planned_start_unix;
        r.status = RS_CREATED;
        r.top_desk = NO_DESK;
        r.bump = ctx.bumps.round;
        r.layout = LAYOUT_VERSION;
        // the record payload starts with (table_id, round): written now so the reveal's diff is smaller
        r.record[0..8].copy_from_slice(&table_id.to_le_bytes());
        r.record[8..16].copy_from_slice(&round_no.to_le_bytes());
    }
    let mut t = ctx.accounts.tape.load_init()?;
    t.table_id = table_id;
    t.round = round_no;
    t.close_unix = planned_start_unix
        .checked_add(cfg.hide_secs as i64)
        .and_then(|x| x.checked_add(cfg.tape_close_secs as i64))
        .ok_or(PingError::Overflow)?;
    t.winner = NO_DESK;
    t.bump = ctx.bumps.tape;
    t.layout = LAYOUT_VERSION;
    Ok(())
}
