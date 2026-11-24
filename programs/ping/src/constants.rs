//! Fixed numbers of the game and of the deployment. Game parameters that differ per network
//! (slot counts, cadences) live in `Config`; these are the ones every build shares.
use anchor_lang::prelude::*;

/// Program version returned by `version` (bump on every deploy that changes behaviour).
pub const PROGRAM_VERSION: u32 = 1;
/// Layout version stored in every account (`layout` field). Bump when docs/LAYOUT.md changes.
pub const LAYOUT_VERSION: u8 = 1;

// ---- game shape
pub const NDESK: usize = 8;
pub const LEVELS: usize = 24;
/// Levels are 1..=24 on the wire and in every account; 0 means "none".
pub const LEVEL_MIN: u8 = 1;
pub const LEVEL_MAX: u8 = 24;
/// Lots are stored in tenths: 10 lots = 100.
pub const STAKE_TENTHS: u16 = 100;
pub const TOTAL_TENTHS: u16 = STAKE_TENTHS * NDESK as u16;
/// Skim per consecutive FILL by one hunter on one victim, in tenths.
pub const SKIM: [u16; 3] = [5, 10, 15];
/// Desk.results slots: index = beat (0 = HIDE end, 1..=29 live).
pub const RESULT_SLOTS: usize = 30;
/// Table.beat_counts slots (indexed by beat).
pub const BEAT_SLOTS_RING: usize = 32;
/// Most live beats in a round (bell_max).
pub const MAX_LIVE_BEATS: usize = 29;
/// Public prints ring in the Table.
pub const PRINTS: usize = 32;

// ---- phases (Table.phase, Book.phase, Desk.phase)
pub const PH_IDLE: u8 = 0;
pub const PH_HIDE: u8 = 1;
pub const PH_LIVE: u8 = 2;
pub const PH_BELL: u8 = 3;
pub const PH_REVEALED: u8 = 4;
pub const PH_ABORTED: u8 = 5;

// ---- act kinds (wire)
pub const ACT_NOOP: u8 = 0;
pub const ACT_PING: u8 = 1;
/// Re-quote in LIVE; place in HIDE.
pub const ACT_REQUOTE: u8 = 2;

// ---- seats (Table.seats[s].kind)
pub const SEAT_EMPTY: u8 = 0;
pub const SEAT_HUMAN: u8 = 1;
pub const SEAT_BOT: u8 = 2;

// ---- table kinds
pub const TABLE_HOUSE: u8 = 0;
pub const TABLE_STAKED: u8 = 1;

// ---- Round.status
pub const RS_CREATED: u8 = 0;
pub const RS_OPEN: u8 = 1;
pub const RS_REVEALED: u8 = 2;
pub const RS_ABORTED: u8 = 3;

// ---- account kinds (arguments of `delegate` and `setup_permissions`)
pub const KIND_TABLE: u8 = 0;
pub const KIND_BOOK: u8 = 1;
pub const KIND_DESK: u8 = 2;
pub const KIND_ROUND: u8 = 3;

/// Table.sealed bit of the Book; bits 0..7 are the Desks.
pub const SEAL_BOOK: u16 = 1 << 8;
pub const SEAL_ALL: u16 = SEAL_BOOK | 0xff;

/// Sentinel for "no desk" (Table.top_desk before the bell).
pub const NO_DESK: u8 = 0xff;

// ---- seeds (distinct fixed prefixes followed by fixed-width integers)
pub const CONFIG_SEED: &[u8] = b"config";
pub const TABLE_SEED: &[u8] = b"table";
pub const BOOK_SEED: &[u8] = b"book";
pub const DESK_SEED: &[u8] = b"desk";
pub const ROUND_SEED: &[u8] = b"round";
pub const TAPE_SEED: &[u8] = b"tape";
pub const CALL_SEED: &[u8] = b"call";
pub const LEDGER_SEED: &[u8] = b"ledger";

// ---- hash domains
pub const TASK_DOMAIN: &[u8] = b"ping/task";

// ---- deployment keys
/// The TEE validator every delegation is pinned to on devnet.
pub const TEE_VALIDATOR: Pubkey = pubkey!("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
/// Identity of the local MagicBlock stack's validator (accepted for local test configs).
pub const LOCAL_VALIDATOR: Pubkey = pubkey!("mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev");
/// Keys allowed to create the Config: the devnet deployer and the local test wallet.
pub const ADMINS: [Pubkey; 2] = [
    pubkey!("2PgaD2rF6U4a7urZ43GWMkKdhchjqqSmVgcX54GLRAYQ"),
    pubkey!("4K5RjaJeaw7QVjvCJuU6DzV7H3GYnSScjtmMG3A2G9HZ"),
];
pub const COMPUTE_BUDGET_PROGRAM: Pubkey = pubkey!("ComputeBudget111111111111111111111111111111");
pub const SLOT_HASHES_SYSVAR: Pubkey = pubkey!("SysvarS1otHashes111111111111111111111111111");
