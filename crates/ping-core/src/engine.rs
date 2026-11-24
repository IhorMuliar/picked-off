//! Beat resolution with the same work for every hidden state.
//!
//! Every loop has a fixed trip count (desks, desk pairs, levels, bytes). Every decision that
//! depends on hidden data (levels, lots, pending choices, streaks, the seed, who was picked off)
//! is an arithmetic 0/1 mask from [`crate::mask`], and every write happens with the mask choosing
//! the value. The HIDE-end tick, live beats and the bell beat run the same code; the phase only
//! chooses which results are kept. Indexing by data is allowed (bounds checks always pass).
use crate::mask::{eq, lt, min, nz, op, sel, sel_bytes};
use crate::sha256::Hasher;
use crate::state::*;

/// Observer of the resolution, for tests and the replay. Called for every (hunter, victim)
/// pair and every desk in resolution order, with `hit`/`pinged` masks; the program passes
/// [`NoSink`], which compiles to nothing.
pub trait Sink {
    #[inline(always)]
    fn pair(&mut self, _hunter: usize, _victim: usize, _level: u64, _hit: u64, _amt: u64) {}
    #[inline(always)]
    fn ping(&mut self, _desk: usize, _level: u64, _pinged: u64, _fill: u64) {}
}

pub struct NoSink;
impl Sink for NoSink {}

#[inline(always)]
fn le_u32(h: &[u8; 32], i: usize) -> u64 {
    u32::from_le_bytes([h[i], h[i + 1], h[i + 2], h[i + 3]]) as u64
}

/// 1 if `l` is a ladder level (1..=24).
#[inline(always)]
pub fn valid_level(l: u64) -> u64 {
    nz(l) & lt(l, LEVELS as u64 + 1)
}

/// Seed from the VRF output (or the fallback source), the HIDE salts and the round identity.
pub fn derive_seed<H: Hasher>(src: &[u8; 32], salt_acc: &[u8; 32], table_id: u64, round: u64) -> [u8; 32] {
    H::hashv(&[b"ping/seed/v1", src, salt_acc, &table_id.to_le_bytes(), &round.to_le_bytes()])
}

/// The bell beat drawn from the seed, uniform on BELL_MIN..BELL_MIN + BELL_SPAN - 1.
pub fn derive_bell<H: Hasher>(seed: &[u8; 32]) -> u16 {
    let h = H::hashv(&[b"ping/bell", seed]);
    let x = u64::from_le_bytes([h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]]);
    BELL_MIN + (x % BELL_SPAN as u64) as u16
}

/// Level given to a desk that did not place during HIDE.
pub fn derive_default_levels<H: Hasher>(seed: &[u8; 32], out: &mut [u8; DESKS]) {
    let h = H::hashv(&[b"ping/levels", seed]);
    for s in 0..DESKS {
        out[s] = (1 + (u16::from_le_bytes([h[2 * s], h[2 * s + 1]]) as u64) % LEVELS as u64) as u8;
    }
}

fn shuffle(h: &[u8; 32], out: &mut [u8; DESKS]) {
    for i in 0..DESKS {
        out[i] = i as u8;
    }
    for i in (1..DESKS).rev() {
        let j = (le_u32(h, 4 * i) % (i as u64 + 1)) as usize;
        out.swap(i, j);
    }
}

/// In-beat resolution order of live beat `beat` (Fisher-Yates from the seed).
pub fn derive_order<H: Hasher>(seed: &[u8; 32], beat: u16, out: &mut [u8; DESKS]) {
    let h = H::hashv(&[b"ping/order", seed, &beat.to_le_bytes()]);
    shuffle(&h, out);
}

/// Final tie-break order (earlier = wins the tie).
pub fn derive_tie_order<H: Hasher>(seed: &[u8; 32], out: &mut [u8; DESKS]) {
    let h = H::hashv(&[b"ping/tie", seed]);
    shuffle(&h, out);
}

