//! # ping-core: the Picked Off rules engine
//!
//! Pure, deterministic, integer-only rules for one table: 8 desks, a 24-level ladder, 10 lots
//! (100 tenths) per desk. No Solana types, `no_std`, no allocation. Lots are `u16` tenths,
//! levels `u8` 1..=24, beats `u16` (live beats numbered from 1).
//!
//! ## How the program calls it
//!
//! * Keep one [`RoundState`] (1,144 bytes, `#[repr(C)]`, no padding; `Pod` with the `bytemuck`
//!   feature) inside the private Book account and pass `&mut` to it straight from the zero-copy
//!   loader. Never copy it to the stack; [`BeatOut`] (198 bytes) is the only per-tick scratch.
//! * Plug the runtime hash syscall in through [`Hasher`] (`impl Hasher for X { fn hashv(p) {
//!   solana_sha256_hasher::hashv(p).to_bytes() } }`); [`Sha256`] is the portable fallback and
//!   gives identical bytes.
//! * `open_round`: re-seal the accounts first, then [`open_round`] (phase HIDE, every field reset).
//! * `vrf_callback`: [`set_vrf`].
//! * `act(kind, level, seq, salt)`: compute `ok` (right key AND fresh seq) as a 0/1 mask with
//!   [`mask`], then [`record_act`]. It never fails and does the same work for every input.
//! * `tick`: gate only on public facts (phase HIDE/LIVE, deadline slot). Then
//!   [`tick`]`::<YourHasher, NoSink>(&mut state, table_id, round, slot, &mut NoSink, &mut out)`
//!   resolves the HIDE end or one live beat with the same work for every hidden state. Copy
//!   `out.desks[s]` into Desk `s` and `out.picked`, `out.pings`, `out.fills`, the per-desk
//!   `fill_amt` prints and `out.chain` into the public Table, every tick. When `out.phase ==
//!   BELL`, `out.totals` are the payouts and `out.top_desk` is the Top Desk (Tape winner).
//! * `reveal`: publish [`RoundRecord::from_state`] (serialized with [`RoundRecord::write`],
//!   [`RECORD_LEN`] bytes) and `state.chain` as the commit hash. Anyone can then check it with
//!   [`verify`], which replays the round and rejects any changed byte.
//!
//! ## Constant work
//!
//! On a validator that shows compute units to observers, the cost of an instruction must not
//! depend on hidden data. All functions reached from [`record_act`] and [`tick`] use fixed trip
//! counts and arithmetic 0/1 masks; every mask and operand passes through `read_volatile`
//! ([`mask::op`]) so the compiler cannot turn them back into branches. Keep it that way when
//! editing: no `if`, `match`, `&&`, `||`, `bool` compares, `min`/`max` or early exits on hidden
//! values in those paths, and only fixed-length hash inputs. The replay verifier is for hosts
//! and browsers and may branch.
#![no_std]

pub mod engine;
pub mod mask;
pub mod replay;
pub mod sha256;
pub mod state;

pub use engine::{
    apply_beat, chain_open, chain_step, compute_algo, derive_bell, derive_default_levels, derive_order, derive_seed,
    derive_tie_order, open_round, record_act, set_vrf, tick, top_desk, valid_level, NoSink, Sink,
};
pub use replay::{replay, verify, RoundRecord, Verdict, VerifyError, RECORD_LEN};
pub use sha256::{Hasher, Sha256};
pub use state::*;
