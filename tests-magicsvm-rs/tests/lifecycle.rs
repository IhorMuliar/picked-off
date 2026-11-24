//! Round lifecycle: reset after `open_round`, crank task ids, `reschedule_crank`, the VRF wait
//! and the fallback seed, and the `join` rules.
mod common;
use common::*;
use solana_account::Account;
use solana_keypair::Keypair;
use solana_signer::Signer;

/// Plays a round to the bell with random acts (crank-driven).
fn play_to_bell(e: &mut Env, pool: &mut Pool, rng: &mut Rng) {
    for s in 0..8 {
        e.act(pool, s, 2, 1 + rng.below(24) as u8, rng.salt());
    }
    let d = u64_at(&e.er(&pool.table), off::table::NEXT_DEADLINE);
    e.warp_resolve(pool, d);
    while e.er(&pool.table)[off::table::PHASE] == LIVE {
        let d = u64_at(&e.er(&pool.table), off::table::NEXT_DEADLINE);
        e.warp(pool, d - 1);
        for s in 0..8 {
            if rng.below(3) != 0 {
                e.act(pool, s, 1 + rng.below(2) as u8, 1 + rng.below(24) as u8, [0; 16]);
            }
        }
        e.warp_resolve(pool, d);
    }
    assert_eq!(e.er(&pool.table)[off::table::PHASE], BELL);
}

fn set_slot_hash(e: &mut Env, h: u8) {
    let mut data = vec![0u8; 8 + 40];
    data[0] = 1;
    data[8..16].copy_from_slice(&e.slot().to_le_bytes());
    data[16..48].fill(h);
    let sysvar = Address::from_str_const("Sysvar1111111111111111111111111111111111111");
    e.svm.set_account(SLOT_HASHES, Account { lamports: 1_000_000, data, owner: sysvar, executable: false, rent_epoch: 0 }).unwrap();
}
use solana_address::Address;

#[test]
fn reset_after_open_round_leaves_nothing_of_the_previous_round() {
    let mut e = Env::new();
    let mut rng = Rng(3);
    let mut pool = e.pool(30, None);
    e.open(&pool, 1, false);
    let task1 = u64_at(&e.er(&pool.table), off::table::TASK_ID);
    play_to_bell(&mut e, &mut pool, &mut rng);
    e.reveal(&pool, None);
    e.unseal_all(&pool);
    // open_round refuses until the Book and all Desks are re-sealed
    let h = e.house.insecure_clone();
    let ix = e.ix_open_round(&pool, 2, false);
    assert!(e.send(Er, &h, &[], &[ix]).is_err(), "open_round ran while unsealed");
    e.reseal(&pool);
    let seqs: Vec<u32> = (0..8).map(|s| u32_at(&e.er(&pool.desks[s]), off::desk::LAST_SEQ)).collect();
    set_slot_hash(&mut e, 0x5a);
    e.open(&pool, 2, false);
    // Book: header and engine state at their initial values (VRF not yet delivered)
    let b = e.er(&pool.book);
    let mut st = ping_core::RoundState::zeroed();
    ping_core::open_round(&mut st);
    let want: &[u8] = unsafe { core::slice::from_raw_parts(&st as *const _ as *const u8, off::book::STATE_LEN) };
    assert_eq!(&b[off::book::STATE..off::book::STATE + off::book::STATE_LEN], want, "Book state not reset");
    assert_eq!(u64_at(&b, off::book::ROUND), 2);
    assert_eq!(u64_at(&b, off::book::VRF_SLOT), 0);
    assert!(b[32..40].iter().all(|x| *x == 0) && b[1185..].iter().all(|x| *x == 0));
    // Desks: everything zero except identity, key, last_seq, round, stake, phase, layout
    for s in 0..8 {
        let d = e.er(&pool.desks[s]);
        let mut want = vec![0u8; 608];
        want[..8].copy_from_slice(&d[..8]);
        want[8..16].copy_from_slice(&30u64.to_le_bytes());
        want[16..24].copy_from_slice(&2u64.to_le_bytes());
        want[40..72].copy_from_slice(pool.bots[s].pubkey().as_ref());
        want[72..76].copy_from_slice(&seqs[s].to_le_bytes());
        want[80..82].copy_from_slice(&100u16.to_le_bytes());
        want[86] = s as u8;
        want[88] = HIDE;
        want[93] = 1;
        assert_eq!(d, want, "desk {s} not reset");
    }
    // Table: round fields reset
    let t = e.er(&pool.table);
    for (o, n) in [(off::table::PICKED, 16), (off::table::TOTALS, 16), (off::table::BEAT_FILL, 16), (off::table::PRINTS, 192), (off::table::BEAT_COUNTS, 64), (off::table::CHAIN_HEAD, 64)] {
        assert!(t[o..o + n].iter().all(|x| *x == 0), "table field at {o} not reset");
    }
    assert_eq!(u16_at(&t, off::table::BEAT), 0);
    assert_eq!(u32_at(&t, off::table::PRINT_COUNT), 0);
    assert_eq!(t[off::table::TOP_DESK], 255);
    assert_eq!(t[off::table::FALLBACK], 0);
    assert_eq!(t[off::table::VRF_FULFILS], 0);
    assert_eq!(t[off::table::PHASE], HIDE);
    let task2 = u64_at(&t, off::table::TASK_ID);
    assert_ne!(task1, task2);
    println!("reset: Book, 8 Desks and Table round fields at initial values; task ids {task1} -> {task2}");
}

