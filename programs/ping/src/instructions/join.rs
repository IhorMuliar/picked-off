//! Rollup: a player's burner takes desk `seat` of a house pool. Rules:
//! - house pools only (staked tables seat by ticket, never by `join`);
//! - the seat is empty or held by a house bot, never by a human;
//! - one desk per key per pool (the key may not already sit at any seat of this table);
//! - phase IDLE, HIDE, LIVE or REVEALED. Mid-round the burner takes the desk over as it stands:
//!   its order, lots and this round's results become the burner's. Refused in BELL (the round is
//!   decided and waits for the reveal) and ABORTED.
//! The seat becomes the burner's (kind human, its name), the Desk key is the burner, and the Desk
//! permission is set to that one member with flags 0, in the same transaction: from then on the
//! previous key can neither read the Desk nor act for it (its acts fail the key check and are
//! no-ops). `Desk.last_seq` restarts at 0 for the new key, so a previous holder that pushed it
//! to `u32::MAX` cannot leave the desk unable to act. Nothing here touches the Book, so a
//! takeover changes no hidden state and no compute cost of `act` or `tick`.
use crate::constants::*;
use crate::errors::PingError;
use crate::state::*;
use crate::utils::*;
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID};

#[derive(Accounts)]
#[instruction(seat: u8)]
pub struct Join<'info> {
    pub player: Signer<'info>,
    #[account(mut, seeds = [TABLE_SEED, &table.load()?.table_id.to_le_bytes()], bump = table.load()?.bump)]
    pub table: AccountLoader<'info, Table>,
    #[account(mut, seeds = [DESK_SEED, &table.load()?.table_id.to_le_bytes(), &[seat]], bump)]
    pub desk: AccountLoader<'info, Desk>,
    /// CHECK: permission PDA of the target (checked against EphemeralPermission::find_pda)
    #[account(mut)]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: permission program
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: ephemeral rent vault
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: magic program
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

pub fn join(ctx: Context<Join>, seat: u8, name: [u8; 16]) -> Result<()> {
    require!((seat as usize) < NDESK, PingError::BadSeat);
    let key = ctx.accounts.player.key();
    require!(key != Pubkey::default(), PingError::BadKey);
    let (table_id, new_seat) = {
        let mut t = ctx.accounts.table.load_mut()?;
        require!(t.kind == TABLE_HOUSE, PingError::BadKind);
        require!(t.phase == PH_IDLE || t.phase == PH_HIDE || t.phase == PH_LIVE || t.phase == PH_REVEALED, PingError::BadPhase);
        let s = seat as usize;
        require!(t.seats[s].kind == SEAT_EMPTY || t.seats[s].kind == SEAT_BOT, PingError::SeatTaken);
        for i in 0..NDESK {
            require!(t.seats[i].key != key, PingError::AlreadySeated);
        }
        t.seats[s] = Seat { key, name, kind: SEAT_HUMAN, personality: 0, _pad: [0; 6] };
        t.sealed |= 1u16 << seat;
        (t.table_id, t.seats[s])
    };
    {
        let mut d = ctx.accounts.desk.load_mut()?;
        require!(d.table_id == table_id && d.index == seat, PingError::BadAccount);
        // a new key starts its own seq run (the old key's acts already fail the key check)
        d.last_seq = 0;
        d.key = key;
    }
    let seeds = account_seeds(KIND_DESK, table_id, seat as u64)?;
    let a = &ctx.accounts;
    set_permission(
        &a.desk.to_account_info(),
        &a.permission.to_account_info(),
        &a.ephemeral_vault.to_account_info(),
        &a.magic_program.to_account_info(),
        &a.permission_program.to_account_info(),
        &seeds,
        true,
        desk_members(&new_seat),
    )
}
