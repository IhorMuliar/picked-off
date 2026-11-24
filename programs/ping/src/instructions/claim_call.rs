//! Base: pay one call to its bettor. Anyone may send it; the money only ever goes to `Call.bettor`
//! (the Call PDA is derived from the bettor account passed, and the stored bettor must match).
//!
//! Payout (Tape resolved):
//! - void Tape (aborted or never-played round, nobody called the Top Desk): `amount` (refund);
//! - call on the winner: `floor(amount * total / pool[winner])`, computed in u128;
//! - any other call: 0.
//! The floor remainder (`total - sum of winning payouts`, less than one lamport per winning call)
//! stays in the Tape and goes to the house with the Tape's rent in `close_round`.
//! An unsettled Tape becomes void `TAPE_REFUND_AFTER_SECS` after the close, so calls can always be
//! refunded if the Round never comes back to base.
//!
//! If the payout is not zero and would leave the bettor below the rent-exempt minimum for its data
//! size (read from the Rent sysvar; a 0-lamport burner), nothing moves: the amount is recorded in
//! `Call.owed`, the Call stays open and the instruction succeeds. A later claim, once the bettor
//! holds enough, pays it. A paid claim closes the Call, returning its rent to the bettor, so a
//! second claim finds no Call and pays nothing.
use crate::constants::*;
use crate::errors::PingError;
use crate::state::*;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct ClaimCall<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(mut, seeds = [TAPE_SEED, &tape.load()?.table_id.to_le_bytes(), &tape.load()?.round.to_le_bytes()], bump)]
    pub tape: AccountLoader<'info, Tape>,
    #[account(mut, seeds = [CALL_SEED, tape.key().as_ref(), bettor.key().as_ref()], bump)]
    pub call: AccountLoader<'info, Call>,
    /// CHECK: must equal Call.bettor (checked in the handler)
    #[account(mut)]
    pub bettor: UncheckedAccount<'info>,
}

pub fn claim_call(ctx: Context<ClaimCall>) -> Result<()> {
    let tape_key = ctx.accounts.tape.key();
    let bettor_info = ctx.accounts.bettor.to_account_info();
    let tape_info = ctx.accounts.tape.to_account_info();
    let rent = Rent::get()?;
    let now = Clock::get()?.unix_timestamp;
    // read before the loads below: data_len() borrows the account data
    let tape_floor = rent.minimum_balance(tape_info.data_len());
    let bettor_floor = rent.minimum_balance(bettor_info.data_len());

    let payout = {
        let mut t = ctx.accounts.tape.load_mut()?;
        let mut c = ctx.accounts.call.load_mut()?;
        require_keys_eq!(c.bettor, bettor_info.key(), PingError::BadAccount);
        require_keys_eq!(c.tape, tape_key, PingError::BadAccount);
        require!(c.claimed == 0, PingError::BadAccount);
        if t.resolved == 0 {
            let refund_at = t.close_unix.checked_add(TAPE_REFUND_AFTER_SECS).ok_or(PingError::Overflow)?;
            require!(now >= refund_at, PingError::NotSettled);
            t.resolved = 1;
            t.void = 1;
        }
        let payout: u64 = if t.void != 0 {
            c.amount
        } else if c.desk == t.winner {
            let p = (c.amount as u128)
                .checked_mul(t.total as u128)
                .and_then(|x| x.checked_div(t.pool[t.winner as usize] as u128))
                .ok_or(PingError::Overflow)?;
            u64::try_from(p).map_err(|_| PingError::Overflow)?
        } else {
            0
        };
        // never pay out more than was called, nor take the Tape below its own rent minimum
        let paid = t.paid.checked_add(payout).ok_or(PingError::Overflow)?;
        require!(paid <= t.total, PingError::Insolvent);
        require!(tape_info.lamports().checked_sub(payout).ok_or(PingError::Insolvent)? >= tape_floor, PingError::Insolvent);

        let after = bettor_info.lamports().checked_add(payout).ok_or(PingError::Overflow)?;
        if payout > 0 && after < bettor_floor {
            // skip and owe: sending it would fail the whole transaction
            c.owed = payout;
            return Ok(());
        }
        // mark done before any lamports move
        c.owed = 0;
        c.claimed = 1;
        t.paid = paid;
        t.open_calls = t.open_calls.checked_sub(1).ok_or(PingError::Overflow)?;
        payout
    };
    if payout > 0 {
        let mut from = tape_info.try_borrow_mut_lamports()?;
        let mut to = bettor_info.try_borrow_mut_lamports()?;
        **from = from.checked_sub(payout).ok_or(PingError::Insolvent)?;
        **to = to.checked_add(payout).ok_or(PingError::Overflow)?;
    }
    ctx.accounts.call.close(bettor_info)
}
