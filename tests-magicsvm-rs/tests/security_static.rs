//! Security checks that need no ledger: seed derivations, the bell draw, the absence of program
//! logs, engine arithmetic over extreme play, and the fresh state of every round.
//! The ledger-backed checks are in security_base.rs (Solana) and security_rollup.rs (rollup).
mod common;
use common::*;
use ping_core::{BeatOut, NoSink, RoundState, Sha256};
use solana_address::Address;
use std::collections::HashSet;
use std::path::Path;

const PREFIXES: [&[u8]; 8] = [b"config", b"table", b"book", b"desk", b"round", b"tape", b"call", b"ledger"];

/// Every PDA kind for many tables, rounds and bettors is distinct, and no seed prefix is a
/// prefix of another (seeds are hashed concatenated, so this is what rules out collisions).
#[test]
fn s09_seeds_never_collide() {
    for a in PREFIXES {
        for b in PREFIXES {
            assert!(a == b || !b.starts_with(a), "prefix {:?} is a prefix of {:?}", a, b);
        }
    }
    let mut seen = HashSet::new();
    let mut add = |a: Address, what: String| assert!(seen.insert(a), "collision at {what}");
    add(pda(&[b"config"]).0, "config".into());
    let bettors: Vec<Address> = (0..4u8).map(|i| Address::new_from_array([i + 1; 32])).collect();
    for t in [0u64, 1, 2, 255, 256, 1 << 32, u64::MAX] {
        let tb = t.to_le_bytes();
        add(pda(&[b"table", &tb]).0, format!("table {t}"));
        add(pda(&[b"book", &tb]).0, format!("book {t}"));
        add(pda(&[b"ledger", &tb]).0, format!("ledger {t}"));
        for s in 0..8u8 {
            add(pda(&[b"desk", &tb, &[s]]).0, format!("desk {t}/{s}"));
        }
        for n in [0u64, 1, 2, 3, 100, u64::MAX] {
            let nb = n.to_le_bytes();
            add(pda(&[b"round", &tb, &nb]).0, format!("round {t}/{n}"));
            let tape = pda(&[b"tape", &tb, &nb]).0;
            add(tape, format!("tape {t}/{n}"));
            for b in &bettors {
                add(Env::call_pda(&tape, b), format!("call {t}/{n}/{b}"));
            }
        }
    }
    println!("s09: {} PDAs, no collisions", seen.len());
}

/// The bell beat is `20 + H("ping/bell" || seed) % 10`: uniform on 20..=29 (chi-square,
/// 2,000 seeds, 9 degrees of freedom, p = 0.001 critical value 27.9). The engine's own property
/// test (crates/ping-core tests/props.rs `i6_bell_uniform`) checks it through whole rounds.
#[test]
fn s10_bell_uniform_on_20_to_29() {
    let mut rng = Rng(10);
    let mut bins = [0u32; 10];
    let n = 2000;
    for _ in 0..n {
        let seed: [u8; 32] = core::array::from_fn(|_| rng.next() as u8);
        let b = ping_core::derive_bell::<Sha256>(&seed);
        assert!((20..=29).contains(&b), "bell {b}");
        bins[(b - 20) as usize] += 1;
    }
    let e = n as f64 / 10.0;
    let chi: f64 = bins.iter().map(|&o| (o as f64 - e).powi(2) / e).sum();
    println!("s10: bell bins {bins:?}, chi-square {chi:.2}");
    assert!(chi < 27.9, "bell not uniform: chi-square {chi}");
}

fn rust_files(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    for e in std::fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        if p.is_dir() {
            rust_files(&p, out);
        } else if p.extension().is_some_and(|x| x == "rs") {
            out.push(p);
        }
    }
}

/// No logging macro or syscall anywhere in the program, and the build
/// strips Anchor's instruction-name log line and the panic message.
#[test]
fn s14_program_has_no_logs() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../programs/ping");
    let mut files = Vec::new();
    rust_files(&root.join("src"), &mut files);
    assert!(files.len() > 20);
    for f in &files {
        let src = std::fs::read_to_string(f).unwrap();
        for needle in ["msg!", "emit!", "emit_cpi!", "sol_log"] {
            assert!(!src.contains(needle), "{} contains {needle}", f.display());
        }
    }
    let toml = std::fs::read_to_string(root.join("Cargo.toml")).unwrap();
    let default = toml.lines().find(|l| l.trim_start().starts_with("default")).expect("default features");
    assert!(default.contains("no-log-ix-name") && default.contains("custom-panic"), "default features: {default}");
    println!("s14: {} program files, no log calls; default features: {default}", files.len());
}

