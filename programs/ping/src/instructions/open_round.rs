//! Rollup: open round `round_no` of a pool. House only. Requires the Book and all eight Desks
//! re-sealed since the last reveal (Table.sealed == SEAL_ALL); then resets every private field
//! of the Book and the Desks (nothing of the previous round survives except `Desk.last_seq`),
//! starts HIDE, requests the round's VRF on the rollup queue, and schedules the tick crank with a
//! task id that mixes in the current slot hash. A recorded round passes its Round record, which
//! must be unopened and whose planned start must have passed.
use crate::constants::*;
use crate::errors::PingError;
use crate::state::*;
use crate::utils::*;
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::vrf;
use ephemeral_rollups_sdk::consts::MAGIC_PROGRAM_ID;
use ephemeral_rollups_sdk::vrf::instructions::{create_request_high_priority_scoped_randomness_ix, RequestRandomnessParams};
use ephemeral_rollups_sdk::vrf::types::SerializableAccountMeta;

#[vrf]
#[derive(Accounts)]
#[instruction(round_no: u64)]
pub struct OpenRound<'info> {
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
    #[account(mut, seeds = [ROUND_SEED, &table.load()?.table_id.to_le_bytes(), &round_no.to_le_bytes()], bump)]
    pub round: Option<AccountLoader<'info, Round>>,
    /// CHECK: must be Table.vrf_queue when VRF is enabled; ignored otherwise
    #[account(mut)]
    pub oracle_queue: UncheckedAccount<'info>,
    /// CHECK: magic program
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

fn reset_desk(d: &mut Desk, round: u64) {
    let (table_id, index, key, last_seq) = (d.table_id, d.index, d.key, d.last_seq);
    *d = bytemuck::Zeroable::zeroed();
    d.table_id = table_id;
    d.index = index;
    d.key = key;
    d.last_seq = last_seq;
    d.round = round;
    d.resting = STAKE_TENTHS;
    d.phase = PH_HIDE;
    d.layout = LAYOUT_VERSION;
}

pub fn open_round<'info>(ctx: Context<'info, OpenRound<'info>>, round_no: u64) -> Result<()> {
    let clock = Clock::get()?;
    let slot = clock.slot;
    let (table_id, vrf_queue, interval, iterations, cu) = {
        let t = ctx.accounts.table.load()?;
        require_house(&t.house, &ctx.accounts.house.key())?;
        require!(t.phase == PH_IDLE || t.phase == PH_REVEALED || t.phase == PH_ABORTED, PingError::BadPhase);
        require!(t.sealed == SEAL_ALL, PingError::NotSealed);
        require!(round_no == t.round.checked_add(1).ok_or(PingError::Overflow)?, PingError::BadRound);
        (t.table_id, t.vrf_queue, t.crank_interval_ms, t.crank_iterations, t.tick_cu_limit)
    };
    let (recorded, round_key, planned) = match &ctx.accounts.round {
        Some(rl) => {
            let mut r = rl.load_mut()?;
            require!(r.table_id == table_id && r.round == round_no, PingError::BadRound);
            require!(r.status == RS_CREATED, PingError::BadPhase);
            require!(clock.unix_timestamp >= r.planned_start_unix, PingError::TooEarly);
            r.status = RS_OPEN;
            r.open_slot = slot;
            (1u8, rl.key(), r.planned_start_unix)
        }
        None => (0u8, Pubkey::default(), clock.unix_timestamp),
    };
    let (task, _recent) = task_id(&ctx.accounts.slot_hashes.to_account_info(), table_id, round_no)?;
    {
        let mut t = ctx.accounts.table.load_mut()?;
        t.round = round_no;
        t.phase = PH_HIDE;
        t.beat = 0;
        t.open_slot = slot;
        t.hide_end_slot = 0;
        t.next_deadline_slot = slot.saturating_add(t.hide_slots);
        t.bell_slot = 0;
        t.reveal_slot = 0;
        t.task_id = task;
        t.task_slot = slot;
        t.tick_calls = 0;
        t.resolves = 0;
        t.vrf_request_slot = 0;
        t.vrf_fulfil_slot = 0;
        t.vrf_fulfils = 0;
        t.planned_start_unix = planned;
        t.round_key = round_key;
        t.recorded = recorded;
        t.chain_head = [0; 32];
        t.commit_hash = [0; 32];
        t.picked = [0; NDESK];
        t.totals = [0; NDESK];
        t.beat_fill = [0; NDESK];
        t.prints = bytemuck::Zeroable::zeroed();
        t.print_count = 0;
        t.beat_counts = [[0; 2]; BEAT_SLOTS_RING];
        t.top_desk = NO_DESK;
        t.fallback_seed = 0;
    }
    {
        let mut b = ctx.accounts.book.load_mut()?;
        b.table_id = table_id;
        b.round = round_no;
        b.vrf_slot = 0;
        b._r0 = 0;
        b.layout = LAYOUT_VERSION;
        b._pad = [0; 7];
        b._reserved = [0; 64];
        // every engine field back to its initial value, phase HIDE
        ping_core::open_round(b.state_mut());
    }
    let a = &ctx.accounts;
    for dl in [&a.desk0, &a.desk1, &a.desk2, &a.desk3, &a.desk4, &a.desk5, &a.desk6, &a.desk7] {
        reset_desk(&mut *dl.load_mut()?, round_no);
    }
    if vrf_queue != Pubkey::default() {
        require_keys_eq!(a.oracle_queue.key(), vrf_queue, PingError::BadAccount);
        let mut caller_seed = [0u8; 32];
        caller_seed[0..8].copy_from_slice(&task.to_le_bytes());
        caller_seed[8..16].copy_from_slice(&round_no.to_le_bytes());
        let ix = create_request_high_priority_scoped_randomness_ix(RequestRandomnessParams {
            payer: a.house.key(),
            oracle_queue: a.oracle_queue.key(),
            callback_program_id: crate::ID,
            callback_discriminator: crate::instruction::VrfCallback::DISCRIMINATOR.to_vec(),
            caller_seed,
            accounts_metas: Some(vec![
                SerializableAccountMeta { pubkey: a.table.key(), is_signer: false, is_writable: true },
                SerializableAccountMeta { pubkey: a.book.key(), is_signer: false, is_writable: true },
            ]),
            ..Default::default()
        });
        a.invoke_signed_vrf(&a.house.to_account_info(), &ix)?;
        a.table.load_mut()?.vrf_request_slot = slot;
    }
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
    schedule_tick_crank(&ctx.accounts.house, &ctx.accounts.magic_program, &pool, task, interval, iterations, cu)
}
