//! Account layouts. All program accounts are zero-copy `#[repr(C)]` structs with explicit padding
//! and a fixed size checked at compile time; clients decode them by offset (docs/LAYOUT.md).
//! Every account ends in a reserved tail so later fields can be added without moving offsets.
use crate::constants::*;
use anchor_lang::prelude::*;

/// Base layer, never delegated. Seeds `["config"]`.
#[account(zero_copy)]
pub struct Config {
    /// Slots per live beat on this network (devnet-tee 150 = 1.5 s).
    pub beat_slots: u64,
    /// Slots of the HIDE phase (devnet-tee 500 = 5 s).
    pub hide_slots: u64,
    /// Lamports of one Tape call (0.01 SOL).
    pub call_lamports: u64,
    /// Lamports per lot at staked tables (0.001 SOL).
    pub lot_lamports: u64,
    pub crank_interval_ms: u32,
    /// Iterations of one round's crank task.
    pub crank_iterations: u32,
    /// Compute-unit limit of the scheduled tick transaction.
    pub tick_cu_limit: u32,
    /// Client cadence of `act` (hint for clients and bots).
    pub act_interval_ms: u32,
    /// HIDE length in seconds (base-layer clock, for the Tape close time).
    pub hide_secs: u32,
    /// Tape closes this many seconds after the planned live start.
    pub tape_close_secs: u32,
    pub admin: Pubkey,
    /// House authority: signs every privileged instruction.
    pub house: Pubkey,
    /// Validator every delegation is pinned to.
    pub tee_validator: Pubkey,
    /// Rollup VRF queue; all-zero = VRF disabled (local test configs only; rounds use the fallback seed).
    pub vrf_queue: Pubkey,
    /// Skim per consecutive FILL, tenths.
    pub skim: [u8; 3],
    pub bell_min: u8,
    pub bell_max: u8,
    /// Algo pings avoid levels the desk pinged in the last `algo_memory` beats.
    pub algo_memory: u8,
    pub tape_close_beat: u8,
    pub n_desks: u8,
    pub levels: u8,
    pub bump: u8,
    pub layout: u8,
    pub _pad: [u8; 5],
    pub _reserved: [u8; 64],
}

/// One seat of the public Table row.
#[zero_copy]
pub struct Seat {
    /// Seated key (burner or bot key); all-zero when empty.
    pub key: Pubkey,
    /// Display name, UTF-8, zero padded.
    pub name: [u8; 16],
    /// SEAT_EMPTY / SEAT_HUMAN / SEAT_BOT.
    pub kind: u8,
    /// Bot personality (0 none, 1 Shark, 2 Ghost, 3 Minnow).
    pub personality: u8,
    pub _pad: [u8; 6],
}

/// One public print: "DESK filled X · price withheld".
#[zero_copy]
pub struct Print {
    pub tenths: u16,
    /// Live beat of the fill.
    pub beat: u16,
    pub desk: u8,
    pub _pad: u8,
}

/// Public table row. Created on base, delegated once, never committed. Seeds `["table", t u64le]`.
#[account(zero_copy)]
pub struct Table {
    pub table_id: u64,
    /// Current (or last) round number; strictly increasing, 0 before the first round.
    pub round: u64,
    pub open_slot: u64,
    pub hide_end_slot: u64,
    /// The next deadline resolves at the first tick with slot >= this.
    pub next_deadline_slot: u64,
    pub bell_slot: u64,
    pub reveal_slot: u64,
    /// This round's crank task id (derived on-chain from the slot hash).
    pub task_id: i64,
    pub task_slot: u64,
    /// Every tick call, resolving or not (liveness).
    pub tick_calls: u64,
    /// Resolved deadlines this round (HIDE end + live beats).
    pub resolves: u64,
    pub vrf_request_slot: u64,
    pub vrf_fulfil_slot: u64,
    /// Planned start of the round (unix s): the Round's when recorded, else the open time.
    pub planned_start_unix: i64,
    /// Copies of Config at pool creation (the rollup never reads Config).
    pub beat_slots: u64,
    pub hide_slots: u64,
    pub crank_interval_ms: u32,
    pub crank_iterations: u32,
    pub tick_cu_limit: u32,
    /// Prints written this round (ring index = count % 32).
    pub print_count: u32,
    pub house: Pubkey,
    pub vrf_queue: Pubkey,
    /// Round PDA of the current round when recorded, else all-zero.
    pub round_key: Pubkey,
    /// Hash chain head (BeatOut.chain), published every tick.
    pub chain_head: [u8; 32],
    /// RoundState.chain after the bell (the commit hash of the round).
    pub commit_hash: [u8; 32],
    pub seats: [Seat; NDESK],
    /// Public picked tally per desk, tenths, every tick.
    pub picked: [u16; NDESK],
    /// resting + picked per desk, tenths, published at the bell.
    pub totals: [u16; NDESK],
    /// FILL tenths per desk in the last resolved beat (0 = no fill): this beat's prints.
    pub beat_fill: [u16; NDESK],
    /// Bits 0..7 = Desk s sealed for the next round, bit 8 = Book sealed.
    pub sealed: u16,
    /// Live beats resolved this round (BeatOut.beat; 0 during HIDE and right after it).
    pub beat: u16,
    pub prints: [Print; PRINTS],
    /// Per live beat b (index b): [pings, fills].
    pub beat_counts: [[u8; 2]; BEAT_SLOTS_RING],
    /// TABLE_HOUSE / TABLE_STAKED.
    pub kind: u8,
    /// PH_* (adds REVEALED and ABORTED to the engine's phases).
    pub phase: u8,
    pub bell_min: u8,
    pub bell_max: u8,
    /// Top Desk after the bell, NO_DESK before.
    pub top_desk: u8,
    /// 1 when this round has a Round record (and a Tape).
    pub recorded: u8,
    /// 1 when HIDE ended without VRF and the fallback seed was used.
    pub fallback_seed: u8,
    pub vrf_fulfils: u8,
    pub bump: u8,
    pub book_bump: u8,
    pub layout: u8,
    pub _pad: [u8; 1],
    /// Bump of Desk s (set by create_desk).
    pub desk_bump: [u8; NDESK],
    pub _reserved: [u8; 64],
}