/// Plays one engine round with the given per-beat choices and returns the state at the bell.
fn engine_round(st: &mut RoundState, table: u64, round: u64, rng: &mut Rng, mode: u64) {
    ping_core::open_round(st);
    for s in 0..8 {
        let lvl = match mode {
            0 => 7,                         // everyone on one level
            1 => 1 + (s as u8 % 2) * 23,    // two crowded extremes
            _ => 1 + rng.below(24) as u8,   // random
        };
        let place = mode != 3 || s % 2 == 0; // mode 3: half the desks never place
        ping_core::record_act::<Sha256>(st, s, 2, lvl, &[s as u8; 16], place as u64);
    }
    ping_core::set_vrf(st, &core::array::from_fn(|i| (i as u8).wrapping_mul(31) ^ rng.next() as u8));
    let mut out = BeatOut::zeroed();
    let mut slot = 1000u64;
    for _ in 0..40 {
        slot += 150;
        ping_core::tick::<Sha256, NoSink>(st, table, round, slot, &mut NoSink, &mut out);
        if st.phase == ping_core::BELL {
            break;
        }
        for s in 0..8 {
            let (k, l) = match mode {
                0 => (1, 7),                                   // everyone pings the crowded level
                1 => (1, 1 + ((s as u8 + 1) % 2) * 23),        // ping the other extreme
                _ => (rng.below(4) as u8, rng.below(30) as u8), // junk included
            };
            ping_core::record_act::<Sha256>(st, s, k, l, &[0; 16], rng.below(4).min(1));
        }
    }
    assert_eq!(st.phase, ping_core::BELL, "no bell");
}

/// The engine's arithmetic never overflows (this test runs with overflow checks on, as the
/// program does): 2,000 rounds of crowded, extreme and junk play; conservation holds at the bell.
/// The engine's own property tests (crates/ping-core tests/props.rs) and the in-process act fuzz
/// (cu.rs `act_fuzz_never_fails`) cover the rest; counter wrap in the program is in
/// security_rollup.rs `s11_program_counters_wrap_instead_of_failing`.
#[test]
fn s11_engine_arithmetic_never_overflows() {
    assert!(cfg!(debug_assertions), "run with overflow checks (the test profile)");
    let mut rng = Rng(11);
    let mut st = RoundState::zeroed();
    for i in 0..2000u64 {
        engine_round(&mut st, i, i + 1, &mut rng, i % 4);
        let total: u32 = (0..8).map(|s| st.resting[s] as u32 + st.picked[s] as u32).sum();
        assert_eq!(total, 800, "conservation");
        assert!(st.streak.iter().all(|&x| x <= 200));
    }
    println!("s11: 2,000 extreme engine rounds, no overflow, Σ = 800 every time");
}

/// `open_round` puts every engine field back to its initial value, whatever the previous
/// round left, and a desk that does not place in HIDE gets a level drawn from the new seed alone:
/// over 2,000 rounds (16,000 desk draws) the default level is uniform on 1..=24 and equal to the
/// desk's previous level 1/24 of the time (chi-square, 23 df, p = 0.001 critical value 49.7).
/// The program-level reset (Book, Desks, Table) is lifecycle.rs
/// `reset_after_open_round_leaves_nothing_of_the_previous_round`.
#[test]
fn s19_nothing_survives_open_round() {
    let mut rng = Rng(19);
    let mut fresh = RoundState::zeroed();
    ping_core::open_round(&mut fresh);
    let mut st = RoundState::zeroed();
    let mut bins = [0u32; 24];
    let mut same = 0u32;
    let n = 2000u64;
    for i in 0..n {
        engine_round(&mut st, 5, i + 1, &mut rng, 2);
        let prev = st.level;
        ping_core::open_round(&mut st);
        assert_eq!(st, fresh, "state survived open_round");
        // HIDE with no placement at all, then the HIDE-end tick
        ping_core::set_vrf(&mut st, &core::array::from_fn(|_| rng.next() as u8));
        let mut out = BeatOut::zeroed();
        ping_core::tick::<Sha256, NoSink>(&mut st, 5, i + 1, 10, &mut NoSink, &mut out);
        for s in 0..8 {
            let l = st.level[s];
            assert!((1..=24).contains(&l));
            bins[l as usize - 1] += 1;
            same += (l == prev[s]) as u32;
        }
    }
    let draws = (n * 8) as f64;
    let e = draws / 24.0;
    let chi: f64 = bins.iter().map(|&o| (o as f64 - e).powi(2) / e).sum();
    let frac = same as f64 / draws;
    println!("s19: default levels chi-square {chi:.1}, same-as-previous {frac:.4} (1/24 = 0.0417)");
    assert!(chi < 49.7, "default level not uniform: {chi}");
    assert!((frac - 1.0 / 24.0).abs() < 0.012, "default level tracks the previous level: {frac}");
}