/// Algo levels for live beat `beat`, from the current state: for each desk, uniform over the
/// levels other than its own that it last pinged more than ALGO_MEMORY beats ago (or never); if
/// there is none, uniform over all levels other than its own.
pub fn compute_algo<H: Hasher>(st: &RoundState, beat: u16, out: &mut [u8; DESKS]) {
    let h = H::hashv(&[b"ping/algo", &st.seed, &beat.to_le_bytes()]);
    let b = beat as u64;
    for s in 0..DESKS {
        let own = st.level[s] as u64;
        let mut e = [0u64; LEVELS];
        let mut c = 0u64;
        for i in 0..LEVELS {
            let l = i as u64 + 1;
            let lp = st.last_pinged[s * LEVELS + i] as u64;
            let ok = (1 ^ eq(l, own)) & (eq(lp, 0) | lt(ALGO_MEMORY, b.wrapping_sub(lp) & 0xffff));
            e[i] = ok;
            c += ok;
        }
        let none = eq(c, 0);
        let mut c2 = 0u64;
        for i in 0..LEVELS {
            e[i] |= none & (1 ^ eq(i as u64 + 1, own));
            c2 += e[i];
        }
        let c2 = c2 + eq(c2, 0);
        let k = le_u32(&h, 4 * s) % c2;
        let mut run = 0u64;
        let mut chosen = 0u64;
        for i in 0..LEVELS {
            chosen += (i as u64 + 1) & op(e[i] & eq(run, k)).wrapping_neg();
            run += e[i];
        }
        out[s] = chosen as u8;
    }
}

/// Start a round: every field back to its initial value, resting = STAKE, phase HIDE.
/// Call after the accounts are re-sealed, before any `act` of the new round.
pub fn open_round(st: &mut RoundState) {
    *st = RoundState::zeroed();
    st.resting = [STAKE; DESKS];
    st.phase = HIDE;
}

/// Store the VRF output (the first one wins; later calls are no-ops).
pub fn set_vrf(st: &mut RoundState, vrf: &[u8; 32]) {
    let first = 1 ^ nz(st.vrf_set as u64);
    sel_bytes(first, vrf, &mut st.vrf);
    st.vrf_set = sel(first, 1, st.vrf_set as u64) as u8;
}

/// Record one `act` from desk `desk`. `ok` is the caller's 0/1 mask (right key and fresh seq).
/// HIDE: folds the salt; kind REQUOTE with a valid level places the order. LIVE: kind PING or
/// REQUOTE with a valid level becomes the desk's pending choice (the latest wins). Anything else
/// changes nothing. Same work for every input.
pub fn record_act<H: Hasher>(st: &mut RoundState, desk: usize, kind: u8, level: u8, salt: &[u8; 16], ok: u64) {
    let s = desk % DESKS;
    let ok = ok & 1;
    let hide = eq(st.phase as u64, HIDE as u64) & ok;
    let live = eq(st.phase as u64, LIVE as u64) & ok;
    let valid = valid_level(level as u64);
    let k = kind as u64;
    let h = H::hashv(&[b"ping/salt", &st.salt_acc, salt, &[s as u8]]);
    sel_bytes(hide, &h, &mut st.salt_acc);
    let place = hide & eq(k, REQUOTE as u64) & valid;
    st.level[s] = sel(place, level as u64, st.level[s] as u64) as u8;
    st.placed[s] = sel(place, 1, st.placed[s] as u64) as u8;
    let choice = live & (eq(k, PING as u64) | eq(k, REQUOTE as u64)) & valid;
    st.pending_kind[s] = sel(choice, k, st.pending_kind[s] as u64) as u8;
    st.pending_level[s] = sel(choice, level as u64, st.pending_level[s] as u64) as u8;
}