/// The sealed order book (0 readers until the bell). Seeds `["book", t u64le]`.
/// A short header plus the rules engine's whole round state, which `tick`, `act` and
/// `vrf_callback` mutate in place.
#[account(zero_copy)]
pub struct Book {
    pub table_id: u64,
    pub round: u64,
    /// Slot of the VRF fulfil this round (0 = none yet).
    pub vrf_slot: u64,
    pub _r0: u64,
    /// ping_core::RoundState (1,144 bytes, align 2; offsets in docs/LAYOUT.md). Stored as bytes
    /// so the IDL can describe it; use `state()` / `state_mut()`.
    pub state: [u8; ping_core::ROUND_STATE_SIZE],
    pub layout: u8,
    pub _pad: [u8; 7],
    pub _reserved: [u8; 64],
}

/// One desk's private view (1 member: the seated key). Seeds `["desk", t u64le, [s]]`.
#[account(zero_copy)]
pub struct Desk {
    pub table_id: u64,
    pub round: u64,
    /// Slot of the last accepted act (the client's ack).
    pub ack_slot: u64,
    /// Slot of the last tick that wrote this desk.
    pub result_slot: u64,
    /// The seated key; all-zero when the seat is empty.
    pub key: Pubkey,
    /// Last accepted act seq; never reset (monotonic per desk across rounds and keys).
    pub last_seq: u32,
    /// Acts accepted this round.
    pub acts: u32,
    /// Own resting and picked tenths (current).
    pub resting: u16,
    pub picked: u16,
    /// Beat of the last tick written into `results` (0 = HIDE end).
    pub beat: u16,
    pub index: u8,
    /// Own level 1..24 (0 = not placed).
    pub level: u8,
    /// Table phase mirror (PH_*).
    pub phase: u8,
    /// The level the algo pings for this desk next beat if it sends nothing (UI preview).
    pub next_algo: u8,
    /// Echo of this desk's accepted pending choice for the coming beat.
    pub pending_kind: u8,
    pub pending_level: u8,
    /// 1 once this desk placed during HIDE.
    pub placed: u8,
    pub layout: u8,
    pub _pad: [u8; 2],
    /// results[b] = BeatOut.desks[s] of the tick that resolved beat b (0 = HIDE end, 1..=29 live).
    /// Stored as bytes so the IDL can describe it; use `results()` / `results_mut()`.
    pub results: [u8; RESULT_SLOTS * 16],
    pub _reserved: [u8; 32],
}

/// Public per-round record, created on base for recorded rounds, delegated, filled by `reveal`,
/// then committed + undelegated alone. Seeds `["round", t u64le, n u64le]`.
#[account(zero_copy)]
pub struct Round {
    pub table_id: u64,
    pub round: u64,
    pub planned_start_unix: i64,
    pub open_slot: u64,
    pub hide_end_slot: u64,
    pub bell_slot: u64,
    pub reveal_slot: u64,
    /// Seated key of the Top Desk at the bell.
    pub top_key: Pubkey,
    /// RoundState.chain at the bell: `ping_core::verify(record, commit_hash)` must accept it.
    pub commit_hash: [u8; 32],
    /// resting + picked per desk at the bell, tenths (the payouts).
    pub totals: [u16; NDESK],
    /// RS_CREATED / RS_OPEN / RS_REVEALED / RS_ABORTED.
    pub status: u8,
    /// Table kind.
    pub kind: u8,
    /// Top Desk (Tape winner), NO_DESK before the reveal.
    pub top_desk: u8,
    pub fallback_seed: u8,
    /// Live beats played.
    pub n_beats: u8,
    pub bump: u8,
    pub layout: u8,
    pub _pad: u8,
    /// Table.seats[s].kind at the bell.
    pub seat_kind: [u8; NDESK],
    /// ping_core::RoundRecord::write output (table_id, round, seed, initial levels, bell beat, log).
    pub record: [u8; ping_core::RECORD_LEN],
    pub _reserved: [u8; 134],
}

