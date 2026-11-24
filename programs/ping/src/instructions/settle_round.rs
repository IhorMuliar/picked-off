//! Base: resolve a round's Tape from its Round record. Anyone may send it; it moves no lamports.
//! The Round must be back on base (owned by this program, so committed and undelegated, or never
//! delegated) and finished: REVEALED sets the winner; ABORTED, or CREATED once calls have closed
//! (a record that was never played), makes the Tape void. A REVEALED round whose Top Desk nobody
//! called is void too. Idempotent: a resolved Tape is left unchanged.
use crate::constants::*;
use crate::errors::PingError;
use crate::state::*;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct SettleRound<'info> {
    pub caller: Signer<'info>,
    #[account(seeds = [ROUND_SEED, &round.load()?.table_id.to_le_bytes(), &round.load()?.round.to_le_bytes()], bump)]
    pub round: AccountLoader<'info, Round>,
    #[account(mut, seeds = [TAPE_SEED, &round.load()?.table_id.to_le_bytes(), &round.load()?.round.to_le_bytes()], bump)]
    pub tape: AccountLoader<'info, Tape>,
}

pub fn settle_round(ctx: Context<SettleRound>) -> Result<()> {
    let r = ctx.accounts.round.load()?;
    let mut t = ctx.accounts.tape.load_mut()?;
    if t.resolved != 0 {
        return Ok(());
    }
    let void = match r.status {
        RS_REVEALED => {
            let w = r.top_desk;
            t.winner = w;
            (w as usize) >= NDESK || t.pool[w as usize] == 0
        }
        RS_ABORTED => true,
        RS_CREATED => {
            require!(Clock::get()?.unix_timestamp >= t.close_unix, PingError::TooEarly);
            true
        }
        _ => return err!(PingError::RoundInPlay),
    };
    t.void = void as u8;
    t.resolved = 1;
    Ok(())
}