/// Resolve the actions of live beat `beat` against `st` in `order`: re-quotes first, then pings.
/// `live` (0/1) keeps or discards every write. Writes the beat's log row, the per-desk results
/// into `out.desks`, and `out.pings`/`out.fills`. Does not touch the chain or the phase.
pub fn apply_beat<S: Sink>(
    st: &mut RoundState,
    acts: &[Action; DESKS],
    order: &[u8; DESKS],
    beat: u16,
    live: u64,
    sink: &mut S,
    out: &mut BeatOut,
) {
    let live = live & 1;
    let b = beat as u64;
    let mut kind = [0u64; DESKS];
    let mut lvl = [0u64; DESKS];
    for s in 0..DESKS {
        let l = acts[s].level as u64;
        let k = acts[s].kind as u64;
        let known = eq(k, PING as u64) | eq(k, REQUOTE as u64);
        kind[s] = sel(known & valid_level(l), k, NOOP as u64);
        lvl[s] = l;
    }

    // re-quotes land first
    for idx in 0..DESKS {
        let p = order[idx] as usize % DESKS;
        let rq = live & eq(kind[p], REQUOTE as u64) & (1 ^ eq(lvl[p], st.level[p] as u64));
        st.level[p] = sel(rq, lvl[p], st.level[p] as u64) as u8;
        for h in 0..DESKS {
            st.streak[h * DESKS + p] = sel(rq, 0, st.streak[h * DESKS + p] as u64) as u8;
        }
    }

    // then pings, in order
    let mut fill = [0u64; DESKS];
    let mut lost = [0u64; DESKS];
    let mut victims = [0u64; DESKS];
    let mut taken = [0u64; DESKS];
    let mut ip_arr = [0u64; DESKS];
    for idx in 0..DESKS {
        let p = order[idx] as usize % DESKS;
        let ip = live & eq(kind[p], PING as u64);
        ip_arr[p] = ip;
        let l = lvl[p];
        let lpi = p * LEVELS + ((l as usize + LEVELS - 1) % LEVELS);
        st.last_pinged[lpi] = sel(ip, b, st.last_pinged[lpi] as u64) as u16;
        for v in 0..DESKS {
            let rest = st.resting[v] as u64;
            let hit = ip & (1 ^ eq(v as u64, p as u64)) & eq(st.level[v] as u64, l) & nz(rest);
            let sk = st.streak[p * DESKS + v] as u64;
            let skim = SKIM_STEP * (1 + min(sk, SKIM_STEPS - 1));
            let amt = min(skim, rest) & op(hit).wrapping_neg();
            st.resting[v] = (rest - amt) as u16;
            st.picked[p] = (st.picked[p] as u64 + amt) as u16;
            st.streak[p * DESKS + v] = min(sk + hit, 200) as u8;
            sink.pair(p, v, l, hit, amt);
            fill[p] += amt;
            lost[v] += amt;
            victims[p] += hit;
            taken[v] += hit;
        }
        sink.ping(p, l, ip, fill[p]);
        st.last_fill[p] = sel(ip & nz(fill[p]), b, st.last_fill[p] as u64) as u16;
    }

    // log row
    // row b - 1 for live beat b (1..=MAX_BEATS); the HIDE-end call (b = 0, nothing kept) uses
    // the last row. A modulo, not a clamp: the same instructions for every beat.
    let row = ((b as usize + MAX_BEATS - 1) % MAX_BEATS) * LOG_ROW;
    let mut pings = 0u64;
    let mut fills = 0u64;
    for s in 0..DESKS {
        let algo = op(acts[s].algo as u64 & 1);
        let byte0 = kind[s] | (algo << 7);
        st.log[row + 2 * s] = sel(live, byte0, st.log[row + 2 * s] as u64) as u8;
        st.log[row + 2 * s + 1] = sel(live, lvl[s], st.log[row + 2 * s + 1] as u64) as u8;
        let filled = ip_arr[s] & nz(fill[s]);
        pings += ip_arr[s];
        fills += filled;
        let d = &mut out.desks[s];
        d.resting = st.resting[s];
        d.picked = st.picked[s];
        d.fill_amt = fill[s] as u16;
        d.lost_amt = lost[s] as u16;
        d.level = st.level[s];
        let keep = op(live).wrapping_neg();
        d.action_kind = (kind[s] & keep) as u8;
        d.action_level = (lvl[s] & keep) as u8;
        d.action_algo = (algo & live) as u8;
        // RES_NONE, RES_MISS (pinged) or RES_FILL (pinged and filled): filled implies pinged
        d.result = op(ip_arr[s] + filled) as u8;
        d.victims = victims[s] as u8;
        d.hits_taken = taken[s] as u8;
    }
    out.pings = pings as u8;
    out.fills = fills as u8;
}

