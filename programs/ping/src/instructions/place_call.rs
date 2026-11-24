//! Base: one spectator call of `Config.call_lamports` on desk `desk`, paid by the bettor into the
//! Tape. One per bettor per round (the Call PDA is `init`). Rejected at or after `Tape.close_unix`
//! and once the Tape is resolved.
use crate::constants::*;
use crate::errors::PingError;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_lang::system_program;

#[derive(Accounts)]
pub struct PlaceCall<'info> {
    #[account(mut)]
    pub bettor: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: AccountLoader<'info, Config>,
    #[account(mut, seeds = [TAPE_SEED, &tape.load()?.table_id.to_le_bytes(), &tape.load()?.round.to_le_bytes()], bump)]
    pub tape: AccountLoader<'info, Tape>,
    #[account(init, payer = bettor, space = CALL_SPACE, seeds = [CALL_SEED, tape.key().as_ref(), bettor.key().as_ref()], bump)]
    pub call: AccountLoader<'info, Call>,
    pub system_program: Program<'info, System>,
}

pub fn place_call(ctx: Context<PlaceCall>, desk: u8) -> Result<()> {
    require!((desk as usize) < NDESK, PingError::BadDesk);
    let amount = ctx.accounts.config.load()?.call_lamports;
    require!(amount > 0, PingError::BadParam);
    {
        let t = ctx.accounts.tape.load()?;
        require!(t.resolved == 0 && Clock::get()?.unix_timestamp < t.close_unix, PingError::CallsClosed);
    }
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.key(),
            system_program::Transfer { from: ctx.accounts.bettor.to_account_info(), to: ctx.accounts.tape.to_account_info() },
        ),
        amount,
    )?;
    {
        let mut t = ctx.accounts.tape.load_mut()?;
        let d = desk as usize;
        t.pool[d] = t.pool[d].checked_add(amount).ok_or(PingError::Overflow)?;
        t.total = t.total.checked_add(amount).ok_or(PingError::Overflow)?;
        t.n_calls = t.n_calls.checked_add(1).ok_or(PingError::Overflow)?;
        t.open_calls = t.open_calls.checked_add(1).ok_or(PingError::Overflow)?;
    }
    let mut c = ctx.accounts.call.load_init()?;
    c.amount = amount;
    c.owed = 0;
    c.tape = ctx.accounts.tape.key();
    c.bettor = ctx.accounts.bettor.key();
    c.desk = desk;
    c.claimed = 0;
    c.bump = ctx.bumps.call;
    c.layout = LAYOUT_VERSION;
    Ok(())
}
