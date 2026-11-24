//! Constant compute: every resolving tick costs the same whatever the hidden state, every no-op
//! tick the same per public phase, and every `act` the same whatever its kind, level, phase,
//! signer or seq. Also: `act` never fails (fuzz).
mod common;
use common::*;
use ping_core::{derive_bell, derive_seed, Sha256 as H};
use solana_keypair::Keypair;
use solana_signer::Signer;

/// The engine's salt accumulator after these HIDE acts (all accepted).
fn salt_acc(acts: &[(usize, u8, u8, [u8; 16])]) -> [u8; 32] {
    let mut st = ping_core::RoundState::zeroed();
    ping_core::open_round(&mut st);
    for a in acts {
        ping_core::record_act::<H>(&mut st, a.0, a.1, a.2, &a.3, 1);
    }
    st.salt_acc
}

/// A VRF output that makes the bell ring after live beat `bell` for this round.
fn vrf_for_bell(salts: &[u8; 32], table: u64, round: u64, bell: u16) -> [u8; 32] {
    for i in 0u64.. {
        let v = sha(&[b"vrf", &i.to_le_bytes()]);
        if derive_bell::<H>(&derive_seed::<H>(&v, salts, table, round)) == bell {
            return v;
        }
    }
    unreachable!()
}

/// Scripted acts for live beat `b` of scenario round `k`: extreme and ordinary hidden states.
fn script(k: u64, b: u16, rng: &mut Rng) -> Vec<(usize, u8, u8)> {
    let all = |kind: u8, lvl: u8| (0..8).map(|s| (s, kind, lvl)).collect::<Vec<_>>();
    match (b as u64 + k) % 12 {
        0 => all(2, 5),                                         // everyone re-quotes onto one level
        1 | 2 => all(1, 5),                                     // everyone pings it (max hits, streaks up)
        3 => (0..8).map(|s| (s, 2, 1 + s as u8 * 3)).collect(), // all apart
        4 => (0..8).map(|s| (s, 1, 2 + s as u8 * 3)).collect(), // pings on empty levels
        5 => vec![],                                            // silent: every desk on its algo
        6 => (1..8).map(|s| (s, 1, 1)).collect(),               // seven hunters on desk 0's level
        7 => (0..8).map(|s| (s, 2, 1 + rng.below(24) as u8)).collect(), // re-quote everyone
        8 => (0..8).map(|s| (s, rng.below(256) as u8, rng.below(256) as u8)).collect(), // junk
        9 => (0..4).map(|s| (s, 1, 1 + rng.below(3) as u8)).collect(), // half silent, clustered
        _ => {
            let mut v = Vec::new();
            for s in 0..8 {
                if rng.below(3) != 0 {
                    v.push((s, 1 + rng.below(2) as u8, 1 + rng.below(24) as u8));
                }
            }
            v
        }
    }
}