/// Base-layer per-table counter that keeps record numbers monotonic. Seeds `["ledger", t u64le]`.
#[account(zero_copy)]
pub struct Ledger {
    pub table_id: u64,
    /// Highest round number ever given a Round record (create_record requires a larger one).
    pub last_record_round: u64,
    pub records: u64,
    pub bump: u8,
    pub layout: u8,
    pub _pad: [u8; 6],
    pub _reserved: [u8; 32],
}

/// Base-layer parimutuel market on the Top Desk. Seeds `["tape", t u64le, n u64le]`.
#[account(zero_copy)]
pub struct Tape {
    pub table_id: u64,
    pub round: u64,
    /// No calls at or after this unix time.
    pub close_unix: i64,
    /// Lamports called on each desk.
    pub pool: [u64; NDESK],
    pub total: u64,
    /// Lamports paid out by claims so far.
    pub paid: u64,
    /// Calls not yet claimed.
    pub open_calls: u32,
    pub n_calls: u32,
    pub winner: u8,
    pub resolved: u8,
    /// 1 = everyone is refunded (aborted round or nobody called the winner).
    pub void: u8,
    pub bump: u8,
    pub layout: u8,
    pub _pad: [u8; 3],
    pub _reserved: [u8; 32],
}

/// One spectator call. Seeds `["call", tape, bettor]`.
#[account(zero_copy)]
pub struct Call {
    pub amount: u64,
    /// Payout computed but not sendable yet (would leave the recipient below the rent minimum).
    pub owed: u64,
    pub tape: Pubkey,
    pub bettor: Pubkey,
    pub desk: u8,
    pub claimed: u8,
    pub bump: u8,
    pub layout: u8,
    pub _pad: [u8; 4],
    pub _reserved: [u8; 16],
}

impl Book {
    /// The engine state, in place (the field is 2-aligned inside an 8-aligned account).
    pub fn state(&self) -> &ping_core::RoundState {
        bytemuck::from_bytes(&self.state)
    }
    pub fn state_mut(&mut self) -> &mut ping_core::RoundState {
        bytemuck::from_bytes_mut(&mut self.state)
    }
}

impl Desk {
    pub fn results(&self) -> &[ping_core::DeskOut; RESULT_SLOTS] {
        bytemuck::from_bytes(&self.results)
    }
    pub fn results_mut(&mut self) -> &mut [ping_core::DeskOut; RESULT_SLOTS] {
        bytemuck::from_bytes_mut(&mut self.results)
    }
}

// Sizes are part of the contract (docs/LAYOUT.md). Account size = 8 (discriminator) + struct.
const _: () = assert!(core::mem::size_of::<Config>() == 264);
const _: () = assert!(core::mem::size_of::<Seat>() == 56);
const _: () = assert!(core::mem::size_of::<Print>() == 6);
const _: () = assert!(core::mem::size_of::<Table>() == 1144);
const _: () = assert!(core::mem::size_of::<Book>() == 1248);
const _: () = assert!(core::mem::size_of::<Desk>() == 600);
const _: () = assert!(core::mem::size_of::<Round>() == 808);
const _: () = assert!(core::mem::size_of::<Ledger>() == 64);
const _: () = assert!(core::mem::size_of::<Tape>() == 152);
const _: () = assert!(core::mem::size_of::<Call>() == 104);

pub const CONFIG_SPACE: usize = 8 + core::mem::size_of::<Config>();
pub const TABLE_SPACE: usize = 8 + core::mem::size_of::<Table>();
pub const BOOK_SPACE: usize = 8 + core::mem::size_of::<Book>();
pub const DESK_SPACE: usize = 8 + core::mem::size_of::<Desk>();
pub const ROUND_SPACE: usize = 8 + core::mem::size_of::<Round>();
pub const LEDGER_SPACE: usize = 8 + core::mem::size_of::<Ledger>();
pub const TAPE_SPACE: usize = 8 + core::mem::size_of::<Tape>();
pub const CALL_SPACE: usize = 8 + core::mem::size_of::<Call>();
const _: () = assert!(core::mem::size_of::<ping_core::RoundState>() == ping_core::ROUND_STATE_SIZE);
const _: () = assert!(core::mem::size_of::<ping_core::DeskOut>() == 16 && core::mem::align_of::<ping_core::RoundState>() <= 2);
const _: () = assert!(core::mem::offset_of!(Book, state) % 8 == 0 && core::mem::offset_of!(Desk, results) % 8 == 0);
const _: () = assert!(NDESK == ping_core::DESKS && LEVELS == ping_core::LEVELS && STAKE_TENTHS == ping_core::STAKE);
