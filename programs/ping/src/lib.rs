//! Picked Off (codename Ping): eight desks hide orders on a dark 24-level book; pings find them.
//! Runs on a MagicBlock Private Ephemeral Rollup: the public Table, the sealed Book and the eight
//! private Desks live on the rollup; Config, records' settlement and the Tape live on Solana.
//! Account layouts: state.rs (byte offsets in docs/LAYOUT.md).
#![allow(unexpected_cfgs)]
#![allow(deprecated)]
// instruction modules re-export their Accounts structs (and handlers) for #[program]
#![allow(ambiguous_glob_reexports)]

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::ephemeral;

pub mod constants;
pub mod errors;
pub mod instructions;
pub mod state;
pub mod utils;
#[cfg(test)]
mod layout_doc;

pub use instructions::*;

declare_id!("5eP2A36T97mwaGHf6XoHZU6VoKh1NGxA2QwvtJhAJ6ms");

#[cfg(all(target_os = "solana", feature = "custom-panic"))]
#[no_mangle]
fn custom_panic(_: &core::panic::PanicInfo<'_>) {}

#[ephemeral]
#[program]
pub mod ping {
    use super::*;

    // ------------------------------------------------------------------ base layer
    pub fn init_config(ctx: Context<InitConfig>, params: ConfigParams) -> Result<()> {
        instructions::init_config::init_config(ctx, params)
    }
    pub fn update_config(ctx: Context<UpdateConfig>, params: ConfigParams) -> Result<()> {
        instructions::init_config::update_config(ctx, params)
    }
    pub fn create_pool(ctx: Context<CreatePool>, table_id: u64, kind: u8, table_float: u64) -> Result<()> {
        instructions::create_pool::create_pool(ctx, table_id, kind, table_float)
    }
    pub fn create_desk(ctx: Context<CreateDesk>, table_id: u64, index: u8) -> Result<()> {
        instructions::create_desk::create_desk(ctx, table_id, index)
    }
    pub fn delegate(ctx: Context<DelegatePda>, kind: u8, table_id: u64, index: u64) -> Result<()> {
        instructions::delegate::delegate(ctx, kind, table_id, index)
    }
    pub fn create_record(ctx: Context<CreateRecord>, table_id: u64, round_no: u64, planned_start_unix: i64) -> Result<()> {
        instructions::create_record::create_record(ctx, table_id, round_no, planned_start_unix)
    }
    pub fn settle_round(ctx: Context<SettleRound>) -> Result<()> {
        instructions::settle_round::settle_round(ctx)
    }
    pub fn place_call(ctx: Context<PlaceCall>, desk: u8) -> Result<()> {
        instructions::place_call::place_call(ctx, desk)
    }
    pub fn claim_call(ctx: Context<ClaimCall>) -> Result<()> {
        instructions::claim_call::claim_call(ctx)
    }
    pub fn close_round(ctx: Context<CloseRound>) -> Result<()> {
        instructions::close_round::close_round(ctx)
    }

    // ------------------------------------------------------------------ rollup
    pub fn setup_permissions(ctx: Context<SetupPermissions>, kind: u8, index: u64) -> Result<()> {
        instructions::setup_permissions::setup_permissions(ctx, kind, index)
    }
    pub fn join_bot(ctx: Context<JoinBot>, seat: u8, key: Pubkey, personality: u8, name: [u8; 16]) -> Result<()> {
        instructions::join_bot::join_bot(ctx, seat, key, personality, name)
    }
    pub fn join(ctx: Context<Join>, seat: u8, name: [u8; 16]) -> Result<()> {
        instructions::join::join(ctx, seat, name)
    }
    pub fn open_round<'info>(ctx: Context<'info, OpenRound<'info>>, round_no: u64) -> Result<()> {
        instructions::open_round::open_round(ctx, round_no)
    }
    pub fn act(ctx: Context<Act>, kind: u8, level: u8, seq: u32, salt: [u8; 16]) -> Result<()> {
        instructions::act::act(ctx, kind, level, seq, salt)
    }
    pub fn vrf_callback(ctx: Context<VrfCallback>, randomness: [u8; 32]) -> Result<()> {
        instructions::vrf_callback::vrf_callback(ctx, randomness)
    }
    pub fn tick(ctx: Context<Tick>) -> Result<()> {
        instructions::tick::tick(ctx)
    }
    pub fn reschedule_crank(ctx: Context<RescheduleCrank>) -> Result<()> {
        instructions::reschedule_crank::reschedule_crank(ctx)
    }
    pub fn reveal<'info>(ctx: Context<'info, Reveal<'info>>) -> Result<()> {
        instructions::reveal::reveal(ctx)
    }
    pub fn unseal(ctx: Context<Unseal>, kind: u8, index: u64) -> Result<()> {
        instructions::unseal::unseal(ctx, kind, index)
    }
    pub fn abort_round<'info>(ctx: Context<'info, AbortRound<'info>>) -> Result<()> {
        instructions::abort_round::abort_round(ctx)
    }
    pub fn commit_round(ctx: Context<CommitRound>, round_no: u64) -> Result<()> {
        instructions::commit_round::commit_round(ctx, round_no)
    }
    pub fn version(ctx: Context<Version>) -> Result<()> {
        instructions::version::version(ctx)
    }
}
