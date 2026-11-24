//! Rollup: seat a labelled house bot at desk `seat` of a house pool (empty or bot-held seats only).
//! House only. The Desk's permission is set to the bot key alone (flags 0).
use crate::constants::*;
use crate::errors::PingError;
use crate::state::*;
use crate::utils::*;
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID};

#[derive(Accounts)]
#[instruction(seat: u8)]
pub struct JoinBot<'info> {
    pub house: Signer<'info>,
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

pub fn join_bot(ctx: Context<JoinBot>, seat: u8, key: Pubkey, personality: u8, name: [u8; 16]) -> Result<()> {
    require!((seat as usize) < NDESK, PingError::BadSeat);
    require!(key != Pubkey::default(), PingError::BadKey);
    let (table_id, new_seat) = {
        let mut t = ctx.accounts.table.load_mut()?;
        require_house(&t.house, &ctx.accounts.house.key())?;
        require!(t.kind == TABLE_HOUSE, PingError::BadKind);
        let s = seat as usize;
        require!(t.seats[s].kind != SEAT_HUMAN, PingError::SeatTaken);
        for i in 0..NDESK {
            require!(i == s || t.seats[i].key != key, PingError::AlreadySeated);
        }
        t.seats[s] = Seat { key, name, kind: SEAT_BOT, personality, _pad: [0; 6] };
        t.sealed |= 1u16 << seat;
        (t.table_id, t.seats[s])
    };
    ctx.accounts.desk.load_mut()?.key = key;
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
