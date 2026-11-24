//! Constants and fixed-size state types. All types are `#[repr(C)]`, contain only `u8`/`u16`
//! fields and arrays, and have no padding, so they can live inside a zero-copy account (enable
//! the `bytemuck` feature for `Pod`/`Zeroable`).

/// Desks per table.
pub const DESKS: usize = 8;
/// Ladder levels, numbered 1..=LEVELS on the wire and in state (0 = none).
pub const LEVELS: usize = 24;
/// Stake per desk in tenths of a lot (10 lots).
pub const STAKE: u16 = 100;
/// Skim per fill in tenths: SKIM_STEP * (1 + min(streak, SKIM_STEPS - 1)) = 5, 10, 15.
pub const SKIM_STEP: u64 = 5;
pub const SKIM_STEPS: u64 = 3;
/// The algo pings a level the desk last pinged more than this many beats ago (or never).
pub const ALGO_MEMORY: u64 = 4;
/// The bell rings after live beat B, B uniform on BELL_MIN..BELL_MIN + BELL_SPAN - 1.
pub const BELL_MIN: u16 = 20;
pub const BELL_SPAN: u16 = 10;
pub const MAX_BEATS: usize = (BELL_MIN + BELL_SPAN - 1) as usize;
/// Action log: one row per live beat, two bytes per desk: (kind | ALGO_FLAG, level).
pub const LOG_ROW: usize = 2 * DESKS;
pub const LOG_LEN: usize = MAX_BEATS * LOG_ROW;
pub const ALGO_FLAG: u8 = 0x80;

/// `act` kinds (wire format). Anything else is a no-op.
pub const NOOP: u8 = 0;
pub const PING: u8 = 1;
/// Re-quote in LIVE; place in HIDE.
pub const REQUOTE: u8 = 2;

/// Phases.
pub const IDLE: u8 = 0;
pub const HIDE: u8 = 1;
pub const LIVE: u8 = 2;
pub const BELL: u8 = 3;

/// Per-desk result codes in [`DeskOut::result`].
pub const RES_NONE: u8 = 0;
pub const RES_MISS: u8 = 1;
pub const RES_FILL: u8 = 2;

/// Everything the engine needs for one round. Private until the bell.
#[repr(C)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[cfg_attr(feature = "bytemuck", derive(bytemuck::Pod, bytemuck::Zeroable))]
pub struct RoundState {
    /// Lots still resting on each desk's order, tenths.
    pub resting: [u16; DESKS],
    /// Lots each desk has picked off others, tenths (public every beat).
    pub picked: [u16; DESKS],
    /// Live beat of each desk's last FILL, 0 = never (tie-break).
    pub last_fill: [u16; DESKS],
    /// Live beat at which desk d last pinged level l, at `[d * LEVELS + l - 1]`; 0 = never.
    pub last_pinged: [u16; DESKS * LEVELS],
    /// Live beats resolved so far (live beats are numbered from 1).
    pub beat: u16,
    /// The live beat after which the bell rings (sealed).
    pub bell_beat: u16,
    /// Round seed, fixed at the end of HIDE.
    pub seed: [u8; 32],
    /// VRF output (valid when `vrf_set == 1`).
    pub vrf: [u8; 32],
    /// Accumulator of the HIDE-phase act salts.
    pub salt_acc: [u8; 32],
    /// Hash chain head over the seed and every beat's action row.
    pub chain: [u8; 32],
    /// Current level of each desk's order, 1..=24.
    pub level: [u8; DESKS],
    /// Level of each order at the end of HIDE.
    pub initial_level: [u8; DESKS],
    /// 1 if the desk placed its order during HIDE.
    pub placed: [u8; DESKS],
    /// Pending choice for the next beat: kind (0 none, PING, REQUOTE) and level.
    pub pending_kind: [u8; DESKS],
    pub pending_level: [u8; DESKS],
    /// The level the algo will ping for the desk next beat if it sends nothing.
    pub algo_next: [u8; DESKS],
    /// Consecutive fills by hunter h on victim v since v last moved, at `[h * DESKS + v]`.
    pub streak: [u8; DESKS * DESKS],
    /// Action log, `LOG_ROW` bytes per live beat (beat b at row b - 1).
    pub log: [u8; LOG_LEN],
    pub phase: u8,
    pub vrf_set: u8,
    /// 1 if the seed was drawn without a VRF output.
    pub fallback: u8,
    /// Top Desk, valid once `phase == BELL`.
    pub top_desk: u8,
}

