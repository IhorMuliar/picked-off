//! Base: create the Config once (admin), or change its parameters (admin). Pools copy the
//! parameters they need at creation, so a change affects pools created afterwards.
use crate::constants::*;
use crate::errors::PingError;
use crate::state::*;
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::vrf::consts::{DEFAULT_EPHEMERAL_QUEUE, DEFAULT_EPHEMERAL_TEST_QUEUE};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct ConfigParams {
    pub house: Pubkey,
    pub tee_validator: Pubkey,
    /// DEFAULT_EPHEMERAL_QUEUE on devnet; all-zero disables VRF (local only).
    pub vrf_queue: Pubkey,
    pub beat_slots: u64,
    pub hide_slots: u64,
    pub call_lamports: u64,
    pub lot_lamports: u64,
    pub crank_interval_ms: u32,
    pub crank_iterations: u32,
    pub tick_cu_limit: u32,
    pub act_interval_ms: u32,
    pub hide_secs: u32,
    pub tape_close_secs: u32,
    pub bell_min: u8,
    pub bell_max: u8,
    pub algo_memory: u8,
    pub tape_close_beat: u8,
}

fn apply(c: &mut Config, p: &ConfigParams) -> Result<()> {
    require!(p.tee_validator == TEE_VALIDATOR || p.tee_validator == LOCAL_VALIDATOR, PingError::BadValidator);
    require!(
        p.vrf_queue == DEFAULT_EPHEMERAL_QUEUE || p.vrf_queue == DEFAULT_EPHEMERAL_TEST_QUEUE || p.vrf_queue == Pubkey::default(),
        PingError::BadParam
    );
    require!(p.house != Pubkey::default(), PingError::BadParam);
    require!(p.beat_slots >= 1 && p.beat_slots <= 10_000 && p.hide_slots >= 1 && p.hide_slots <= 100_000, PingError::BadParam);
    require!(p.crank_interval_ms >= 10 && p.crank_iterations >= 1 && p.tick_cu_limit >= 10_000 && p.tick_cu_limit <= 1_400_000, PingError::BadParam);
    require!(p.bell_min >= 1 && p.bell_min <= p.bell_max && (p.bell_max as usize) <= MAX_LIVE_BEATS, PingError::BadParam);
    c.house = p.house;
    c.tee_validator = p.tee_validator;
    c.vrf_queue = p.vrf_queue;
    c.beat_slots = p.beat_slots;
    c.hide_slots = p.hide_slots;
    c.call_lamports = p.call_lamports;
    c.lot_lamports = p.lot_lamports;
    c.crank_interval_ms = p.crank_interval_ms;
    c.crank_iterations = p.crank_iterations;
    c.tick_cu_limit = p.tick_cu_limit;
    c.act_interval_ms = p.act_interval_ms;
    c.hide_secs = p.hide_secs;
    c.tape_close_secs = p.tape_close_secs;
    c.bell_min = p.bell_min;
    c.bell_max = p.bell_max;
    c.algo_memory = p.algo_memory;
    c.tape_close_beat = p.tape_close_beat;
    c.skim = [SKIM[0] as u8, SKIM[1] as u8, SKIM[2] as u8];
    c.n_desks = NDESK as u8;
    c.levels = LEVELS as u8;
    c.layout = LAYOUT_VERSION;
    Ok(())
}

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = CONFIG_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: AccountLoader<'info, Config>,
    pub system_program: Program<'info, System>,
}

pub fn init_config(ctx: Context<InitConfig>, params: ConfigParams) -> Result<()> {
    require!(ADMINS.contains(&ctx.accounts.admin.key()), PingError::NotAdmin);
    let mut c = ctx.accounts.config.load_init()?;
    c.admin = ctx.accounts.admin.key();
    c.bump = ctx.bumps.config;
    apply(&mut c, &params)
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump)]
    pub config: AccountLoader<'info, Config>,
}

pub fn update_config(ctx: Context<UpdateConfig>, params: ConfigParams) -> Result<()> {
    let mut c = ctx.accounts.config.load_mut()?;
    require_keys_eq!(c.admin, ctx.accounts.admin.key(), PingError::NotAdmin);
    apply(&mut c, &params)
}