#[test]
fn constant_compute_ticks_and_acts() {
    let mut e = Env::new();
    let mut cu = Cu::default();
    let mut rng = Rng(42);
    let stranger = Keypair::new();
    e.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    let mut pool = e.pool(9, None);
    let other = e.pool(10, None);
    let mut bells_seen = Vec::new();
    let mut seq_extra: u32 = 1_000_000;
    let mut joined = false;
    // act in IDLE (before the first round): masks, no effect
    for k in 0..4u8 {
        let c = e.act(&mut pool, k as usize, k, 7, rng.salt());
        cu.add("act", c);
    }
    for (k, bell) in (20u16..=29).enumerate() {
        let n = k as u64 + 1;
        if n > 1 {
            e.reseal(&pool);
        }
        e.record(&pool, n);
        // HIDE acts: first rounds all on one level, then spread, then random; some desks silent
        let hide: Vec<(usize, u8, u8, [u8; 16])> = (0..8)
            .filter(|s| !(k % 3 == 2 && s % 3 == 0))
            .map(|s| {
                let lvl = match k % 3 {
                    0 => 5,
                    1 => 1 + 3 * s as u8,
                    _ => 1 + rng.below(24) as u8,
                };
                (s, 2u8, lvl, rng.salt())
            })
            .collect();
        let v = vrf_for_bell(&salt_acc(&hide), pool.id, n, bell);
        e.svm.set_vrf_randomness(Some(v));
        e.open(&pool, n, true);
        for a in &hide {
            let c = e.act(&mut pool, a.0, a.1, a.2, a.3);
            cu.add("act", c);
        }
        // HIDE-phase act variants: wrong key, stale seq, other table's book, junk
        let c = e.act_raw(&stranger, &pool.desks[0], &pool.book, 2, 3, seq_extra, rng.salt());
        cu.add("act", c);
        let s1 = pool.seq[1] - 1;
        let c = e.act_raw(&pool.bots[1].insecure_clone(), &pool.desks[1], &pool.book, 2, 9, s1, rng.salt());
        cu.add("act", c);
        let c = e.act_raw(&pool.bots[2].insecure_clone(), &pool.desks[2], &other.book, 2, 9, seq_extra, rng.salt());
        cu.add("act", c);
        seq_extra += 1;
        let deadline = u64_at(&e.er(&pool.table), off::table::NEXT_DEADLINE);
        for (c, resolved, ph) in e.warp_resolve(&pool, deadline) {
            cu.add(&if resolved { "tick resolve hide-end".to_string() } else { format!("tick noop phase {ph}") }, c);
        }
        assert_eq!(e.er(&pool.table)[off::table::PHASE], LIVE);
        let mut beat = 0u16;
        while e.er(&pool.table)[off::table::PHASE] == LIVE {
            let deadline = u64_at(&e.er(&pool.table), off::table::NEXT_DEADLINE);
            for (c, resolved, ph) in e.warp(&pool, deadline - 2) {
                assert!(!resolved);
                cu.add(&format!("tick noop phase {ph}"), c);
            }
            for (s, kind, lvl) in script(k as u64, beat + 1, &mut rng) {
                let c = e.act(&mut pool, s, kind, lvl, [0; 16]);
                cu.add("act", c);
            }
            // a few masked variants every beat
            let c = e.act_raw(&stranger, &pool.desks[3], &pool.book, 1, 4, seq_extra, [1; 16]);
            cu.add("act", c);
            let s4 = pool.seq[4] - 1;
            let c = e.act_raw(&pool.bots[4].insecure_clone(), &pool.desks[4], &pool.book, 1, 4, s4, [2; 16]);
            cu.add("act", c);
            seq_extra += 1;
            let mut rcu = 0;
            for (c, resolved, ph) in e.warp_resolve(&pool, deadline) {
                if resolved {
                    rcu = c;
                }
                cu.add(&if resolved { "tick resolve live".to_string() } else { format!("tick noop phase {ph}") }, c);
            }
            beat = u16_at(&e.er(&pool.table), off::table::BEAT);
            if k == 3 && beat == 6 {
                // a burner takes desk 5 over mid-LIVE: it reads the Desk, the old key is out
                let burner = Keypair::new();
                let ix = e.ix_join(&pool, &burner.pubkey(), 5, None);
                e.ok(Er, &burner, &[], &[ix], "join in LIVE");
                assert!(e.can_read(Some(burner.pubkey()), &pool.desks[5]));
                assert!(!e.can_read(Some(pool.bots[5].pubkey()), &pool.desks[5]));
                let before = e.er(&pool.desks[5]);
                let old_key = pool.bots[5].insecure_clone();
                let c = e.act_raw(&old_key, &pool.desks[5], &pool.book, 1, 3, pool.seq[5] + 100, [3; 16]);
                cu.add("act", c);
                assert_eq!(e.er(&pool.desks[5]), before, "old key's act changed the Desk");
                // from now on desk 5 is driven by the burner, continuing above last_seq
                pool.bots[5] = burner;
                joined = true;
            }
            if std::env::var("PING_CU_TRACE").is_ok() {
                let t = e.er(&pool.table);
                let bc = off::table::BEAT_COUNTS + 2 * (beat as usize % 32);
                let mut f = [0u64; 4];
                for s in 0..8 {
                    let d = e.er(&pool.desks[s]);
                    let o = off::desk::RESULTS + 16 * beat as usize;
                    let r = &d[o..o + 16];
                    f[0] += (r[9] == 2) as u64; // requotes
                    f[1] += r[11] as u64; // algo
                    f[2] += r[13] as u64; // victims
                    f[3] += (u16::from_le_bytes([r[0], r[1]]) == 0) as u64; // empty desks
                }
                let lv: Vec<u8> = (0..8).map(|s| e.er(&pool.desks[s])[off::desk::LEVEL]).collect();
                let distinct = { let mut v = lv.clone(); v.sort(); v.dedup(); v.len() };
                eprintln!("TRACE cu={rcu} beat={beat} pings={} fills={} rq={} algo={} victims={} empty={} distinct_levels={distinct}", t[bc], t[bc + 1], f[0], f[1], f[2], f[3]);
            }
        }
        assert_eq!(e.er(&pool.table)[off::table::PHASE], BELL);
        assert_eq!(beat, bell, "forced bell");
        bells_seen.push(beat);
        // BELL-phase acts and no-op ticks until the reveal
        for s in 0..8 {
            let c = e.act(&mut pool, s, 1 + (s % 2) as u8, 3, [0; 16]);
            cu.add("act", c);
        }
        let now = e.slot();
        for (c, resolved, ph) in e.warp(&pool, now + 12) {
            assert!(!resolved);
            cu.add(&format!("tick noop phase {ph}"), c);
        }
        // manual (house fallback) ticks: no-op in BELL
        let c = e.tick(&pool);
        cu.add("manual tick noop phase 3", c);
        e.reveal(&pool, Some(n));
        let c = e.tick(&pool);
        cu.add("manual tick noop phase 4", c);
        for s in 0..8 {
            let c = e.act(&mut pool, s, 2, 6, [0; 16]);
            cu.add("act", c);
        }
        e.unseal_all(&pool);
    }
    assert!(joined, "mid-LIVE join not exercised");
    println!("bells: {bells_seen:?}\n{}", cu.report());
    assert!(cu.0["tick resolve live"].keys().all(|&c| c < 300_000));
    cu.assert_constant();
}