#[test]
fn task_id_changes_with_the_slot_hash() {
    let ids: Vec<u64> = [0x11u8, 0x22, 0x11]
        .iter()
        .map(|h| {
            let mut e = Env::new();
            let pool = e.pool(40, None);
            set_slot_hash(&mut e, *h);
            e.open(&pool, 1, false);
            u64_at(&e.er(&pool.table), off::table::TASK_ID)
        })
        .collect();
    println!("task ids for slot hashes 11, 22, 11: {ids:?}");
    assert_ne!(ids[0], ids[1], "task id ignores the slot hash");
    assert_eq!(ids[0], ids[2], "same inputs, same id");
    assert!(ids.iter().all(|x| *x < 1 << 63));
}

#[test]
fn reschedule_crank_after_a_stall() {
    let mut e = Env::new();
    // the crank dies after 30 iterations (HIDE is 21 of them): beats stall early in LIVE
    e.set_config(Params { crank_iterations: 30, ..Params::default() });
    let mut pool = e.pool(50, None);
    let stranger = Keypair::new();
    e.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    e.open(&pool, 1, false);
    let old = u64_at(&e.er(&pool.table), off::table::TASK_ID);
    let h = e.house.insecure_clone();
    // not stalled during HIDE
    let ix = e.ix_reschedule(&pool);
    assert!(e.send(Er, &h, &[], &[ix]).is_err(), "reschedule allowed without a stall");
    for s in 0..8 {
        e.act(&mut pool, s, 2, 1 + s as u8, [s as u8; 16]);
    }
    let start = e.slot();
    e.warp(&pool, start + 240);
    let t = e.er(&pool.table);
    let beat = u16_at(&t, off::table::BEAT);
    let deadline = u64_at(&t, off::table::NEXT_DEADLINE);
    assert_eq!(t[off::table::PHASE], LIVE);
    assert!(e.slot() >= deadline + 60, "crank should have stopped (beat {beat})");
    // a stranger cannot reschedule
    let mut ix = e.ix_reschedule(&pool);
    ix.accounts[0].pubkey = stranger.pubkey();
    assert!(e.send(Er, &stranger, &[], &[ix]).is_err(), "stranger rescheduled the crank");
    set_slot_hash(&mut e, 0x77);
    let ix = e.ix_reschedule(&pool);
    e.ok(Er, &h, &[], &[ix], "reschedule_crank");
    let new = u64_at(&e.er(&pool.table), off::table::TASK_ID);
    assert_ne!(old, new, "fresh task id");
    let now = e.slot();
    e.warp(&pool, now + 40);
    let beat2 = u16_at(&e.er(&pool.table), off::table::BEAT);
    assert!(beat2 > beat, "crank did not resume ({beat} -> {beat2})");
    println!("reschedule: stalled at beat {beat}, task {old} -> {new}, resumed to beat {beat2}");
}

#[test]
fn hide_end_waits_for_the_vrf_output() {
    // HIDE of 0 slots: the deadline is the open slot, before the VRF output can land
    let mut e = Env::new();
    e.set_config(Params { hide_slots: 0, ..Params::default() });
    let pool = e.pool(60, None);
    e.open(&pool, 1, false);
    e.tick(&pool);
    let t = e.er(&pool.table);
    assert_eq!(t[off::table::PHASE], HIDE, "HIDE ended before the VRF output");
    assert_eq!(u64_at(&t, off::table::RESOLVES), 0);
    let s = e.slot();
    e.warp(&pool, s + 1);
    let t = e.er(&pool.table);
    assert_eq!(t[off::table::VRF_FULFILS], 1);
    assert_eq!(t[off::table::PHASE], LIVE, "HIDE end after the VRF output");
    assert_eq!(t[off::table::FALLBACK], 0);
    let b = e.er(&pool.book);
    assert_eq!(b[off::book::STATE + 1141], 1, "vrf_set");
    assert_eq!(b[off::book::STATE + 1142], 0, "fallback");
}