pub const ROUND_STATE_SIZE: usize = 1144;
const _: () = assert!(core::mem::size_of::<RoundState>() == ROUND_STATE_SIZE);

impl RoundState {
    /// All zero (phase IDLE). Call [`crate::open_round`] to start a round.
    pub const fn zeroed() -> Self {
        RoundState {
            resting: [0; DESKS],
            picked: [0; DESKS],
            last_fill: [0; DESKS],
            last_pinged: [0; DESKS * LEVELS],
            beat: 0,
            bell_beat: 0,
            seed: [0; 32],
            vrf: [0; 32],
            salt_acc: [0; 32],
            chain: [0; 32],
            level: [0; DESKS],
            initial_level: [0; DESKS],
            placed: [0; DESKS],
            pending_kind: [0; DESKS],
            pending_level: [0; DESKS],
            algo_next: [0; DESKS],
            streak: [0; DESKS * DESKS],
            log: [0; LOG_LEN],
            phase: IDLE,
            vrf_set: 0,
            fallback: 0,
            top_desk: 0,
        }
    }
}

/// One resolved action.
#[repr(C)]
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
#[cfg_attr(feature = "bytemuck", derive(bytemuck::Pod, bytemuck::Zeroable))]
pub struct Action {
    /// NOOP, PING or REQUOTE.
    pub kind: u8,
    /// 1..=24.
    pub level: u8,
    /// 1 if the algo chose it (the desk sent nothing).
    pub algo: u8,
}

/// What one tick produced for one desk (private to that desk until the bell).
#[repr(C)]
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
#[cfg_attr(feature = "bytemuck", derive(bytemuck::Pod, bytemuck::Zeroable))]
pub struct DeskOut {
    pub resting: u16,
    pub picked: u16,
    /// Lots this desk's ping took this beat (sum over its victims).
    pub fill_amt: u16,
    /// Lots taken from this desk this beat.
    pub lost_amt: u16,
    /// Level after the beat.
    pub level: u8,
    /// The action resolved for this desk this beat (kind NOOP outside LIVE).
    pub action_kind: u8,
    pub action_level: u8,
    pub action_algo: u8,
    /// RES_NONE (no ping), RES_MISS or RES_FILL.
    pub result: u8,
    /// Desks this desk's ping filled against.
    pub victims: u8,
    /// Hunters that picked this desk off this beat.
    pub hits_taken: u8,
    /// Algo preview: the level the algo pings next beat if this desk sends nothing.
    pub next_algo: u8,
}

/// What one tick produced. Public fields: `picked`, `pings`, `fills`, `fill_amt` per desk (the
/// prints), `beat`, `phase`, `chain`, and after the bell `totals` and `top_desk`. Everything in
/// `desks` other than `picked` and `fill_amt` is private to its desk.
#[repr(C)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[cfg_attr(feature = "bytemuck", derive(bytemuck::Pod, bytemuck::Zeroable))]
pub struct BeatOut {
    pub desks: [DeskOut; DESKS],
    pub picked: [u16; DESKS],
    /// resting + picked per desk (the payout once the bell has rung).
    pub totals: [u16; DESKS],
    /// The live beat just resolved (0 for the HIDE-end tick).
    pub beat: u16,
    /// Pings resolved this beat and how many of them filled.
    pub pings: u8,
    pub fills: u8,
    /// Phase after this tick.
    pub phase: u8,
    /// Top Desk; meaningful when `phase == BELL`.
    pub top_desk: u8,
    pub chain: [u8; 32],
}

impl BeatOut {
    pub const fn zeroed() -> Self {
        const D: DeskOut = DeskOut {
            resting: 0,
            picked: 0,
            fill_amt: 0,
            lost_amt: 0,
            level: 0,
            action_kind: 0,
            action_level: 0,
            action_algo: 0,
            result: 0,
            victims: 0,
            hits_taken: 0,
            next_algo: 0,
        };
        BeatOut {
            desks: [D; DESKS],
            picked: [0; DESKS],
            totals: [0; DESKS],
            beat: 0,
            pings: 0,
            fills: 0,
            phase: 0,
            top_desk: 0,
            chain: [0; 32],
        }
    }
}

const _: () = assert!(core::mem::size_of::<DeskOut>() == 16);
const _: () = assert!(core::mem::size_of::<BeatOut>() == 16 * DESKS + 32 + 6 + 32);
