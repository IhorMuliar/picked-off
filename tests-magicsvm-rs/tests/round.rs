//! A full recorded round with 8 desks: HIDE -> LIVE -> BELL -> reveal -> unseal, then the next
//! round's re-seal and reset (nothing of round n readable in round n+1).
mod common;
use common::*;
use solana_signer::Signer;

/// Plays live beats with random acts until the bell; returns the number of live beats.
pub fn play_live(e: &mut Env, pool: &mut Pool, rng: &mut Rng) -> u16 {
    let mut beats = 0;
    loop {
        let t = e.er(&pool.table);
        if t[off::table::PHASE] != LIVE {
            break;
        }
        let deadline = u64_at(&t, off::table::NEXT_DEADLINE);
        e.warp(pool, deadline - 1);
        for s in 0..8 {
            if rng.below(4) != 0 {
                let kind = 1 + rng.below(2) as u8;
                let lvl = 1 + rng.below(24) as u8;
                e.act(pool, s, kind, lvl, [0; 16]);
            }
        }
        e.warp_resolve(pool, deadline);
        let t = e.er(&pool.table);
        assert!(u16_at(&t, off::table::BEAT) > beats, "beat did not resolve at its deadline");
        beats = u16_at(&t, off::table::BEAT);
    }
    beats
}

#[test]
fn full_round_with_eight_desks() {
    let mut e = Env::new();
    let mut pool = e.pool(1, None);
    let mut rng = Rng(7);
    e.record(&pool, 1);
    e.open(&pool, 1, true);
    let t = e.er(&pool.table);
    assert_eq!(t[off::table::PHASE], HIDE);
    assert_eq!(u64_at(&t, off::table::ROUND), 1);
    // privacy: nobody reads the Book; each Desk only by its seated key; the Table by everyone
    let stranger = solana_keypair::Keypair::new().pubkey();
    assert!(!e.can_read(None, &pool.book) && !e.can_read(Some(stranger), &pool.book));
    assert!(!e.can_read(Some(pool.bots[0].pubkey()), &pool.book));
    for s in 0..8 {
        assert!(e.can_read(Some(pool.bots[s].pubkey()), &pool.desks[s]));
        assert!(!e.can_read(Some(pool.bots[(s + 1) % 8].pubkey()), &pool.desks[s]));
        assert!(!e.can_read(None, &pool.desks[s]));
    }
    assert!(e.can_read(None, &pool.table));
    // HIDE: every desk places (some twice)
    for s in 0..8 {
        e.act(&mut pool, s, 2, 1 + rng.below(24) as u8, rng.salt());
    }
    let deadline = u64_at(&e.er(&pool.table), off::table::NEXT_DEADLINE);
    e.warp_resolve(&pool, deadline);
    let t = e.er(&pool.table);
    assert_eq!(t[off::table::PHASE], LIVE, "HIDE did not end");
    assert_eq!(t[off::table::FALLBACK], 0, "VRF output not used");
    assert_eq!(t[off::table::VRF_FULFILS], 1);
    let beats = play_live(&mut e, &mut pool, &mut rng);
    let t = e.er(&pool.table);
    assert_eq!(t[off::table::PHASE], BELL);
    assert!((20..=29).contains(&beats), "bell after {beats}");
    // conservation on the public row
    let picked: u32 = (0..8).map(|s| u16_at(&t, off::table::PICKED + 2 * s) as u32).sum();
    let totals: u32 = (0..8).map(|s| u16_at(&t, off::table::TOTALS + 2 * s) as u32).sum();
    assert_eq!(totals, 800);
    assert!(picked > 0);
    e.reveal(&pool, Some(1));
    let t = e.er(&pool.table);
    assert_eq!(t[off::table::PHASE], REVEALED);
    assert_eq!(u16_at(&t, off::table::SEALED), 0);
    let r = e.er(&pool.round_pda(1));
    assert_eq!(r[off::round::STATUS], 2);
    let rec: [u8; ping_core::RECORD_LEN] = r[off::round::RECORD..off::round::RECORD + ping_core::RECORD_LEN].try_into().unwrap();
    let commit: [u8; 32] = r[off::round::COMMIT..off::round::COMMIT + 32].try_into().unwrap();
    assert_eq!(&commit[..], &t[off::table::COMMIT..off::table::COMMIT + 32]);
    let v = ping_core::verify::<ping_core::Sha256>(&rec, &commit).expect("record verifies");
    assert_eq!(v.top_desk, r[off::round::TOP_DESK]);
    assert_eq!(r[off::round::N_BEATS] as u16, beats);
    for s in 0..8 {
        assert_eq!(v.totals[s], u16_at(&r, off::round::TOTALS + 2 * s));
    }
    // crank cancelled: no tick after the reveal
    let calls = u64_at(&t, off::table::TICK_CALLS);
    let now = e.slot();
    e.warp(&pool, now + 40);
    assert_eq!(u64_at(&e.er(&pool.table), off::table::TICK_CALLS), calls, "crank still running after reveal");
    e.unseal_all(&pool);
    assert!(e.can_read(None, &pool.book) && e.can_read(None, &pool.desks[3]), "unseal");
    println!("full round: {beats} live beats, top desk {}, record verified", v.top_desk);
    let _ = pool.bots[0].pubkey();
}