#[test]
fn fallback_seed_after_the_wait_and_late_vrf_is_ignored() {
    // beat_slots 0: the VRF wait (2 beats) is over at once, so the HIDE end draws the fallback
    let mut e = Env::new();
    e.set_config(Params { hide_slots: 0, beat_slots: 0, ..Params::default() });
    let pool = e.pool(61, None);
    e.record(&pool, 1);
    e.open(&pool, 1, true);
    e.tick(&pool);
    let t = e.er(&pool.table);
    assert_eq!(t[off::table::PHASE], LIVE);
    assert_eq!(t[off::table::FALLBACK], 1, "fallback flag on the Table");
    // the VRF output lands one slot later: no effect
    let s = e.slot();
    e.warp(&pool, s + 1);
    let t = e.er(&pool.table);
    assert_eq!(t[off::table::VRF_FULFILS], 0, "late fulfil counted");
    let b = e.er(&pool.book);
    assert_eq!(b[off::book::STATE + 1141], 0, "late VRF stored");
    assert_eq!(b[off::book::STATE + 1142], 1);
    while e.er(&pool.table)[off::table::PHASE] == LIVE {
        e.tick(&pool);
    }
    e.reveal(&pool, Some(1));
    let r = e.er(&pool.round_pda(1));
    assert_eq!(r[off::round::FALLBACK], 1, "Round.fallback_seed");
    let rec: [u8; ping_core::RECORD_LEN] = r[off::round::RECORD..off::round::RECORD + ping_core::RECORD_LEN].try_into().unwrap();
    let commit: [u8; 32] = r[off::round::COMMIT..off::round::COMMIT + 32].try_into().unwrap();
    ping_core::verify::<ping_core::Sha256>(&rec, &commit).expect("fallback round verifies");
}

#[test]
fn vrf_disabled_pool_uses_the_fallback_at_the_deadline() {
    let mut e = Env::new();
    e.set_config(Params { vrf: false, ..Params::default() });
    let pool = e.pool(62, None);
    e.open(&pool, 1, false);
    let d = u64_at(&e.er(&pool.table), off::table::NEXT_DEADLINE);
    e.warp_resolve(&pool, d);
    let t = e.er(&pool.table);
    assert_eq!(t[off::table::PHASE], LIVE);
    assert_eq!(t[off::table::FALLBACK], 1);
    assert!(u64_at(&t, off::table::HIDE_END_SLOT) <= d + 5);
}

#[test]
fn join_rules() {
    let mut e = Env::new();
    let mut pool = e.pool(70, None);
    let other = e.pool(71, None);
    let p1 = Keypair::new();
    let p2 = Keypair::new();
    // join before any round (IDLE): takes bot desk 3
    let ix = e.ix_join(&pool, &p1.pubkey(), 3, None);
    e.ok(Er, &p1, &[], &[ix], "join");
    let t = e.er(&pool.table);
    let seat = off::table::SEATS + 56 * 3;
    assert_eq!(&t[seat..seat + 32], p1.pubkey().as_ref());
    assert_eq!(t[seat + 48], 1, "seat kind human");
    assert_eq!(&e.er(&pool.desks[3])[off::desk::KEY..off::desk::KEY + 32], p1.pubkey().as_ref());
    // a second desk for the same key: refused
    let ix = e.ix_join(&pool, &p1.pubkey(), 4, None);
    assert!(e.send(Er, &p1, &[], &[ix]).is_err(), "one key took two desks");
    // a human's desk: refused
    let ix = e.ix_join(&pool, &p2.pubkey(), 3, None);
    assert!(e.send(Er, &p2, &[], &[ix]).is_err(), "took a human's desk");
    // a desk of another table: refused (seeds)
    let ix = e.ix_join(&pool, &p2.pubkey(), 5, Some(other.desks[5]));
    assert!(e.send(Er, &p2, &[], &[ix]).is_err(), "joined another table's desk");
    // bad seat index
    let ix = e.ix_join(&pool, &p2.pubkey(), 8, Some(pool.desks[0]));
    assert!(e.send(Er, &p2, &[], &[ix]).is_err(), "seat 8");
    // the round opens; p1's acts land, the old bot's are no-ops
    e.open(&pool, 1, false);
    let ix = Env::ix_act(&p1.pubkey(), &pool.desks[3], &pool.book, 2, 11, 5, [9; 16]);
    e.ok(Er, &p1, &[], &[ix], "act");
    let d = e.er(&pool.desks[3]);
    assert_eq!(u32_at(&d, off::desk::LAST_SEQ), 5);
    assert_eq!(d[off::desk::LEVEL], 11);
    assert_eq!(d[off::desk::PLACED], 1);
    let bot3 = pool.bots[3].insecure_clone();
    e.act_raw(&bot3, &pool.desks[3], &pool.book, 2, 12, 99, [9; 16]);
    assert_eq!(u32_at(&e.er(&pool.desks[3]), off::desk::LAST_SEQ), 5, "old bot key still acts");
    // join in HIDE: allowed
    let ix = e.ix_join(&pool, &p2.pubkey(), 6, None);
    e.ok(Er, &p2, &[], &[ix], "join in HIDE");
    // LIVE: allowed (takeover as it stands); BELL: refused
    let dl = u64_at(&e.er(&pool.table), off::table::NEXT_DEADLINE);
    e.warp_resolve(&pool, dl);
    let p3 = Keypair::new();
    let ix = e.ix_join(&pool, &p3.pubkey(), 7, None);
    e.ok(Er, &p3, &[], &[ix], "join in LIVE");
    while e.er(&pool.table)[off::table::PHASE] == LIVE {
        e.tick(&pool);
        let d = u64_at(&e.er(&pool.table), off::table::NEXT_DEADLINE);
        let now = e.slot();
        if d > now {
            assert!(e.svm.warp_to_slot(d).iter().all(|r| r.is_ok()));
        }
    }
    assert_eq!(e.er(&pool.table)[off::table::PHASE], BELL);
    let p4 = Keypair::new();
    let ix = e.ix_join(&pool, &p4.pubkey(), 0, None);
    assert!(e.send(Er, &p4, &[], &[ix]).is_err(), "joined during BELL");
    let _ = &mut pool;
}

