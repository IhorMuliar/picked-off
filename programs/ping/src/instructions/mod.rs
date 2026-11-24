//! One file per instruction. A1: config, pool, delegation, permissions, round open/abort/commit,
//! version. A2 fills join, act, vrf_callback, tick, reveal, reschedule_crank. A3 fills the base
//! Tape instructions (create_record is in place for A1's checks).
pub mod init_config;
pub mod create_pool;
pub mod create_desk;
pub mod delegate;
pub mod create_record;
pub mod setup_permissions;
pub mod join_bot;
pub mod open_round;
pub mod tick;
pub mod reveal;
pub mod unseal;
pub mod abort_round;
pub mod commit_round;
pub mod version;
pub mod join;
pub mod act;
pub mod vrf_callback;
pub mod reschedule_crank;
pub mod settle_round;
pub mod place_call;
pub mod claim_call;
pub mod close_round;

pub use init_config::*;
pub use create_pool::*;
pub use create_desk::*;
pub use delegate::*;
pub use create_record::*;
pub use setup_permissions::*;
pub use join_bot::*;
pub use open_round::*;
pub use tick::*;
pub use reveal::*;
pub use unseal::*;
pub use abort_round::*;
pub use commit_round::*;
pub use version::*;
pub use join::*;
pub use act::*;
pub use vrf_callback::*;
pub use reschedule_crank::*;
pub use settle_round::*;
pub use place_call::*;
pub use claim_call::*;
pub use close_round::*;
