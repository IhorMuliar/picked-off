//! Round record and replay verifier.
//!
//! After the bell the round is published as a fixed-size [`RoundRecord`] (seed, levels at the end
//! of HIDE, bell beat, action log) and the final chain head (the commit hash). [`verify`]
//! recomputes everything from the record: the bell from the seed, every in-beat order and every
//! algo choice from the seed and the replayed state, the hash chain, the payouts and the Top
//! Desk. Any changed byte in the record or the commit hash makes it fail.
use crate::engine::{chain_open, compute_algo, derive_bell, replay_step, valid_level, NoSink, Sink};
use crate::sha256::Hasher;
use crate::state::*;

/// Serialized size of a [`RoundRecord`]: table_id u64, round u64, seed, initial levels,
/// bell beat u16, log (all little-endian).
pub const RECORD_LEN: usize = 8 + 8 + 32 + DESKS + 2 + LOG_LEN;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct RoundRecord {
    pub table_id: u64,
    pub round: u64,
    pub seed: [u8; 32],
    pub initial_level: [u8; DESKS],
    pub bell_beat: u16,
    pub log: [u8; LOG_LEN],
}

impl RoundRecord {
    /// The record of a finished round.
    pub fn from_state(st: &RoundState, table_id: u64, round: u64) -> Self {
        RoundRecord { table_id, round, seed: st.seed, initial_level: st.initial_level, bell_beat: st.bell_beat, log: st.log }
    }

    pub fn write(&self, out: &mut [u8; RECORD_LEN]) {
        out[0..8].copy_from_slice(&self.table_id.to_le_bytes());
        out[8..16].copy_from_slice(&self.round.to_le_bytes());
        out[16..48].copy_from_slice(&self.seed);
        out[48..56].copy_from_slice(&self.initial_level);
        out[56..58].copy_from_slice(&self.bell_beat.to_le_bytes());
        out[58..].copy_from_slice(&self.log);
    }

    pub fn read(b: &[u8; RECORD_LEN]) -> Self {
        let mut r = RoundRecord { table_id: 0, round: 0, seed: [0; 32], initial_level: [0; DESKS], bell_beat: 0, log: [0; LOG_LEN] };
        r.table_id = u64::from_le_bytes(b[0..8].try_into().unwrap());
        r.round = u64::from_le_bytes(b[8..16].try_into().unwrap());
        r.seed.copy_from_slice(&b[16..48]);
        r.initial_level.copy_from_slice(&b[48..56]);
        r.bell_beat = u16::from_le_bytes([b[56], b[57]]);
        r.log.copy_from_slice(&b[58..]);
        r
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum VerifyError {
    /// An initial level is outside 1..=24.
    BadLevel { desk: u8 },
    /// The bell beat does not follow from the seed.
    BadBell,
    /// A logged action is malformed (unknown kind, level outside 1..=24).
    BadAction { beat: u16, desk: u8 },
    /// A logged algo ping is not the level the algo would have chosen.
    BadAlgo { beat: u16, desk: u8 },
    /// A log row after the bell is not empty.
    TrailingLog { beat: u16 },
    /// The recomputed chain head differs from the published commit hash.
    BadCommit,
}

/// Result of a successful replay.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Verdict {
    pub totals: [u16; DESKS],
    pub picked: [u16; DESKS],
    pub top_desk: u8,
    pub commit: [u8; 32],
}

/// Replay `rec` into `st` (left in its final state), calling `sink` and `on_beat(state, out)`
/// for every live beat. Does not compare the commit hash.
pub fn replay<H: Hasher, S: Sink>(
    rec: &RoundRecord,
    st: &mut RoundState,
    sink: &mut S,
    mut on_beat: impl FnMut(&RoundState, &BeatOut),
) -> Result<Verdict, VerifyError> {
    for s in 0..DESKS {
        if valid_level(rec.initial_level[s] as u64) == 0 {
            return Err(VerifyError::BadLevel { desk: s as u8 });
        }
    }
    if derive_bell::<H>(&rec.seed) != rec.bell_beat {
        return Err(VerifyError::BadBell);
    }
    crate::engine::open_round(st);
    st.seed = rec.seed;
    st.level = rec.initial_level;
    st.initial_level = rec.initial_level;
    st.placed = [1; DESKS];
    st.bell_beat = rec.bell_beat;
    st.chain = chain_open::<H>(rec.table_id, rec.round, &st.seed, &st.initial_level, st.bell_beat);
    st.phase = LIVE;
    let mut nx = [0u8; DESKS];
    compute_algo::<H>(st, 1, &mut nx);
    st.algo_next = nx;
    let mut out = BeatOut::zeroed();
    for b in 1..=rec.bell_beat {
        let row = &rec.log[(b as usize - 1) * LOG_ROW..b as usize * LOG_ROW];
        let mut acts = [Action::default(); DESKS];
        for s in 0..DESKS {
            let kb = row[2 * s];
            let algo = kb >> 7;
            let kind = kb & !ALGO_FLAG;
            let level = row[2 * s + 1];
            if (kind != PING && kind != REQUOTE) || valid_level(level as u64) == 0 {
                return Err(VerifyError::BadAction { beat: b, desk: s as u8 });
            }
            if algo == 1 && (kind != PING || level != st.algo_next[s]) {
                return Err(VerifyError::BadAlgo { beat: b, desk: s as u8 });
            }
            acts[s] = Action { kind, level, algo };
        }
        replay_step::<H, S>(st, &acts, sink, &mut out);
        on_beat(st, &out);
    }
    for b in rec.bell_beat as usize + 1..=MAX_BEATS {
        if rec.log[(b - 1) * LOG_ROW..b * LOG_ROW].iter().any(|&x| x != 0) {
            return Err(VerifyError::TrailingLog { beat: b as u16 });
        }
    }
    let mut totals = [0u16; DESKS];
    for s in 0..DESKS {
        totals[s] = st.resting[s] + st.picked[s];
    }
    Ok(Verdict { totals, picked: st.picked, top_desk: st.top_desk, commit: st.chain })
}

/// Verify a serialized round record against the published commit hash.
pub fn verify<H: Hasher>(record: &[u8; RECORD_LEN], commit: &[u8; 32]) -> Result<Verdict, VerifyError> {
    let rec = RoundRecord::read(record);
    let mut st = RoundState::zeroed();
    let v = replay::<H, _>(&rec, &mut st, &mut NoSink, |_, _| {})?;
    if &v.commit != commit {
        return Err(VerifyError::BadCommit);
    }
    Ok(v)
}