/// Hash chain step over live beat `beat`'s log row.
pub fn chain_step<H: Hasher>(chain: &[u8; 32], seed: &[u8; 32], beat: u16, row: &[u8]) -> [u8; 32] {
    H::hashv(&[b"ping/chain", chain, seed, &beat.to_le_bytes(), row])
}

/// Chain head at the end of HIDE.
pub fn chain_open<H: Hasher>(table_id: u64, round: u64, seed: &[u8; 32], initial: &[u8; DESKS], bell: u16) -> [u8; 32] {
    H::hashv(&[b"ping/open", &table_id.to_le_bytes(), &round.to_le_bytes(), seed, initial, &bell.to_le_bytes()])
}

/// Top Desk: largest resting + picked; ties by more picked, then the earlier last FILL, then
/// the seed's tie order.
pub fn top_desk<H: Hasher>(st: &RoundState) -> u8 {
    let mut tie = [0u8; DESKS];
    derive_tie_order::<H>(&st.seed, &mut tie);
    let mut rank = [0u64; DESKS];
    for k in 0..DESKS {
        rank[tie[k] as usize % DESKS] = (DESKS - 1 - k) as u64;
    }
    let mut best = 0u64;
    let mut best_key = 0u64;
    for s in 0..DESKS {
        let tot = st.resting[s] as u64 + st.picked[s] as u64;
        let key = (tot << 40) | ((st.picked[s] as u64) << 24) | ((0xffff - st.last_fill[s] as u64) << 8) | rank[s];
        let better = lt(best_key, key);
        best = sel(better, s as u64, best);
        best_key = sel(better, key, best_key);
    }
    best as u8
}

/// Fill the public totals, algo previews and phase fields of `out` after a step.
fn finish<H: Hasher>(st: &mut RoundState, active: u64, is_bell: u64, out: &mut BeatOut) {
    let mut nx = [0u8; DESKS];
    compute_algo::<H>(st, st.beat + 1, &mut nx);
    for s in 0..DESKS {
        st.algo_next[s] = sel(active, nx[s] as u64, st.algo_next[s] as u64) as u8;
        out.desks[s].next_algo = st.algo_next[s];
        out.picked[s] = st.picked[s];
        out.totals[s] = st.resting[s] + st.picked[s];
    }
    let td = top_desk::<H>(st);
    st.top_desk = sel(is_bell, td as u64, st.top_desk as u64) as u8;
    out.top_desk = st.top_desk;
    out.beat = st.beat;
    out.phase = st.phase;
    out.chain = st.chain;
}

