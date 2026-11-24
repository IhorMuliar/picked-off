//! Invariant tests (seeded, deterministic).
mod common;
use common::*;
use ping_core::*;

/// Round count: PING_ROUNDS overrides; debug builds run a fifth of the default
/// (`cargo test --release -p ping-core` runs the full count).
fn rounds(default: u64) -> u64 {
    let d = if cfg!(debug_assertions) { default / 5 } else { default };
    std::env::var("PING_ROUNDS").ok().and_then(|s| s.parse().ok()).unwrap_or(d)
}

/// I1: Σ resting + Σ picked = 800 at every beat; resting never rises; picked never falls.
/// Also: every round reaches the bell after 20..=29 live beats and its record verifies.
#[test]
fn i1_conservation_and_monotonic() {
    let n = rounds(10_000);
    let mut beats = 0u64;
    let mut fills = 0u64;
    for seed in 0..n {
        let p = play_random(seed, |a, b, out| {
            let sum: u32 = (0..8).map(|s| b.resting[s] as u32 + b.picked[s] as u32).sum();
            assert_eq!(sum, 800);
            for s in 0..8 {
                assert!(b.resting[s] <= a.resting[s]);
                assert!(b.picked[s] >= a.picked[s]);
                assert_eq!(out.totals[s], b.resting[s] + b.picked[s]);
            }
        });
        assert_eq!(p.st.phase, BELL);
        assert!((20..=29).contains(&p.st.beat) && p.st.beat == p.st.bell_beat);
        beats += p.st.beat as u64;
        fills += p.outs.iter().map(|o| o.fills as u64).sum::<u64>();
        if seed % 10 == 0 {
            let rec = RoundRecord::from_state(&p.st, p.script.table_id, p.script.round);
            let mut bytes = [0u8; RECORD_LEN];
            rec.write(&mut bytes);
            let v = verify::<Sha256>(&bytes, &p.st.chain).expect("own record verifies");
            assert_eq!(v.top_desk, p.st.top_desk);
            assert_eq!(v.totals, p.outs.last().unwrap().totals);
        }
    }
    println!("I1: {n} rounds, {beats} beats, {fills} fills");
}

/// I3: permuting the levels of every placement and every action leaves every public output
/// (picked tally, ping and fill counts, the prints' amounts, totals, phase) identical.
#[test]
fn i3_level_permutation_leaves_public_outputs_unchanged() {
    let n = rounds(1_000);
    let mut r = Rng(0xfeed);
    for _ in 0..n {
        let span = if r.below(2) == 0 { 3 } else { 24 };
        let levels: [u8; 8] = core::array::from_fn(|_| 1 + r.below(span) as u8);
        let nb = 20 + r.below(10) as usize;
        let mut script = Vec::new();
        for _ in 0..nb {
            let mut order: [u8; 8] = core::array::from_fn(|i| i as u8);
            for i in (1..8).rev() {
                order.swap(i, r.below(i as u64 + 1) as usize);
            }
            let acts: [Action; 8] = core::array::from_fn(|_| {
                let kind = if r.below(4) == 0 { REQUOTE } else { PING };
                let level = 1 + r.below(span) as u8;
                Action { kind, level, algo: r.below(2) as u8 }
            });
            script.push((order, acts));
        }
        let run = |pi: &[u8; 25]| {
            let mut st = RoundState::zeroed();
            open_round(&mut st);
            st.phase = LIVE;
            st.level = levels.map(|l| pi[l as usize]);
            let mut out = BeatOut::zeroed();
            let mut pubs = Vec::new();
            for (i, (order, acts)) in script.iter().enumerate() {
                let acts = acts.map(|a| Action { level: pi[a.level as usize], ..a });
                apply_beat(&mut st, &acts, order, i as u16 + 1, 1, &mut NoSink, &mut out);
                let fill: Vec<u16> = out.desks.iter().map(|d| d.fill_amt).collect();
                pubs.push((st.picked, out.pings, out.fills, fill));
            }
            pubs
        };
        let id: [u8; 25] = core::array::from_fn(|i| i as u8);
        let base = run(&id);
        for _ in 0..5 {
            let mut pi = id;
            for i in (2..25).rev() {
                let j = 1 + r.below(i as u64) as usize;
                pi.swap(i, j);
            }
            assert_eq!(run(&pi), base);
        }
    }
}