#[test]
fn act_fuzz_never_fails() {
    let mut e = Env::new();
    let mut cu = Cu::default();
    let mut rng = Rng(99);
    let strangers: Vec<Keypair> = (0..3).map(|_| Keypair::new()).collect();
    for s in &strangers {
        e.svm.airdrop(&s.pubkey(), 1_000_000_000).unwrap();
    }
    let pool = e.pool(20, None);
    let other = e.pool(21, None);
    let mut seqs = [1u32; 8];
    let mut fuzz = |e: &mut Env, cu: &mut Cu, rng: &mut Rng, n: usize, phase: &str| {
        for _ in 0..n {
            let d = rng.below(8) as usize;
            let signer = match rng.below(5) {
                0 => strangers[rng.below(3) as usize].insecure_clone(),
                1 => pool.bots[rng.below(8) as usize].insecure_clone(),
                _ => pool.bots[d].insecure_clone(),
            };
            let seq = match rng.below(6) {
                0 => rng.below(u32::MAX as u64) as u32,
                1 => seqs[d].saturating_sub(1),
                2 => 0,
                _ => {
                    seqs[d] = seqs[d].saturating_add(1 + rng.below(3) as u32);
                    seqs[d]
                }
            };
            let book = if rng.below(10) == 0 { other.book } else { pool.book };
            let c = e.act_raw(&signer, &pool.desks[d], &book, rng.below(256) as u8, rng.below(256) as u8, seq, rng.salt());
            cu.add("act", c);
            if rng.below(8) == 0 {
                // a stale or random seq that did not land moves our counter on anyway
                seqs[d] = seqs[d].max(u32_at(&e.er(&pool.desks[d]), off::desk::LAST_SEQ));
            }
        }
        let _ = phase;
    };
    fuzz(&mut e, &mut cu, &mut rng, 300, "idle");
    e.open(&pool, 1, false);
    fuzz(&mut e, &mut cu, &mut rng, 600, "hide");
    let deadline = u64_at(&e.er(&pool.table), off::table::NEXT_DEADLINE);
    e.warp_resolve(&pool, deadline);
    while e.er(&pool.table)[off::table::PHASE] == LIVE {
        fuzz(&mut e, &mut cu, &mut rng, 60, "live");
        let deadline = u64_at(&e.er(&pool.table), off::table::NEXT_DEADLINE);
        e.warp_resolve(&pool, deadline);
    }
    fuzz(&mut e, &mut cu, &mut rng, 300, "bell");
    e.reveal(&pool, None);
    fuzz(&mut e, &mut cu, &mut rng, 300, "revealed");
    let n: u64 = cu.0["act"].values().sum();
    println!("act fuzz: {n} acts, all succeeded\n{}", cu.report());
    assert!(n >= 2000);
    cu.assert_constant();
}