/// One resolving tick: the end of HIDE when `st.phase == HIDE`, else live beat `st.beat + 1`.
///
/// HIDE end: the seed is drawn (VRF output if set, else a fallback from the salts and `slot`),
/// the bell beat is fixed, unplaced desks get a seeded level, the chain opens, phase LIVE.
/// Live beat: each desk's action is its pending choice, else the algo ping; the beat resolves
/// (see [`apply_beat`]); the chain advances; at the bell beat the phase becomes BELL and the Top
/// Desk is fixed. Pending choices are cleared. In any other phase nothing is kept.
///
/// Same work for every hidden state; the caller gates only on the public phase and deadline.
pub fn tick<H: Hasher, S: Sink>(st: &mut RoundState, table_id: u64, round: u64, slot: u64, sink: &mut S, out: &mut BeatOut) {
    let is_hide = eq(st.phase as u64, HIDE as u64);
    let is_live = eq(st.phase as u64, LIVE as u64);
    let active = is_hide | is_live;

    // ---- seed, bell, default levels (kept at the HIDE end only)
    let fb = H::hashv(&[b"ping/fallback", &st.salt_acc, &slot.to_le_bytes()]);
    let vset = nz(st.vrf_set as u64);
    let mut src = fb;
    sel_bytes(vset, &st.vrf, &mut src);
    let cand = derive_seed::<H>(&src, &st.salt_acc, table_id, round);
    sel_bytes(is_hide, &cand, &mut st.seed);
    let bell = derive_bell::<H>(&st.seed);
    st.bell_beat = sel(is_hide, bell as u64, st.bell_beat as u64) as u16;
    st.fallback = sel(is_hide, 1 ^ vset, st.fallback as u64) as u8;
    let mut dl = [0u8; DESKS];
    derive_default_levels::<H>(&st.seed, &mut dl);
    for s in 0..DESKS {
        let m = is_hide & ((1 ^ nz(st.placed[s] as u64)) | (1 ^ valid_level(st.level[s] as u64)));
        st.level[s] = sel(m, dl[s] as u64, st.level[s] as u64) as u8;
        st.initial_level[s] = sel(is_hide, st.level[s] as u64, st.initial_level[s] as u64) as u8;
    }
    let open = chain_open::<H>(table_id, round, &st.seed, &st.initial_level, st.bell_beat);
    sel_bytes(is_hide, &open, &mut st.chain);

    // ---- actions: pending choice, else the algo ping
    let b = sel(is_live, st.beat as u64 + 1, 0) as u16;
    let mut acts = [Action::default(); DESKS];
    for s in 0..DESKS {
        let pk = st.pending_kind[s] as u64;
        let has = nz(pk);
        acts[s] = Action {
            kind: sel(has, pk, PING as u64) as u8,
            level: sel(has, st.pending_level[s] as u64, st.algo_next[s] as u64) as u8,
            algo: op(1 ^ has) as u8,
        };
        st.pending_kind[s] = sel(active, 0, pk) as u8;
        st.pending_level[s] = sel(active, 0, st.pending_level[s] as u64) as u8;
    }
    let mut order = [0u8; DESKS];
    derive_order::<H>(&st.seed, b, &mut order);
    apply_beat(st, &acts, &order, b, is_live, sink, out);

    // ---- chain, beat counter, bell
    let ri = ((b as usize + MAX_BEATS - 1) % MAX_BEATS) * LOG_ROW;
    let next = chain_step::<H>(&st.chain, &st.seed, b, &st.log[ri..ri + LOG_ROW]);
    sel_bytes(is_live, &next, &mut st.chain);
    st.beat = sel(is_live, b as u64, st.beat as u64) as u16;
    let is_bell = is_live & eq(b as u64, st.bell_beat as u64);
    st.phase = sel(is_hide, LIVE as u64, sel(is_bell, BELL as u64, st.phase as u64)) as u8;
    finish::<H>(st, active, is_bell, out);
}

/// Live-beat step used by the replay: like the live branch of [`tick`] with explicit actions.
pub(crate) fn replay_step<H: Hasher, S: Sink>(st: &mut RoundState, acts: &[Action; DESKS], sink: &mut S, out: &mut BeatOut) {
    let b = st.beat + 1;
    let mut order = [0u8; DESKS];
    derive_order::<H>(&st.seed, b, &mut order);
    apply_beat(st, acts, &order, b, 1, sink, out);
    let ri = (b as usize - 1) * LOG_ROW;
    st.chain = chain_step::<H>(&st.chain, &st.seed, b, &st.log[ri..ri + LOG_ROW]);
    st.beat = b;
    let is_bell = eq(b as u64, st.bell_beat as u64);
    st.phase = sel(is_bell, BELL as u64, st.phase as u64) as u8;
    finish::<H>(st, 1, is_bell, out);
}