/// I6: the bell beat is in 20..=29 and uniform (chi-square, 9 degrees of freedom, p = 0.001).
#[test]
fn i6_bell_uniform() {
    let n = 2_000u64;
    let mut c = [0u64; 10];
    let mut r = Rng(42);
    for _ in 0..n {
        let mut st = RoundState::zeroed();
        open_round(&mut st);
        set_vrf(&mut st, &r.bytes::<32>());
        let mut out = BeatOut::zeroed();
        tick::<Sha256, _>(&mut st, 7, r.below(1 << 30), 0, &mut NoSink, &mut out);
        assert_eq!(st.phase, LIVE);
        assert!((20..=29).contains(&st.bell_beat));
        c[(st.bell_beat - 20) as usize] += 1;
    }
    let e = n as f64 / 10.0;
    let chi: f64 = c.iter().map(|&x| (x as f64 - e).powi(2) / e).sum();
    println!("I6 counts {c:?} chi2 {chi:.2}");
    assert!(chi < 27.88, "chi2 {chi}");
}

/// I6: no public output differs before the bell in a way that depends on the bell beat; the
/// phase flips exactly after the bell beat.
#[test]
fn i6_phase_flips_only_at_bell() {
    for seed in 0..500 {
        let p = play_random(seed, |_, _, _| {});
        let bell = p.st.bell_beat as usize;
        for (i, o) in p.outs.iter().enumerate() {
            assert_eq!(o.phase, if i == 0 || i < bell { LIVE } else { BELL });
        }
        assert_eq!(p.outs.len(), bell + 1);
    }
}

fn live_state(levels: [u8; 8]) -> RoundState {
    let mut st = RoundState::zeroed();
    open_round(&mut st);
    st.phase = LIVE;
    st.level = levels;
    st
}

fn beat(st: &mut RoundState, acts: [(u8, u8); 8]) -> BeatOut {
    let mut out = BeatOut::zeroed();
    let b = st.beat + 1;
    let a = acts.map(|(k, l)| Action { kind: k, level: l, algo: 0 });
    apply_beat(st, &a, &[0, 1, 2, 3, 4, 5, 6, 7], b, 1, &mut NoSink, &mut out);
    st.beat = b;
    out
}

const IDLE_ACT: (u8, u8) = (NOOP, 0);

/// I7: escalation 0.5 → 1.0 → 1.5 (cap) per hunter→victim; reset when the victim re-quotes;
/// a re-quote to the same level does not reset; other hunters have their own streaks.
#[test]
fn i7_escalation_and_reset() {
    let mut st = live_state([5, 9, 12, 13, 14, 15, 16, 17]);
    let mut acts = [IDLE_ACT; 8];
    acts[0] = (PING, 9);
    for want in [5, 10, 15, 15] {
        let o = beat(&mut st, acts);
        assert_eq!(o.desks[0].fill_amt, want);
        assert_eq!(o.desks[1].lost_amt, want);
        assert_eq!(o.desks[0].result, RES_FILL);
        assert_eq!(o.desks[1].hits_taken, 1);
    }
    // re-quote to the same level: no reset
    let mut a = acts;
    a[1] = (REQUOTE, 9);
    beat(&mut st, a);
    assert_eq!(beat(&mut st, acts).desks[0].fill_amt, 15);
    // second hunter starts at 0.5
    let mut a = acts;
    a[2] = (PING, 9);
    let o = beat(&mut st, a);
    assert_eq!((o.desks[0].fill_amt, o.desks[2].fill_amt), (15, 5));
    // victim moves: everyone's streak on it resets; the hunter follows in the same beat
    st.resting[1] = 100; // top up so the next fills are not capped by resting
    let mut a = [IDLE_ACT; 8];
    a[1] = (REQUOTE, 20);
    a[0] = (PING, 20);
    let o = beat(&mut st, a);
    assert_eq!(st.level[1], 20);
    assert_eq!(o.desks[0].fill_amt, 5, "re-quotes land before pings; streak reset");
    a[1] = IDLE_ACT;
    a[2] = (PING, 20);
    let o = beat(&mut st, a);
    assert_eq!((o.desks[0].fill_amt, o.desks[2].fill_amt), (10, 5));
}

