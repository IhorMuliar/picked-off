//! Rollup: commit + undelegate one Round record, alone in its intent, paid by the delegated Table
//! through the validator fee vault. House only. Never an OPEN Round (one in play); the Table,
//! Book and Desks are never committed by any instruction.
use crate::constants::*;
use crate::errors::PingError;
use crate::state::*;
use crate::utils::*;
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::commit;
use ephemeral_rollups_sdk::ephem::{FoldableIntentBuilder, MagicIntentBundleBuilder};

#[commit]
#[derive(Accounts)]
#[instruction(round_no: u64)]
pub struct CommitRound<'info> {
    #[account(mut)]
    pub house: Signer<'info>,
    #[account(mut, seeds = [TABLE_SEED, &table.load()?.table_id.to_le_bytes()], bump = table.load()?.bump)]
    pub table: AccountLoader<'info, Table>,
    /// CHECK: the Round PDA (seeds checked; read by hand: it may already be undelegating)
    #[account(mut, seeds = [ROUND_SEED, &table.load()?.table_id.to_le_bytes(), &round_no.to_le_bytes()], bump)]
    pub round: UncheckedAccount<'info>,
    /// CHECK: validator fee vault (checked by the magic program)
    #[account(mut)]
    pub magic_fee_vault: UncheckedAccount<'info>,
}

pub fn commit_round(ctx: Context<CommitRound>, round_no: u64) -> Result<()> {
    let (table_id, bump) = {
        let t = ctx.accounts.table.load()?;
        require_house(&t.house, &ctx.accounts.house.key())?;
        (t.table_id, t.bump)
    };
    let r: Round = read_zc(&ctx.accounts.round.to_account_info())?;
    require!(r.table_id == table_id && r.round == round_no, PingError::BadRound);
    require!(r.status != RS_OPEN, PingError::RoundInPlay);
    let id = table_id.to_le_bytes();
    let bump_arr = [bump];
    let table_seeds: &[&[u8]] = &[TABLE_SEED, &id, &bump_arr];
    MagicIntentBundleBuilder::new(
        ctx.accounts.table.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .magic_fee_vault(ctx.accounts.magic_fee_vault.to_account_info())
    .commit_and_undelegate(&[ctx.accounts.round.to_account_info()])
    .build_and_invoke_signed(&[table_seeds])?;
    Ok(())
}