/// The house reclaims a human's seat with `join_bot` only between rounds.
#[test]
fn join_bot_reclaims_a_human_seat_only_between_rounds() {
    let mut e = Env::new();
    let mut rng = Rng(11);
    let mut pool = e.pool(72, None);
    let h = e.house.insecure_clone();
    let human = Keypair::new();
    let ix = e.ix_join(&pool, &human.pubkey(), 2, None);
    e.ok(Er, &human, &[], &[ix], "join");
    let bot = Keypair::new();
    let try_reclaim = |e: &mut Env, pool: &Pool| {
        let ix = e.ix_join_bot(pool, 2, &bot.pubkey());
        e.send(Er, &h, &[], &[ix])
    };
    // HIDE, LIVE, BELL: refused
    e.open(&pool, 1, false);
    assert!(try_reclaim(&mut e, &pool).is_err(), "reclaimed in HIDE");
    let d = u64_at(&e.er(&pool.table), off::table::NEXT_DEADLINE);
    e.warp_resolve(&pool, d);
    assert!(try_reclaim(&mut e, &pool).is_err(), "reclaimed in LIVE");
    while e.er(&pool.table)[off::table::PHASE] == LIVE {
        let d = u64_at(&e.er(&pool.table), off::table::NEXT_DEADLINE);
        e.warp_resolve(&pool, d);
    }
    assert!(try_reclaim(&mut e, &pool).is_err(), "reclaimed in BELL");
    // REVEALED: allowed; the seat is a bot again and the human's key is out
    e.reveal(&pool, None);
    try_reclaim(&mut e, &pool).expect("reclaim in REVEALED");
    let t = e.er(&pool.table);
    let seat = off::table::SEATS + 56 * 2;
    assert_eq!(&t[seat..seat + 32], bot.pubkey().as_ref());
    assert_eq!(t[seat + 48], 2, "seat kind bot");
    assert_eq!(&e.er(&pool.desks[2])[off::desk::KEY..off::desk::KEY + 32], bot.pubkey().as_ref());
    assert!(e.can_read(Some(bot.pubkey()), &pool.desks[2]) && !e.can_read(Some(human.pubkey()), &pool.desks[2]));
    // a stranger cannot do it
    let s = Keypair::new();
    let mut ix = e.ix_join_bot(&pool, 3, &s.pubkey());
    ix.accounts[0].pubkey = s.pubkey();
    assert!(e.send(Er, &s, &[], &[ix]).is_err(), "stranger seated a bot");
    // IDLE (a fresh pool) works too
    let mut p2 = e.pool(73, None);
    let ix = e.ix_join(&p2, &human.pubkey(), 5, None);
    e.ok(Er, &human, &[], &[ix], "join p2");
    let ix = e.ix_join_bot(&p2, 5, &bot.pubkey());
    e.ok(Er, &h, &[], &[ix], "reclaim in IDLE");
    let _ = (&mut pool, &mut p2, &mut rng);
}