/// I7: a skim never exceeds resting; an empty order cannot be filled.
#[test]
fn i7_skim_capped_by_resting() {
    let mut st = live_state([3, 3, 1, 2, 4, 5, 6, 7]);
    st.resting[1] = 7;
    st.streak[0 * 8 + 1] = 2;
    let mut a = [IDLE_ACT; 8];
    a[0] = (PING, 3);
    let o = beat(&mut st, a);
    assert_eq!((o.desks[0].fill_amt, st.resting[1]), (7, 0));
    let o = beat(&mut st, a);
    assert_eq!((o.desks[0].fill_amt, o.desks[0].result, o.desks[1].hits_taken), (0, RES_MISS, 0));
    // property: random states, every skim ≤ resting before the ping
    let mut r = Rng(9);
    for _ in 0..20_000 {
        let mut st = live_state(core::array::from_fn(|_| 1 + r.below(3) as u8));
        for s in 0..8 {
            st.resting[s] = r.below(101) as u16;
        }
        for x in st.streak.iter_mut() {
            *x = r.below(4) as u8;
        }
        let rest0 = st.resting;
        let pick0 = st.picked;
        let a: [(u8, u8); 8] = core::array::from_fn(|_| (PING, 1 + r.below(3) as u8));
        let o = beat(&mut st, a);
        for v in 0..8 {
            assert!(o.desks[v].lost_amt <= rest0[v]);
            assert_eq!(st.resting[v], rest0[v] - o.desks[v].lost_amt);
            assert_eq!(st.picked[v], pick0[v] + o.desks[v].fill_amt);
        }
    }
}

/// I8: the algo never pings its own level and respects the 4-beat memory when it can; the
/// choice is uniform over the eligible levels.
#[test]
fn i8_algo_own_level_and_memory() {
    let mut r = Rng(77);
    let mut hits = [0u64; 24];
    for _ in 0..20_000 {
        let mut st = live_state(core::array::from_fn(|_| 1 + r.below(24) as u8));
        st.seed = r.bytes::<32>();
        let b = 1 + r.below(29) as u16;
        let dense = r.below(3) == 0;
        for d in 0..8 {
            for l in 0..24 {
                let p = if dense { 1 } else { r.below(3) };
                st.last_pinged[d * 24 + l] = if p == 0 { 0 } else { 1 + r.below(b as u64) as u16 };
                if dense {
                    st.last_pinged[d * 24 + l] = b.saturating_sub(r.below(4) as u16).max(1);
                }
            }
        }
        let mut out = [0u8; 8];
        compute_algo::<Sha256>(&st, b, &mut out);
        for d in 0..8 {
            let l = out[d];
            assert!((1..=24).contains(&l));
            assert_ne!(l, st.level[d], "algo pinged its own level");
            let eligible = |l: usize| {
                let lp = st.last_pinged[d * 24 + l - 1];
                l != st.level[d] as usize && (lp == 0 || b - lp > 4)
            };
            let any = (1..=24).any(eligible);
            if any {
                assert!(eligible(l as usize), "memory not respected");
            }
        }
    }
    // uniformity: fresh state, desk 0 on level 24 → uniform on 1..=23
    for i in 0..23_000u64 {
        let mut st = live_state([24, 1, 1, 1, 1, 1, 1, 1]);
        st.seed[..8].copy_from_slice(&i.to_le_bytes());
        let mut out = [0u8; 8];
        compute_algo::<Sha256>(&st, 1, &mut out);
        hits[out[0] as usize - 1] += 1;
    }
    assert_eq!(hits[23], 0);
    let chi: f64 = hits[..23].iter().map(|&x| (x as f64 - 1000.0).powi(2) / 1000.0).sum();
    assert!(chi < 48.27, "chi2 {chi}"); // 22 dof, p = 0.001
}

/// The tick path: a silent desk's action is the algo preview it was shown, flagged algo.
#[test]
fn algo_preview_matches_resolved_action() {
    for seed in 0..300 {
        let mut prev: Option<[u8; 8]> = None;
        play_random(seed, |a, _, out| {
            if let Some(nx) = prev {
                for s in 0..8 {
                    let d = out.desks[s];
                    if a.pending_kind[s] == 0 {
                        assert_eq!((d.action_kind, d.action_level, d.action_algo), (PING, nx[s], 1));
                    } else {
                        assert_eq!(d.action_algo, 0);
                    }
                }
            }
            prev = Some(out.desks.map(|d| d.next_algo));
        });
    }
}

/// open_round resets every field (nothing carries across rounds).
#[test]
fn open_round_resets_everything() {
    let p = play_random(5, |_, _, _| {});
    let mut st = p.st;
    open_round(&mut st);
    let mut fresh = RoundState::zeroed();
    fresh.resting = [100; 8];
    fresh.phase = HIDE;
    assert_eq!(st, fresh);
}
