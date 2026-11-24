//! Replay verifier and hash tests.
mod common;
use common::*;
use ping_core::*;

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

#[test]
fn sha256_known_answers() {
    assert_eq!(hex(&Sha256::hashv(&[b""])), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert_eq!(hex(&Sha256::hashv(&[b"a", b"bc"])), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    let m = b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";
    assert_eq!(hex(&Sha256::hashv(&[m])), "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
    let big = vec![b'a'; 1_000_000];
    assert_eq!(hex(&Sha256::hashv(&[&big])), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
}

#[test]
fn verifier_accepts_real_rounds_and_rejects_every_flipped_byte() {
    let mut flips = 0;
    for seed in [1u64, 2, 3] {
        let p = play_random(seed, |_, _, _| {});
        let rec = RoundRecord::from_state(&p.st, p.script.table_id, p.script.round);
        let mut bytes = [0u8; RECORD_LEN];
        rec.write(&mut bytes);
        assert_eq!(RoundRecord::read(&bytes), rec);
        let v = verify::<Sha256>(&bytes, &p.st.chain).unwrap();
        assert_eq!(v.commit, p.st.chain);
        assert_eq!(v.top_desk, p.st.top_desk);
        for i in 0..RECORD_LEN {
            for m in [0x01u8, 0x80, 0xff] {
                let mut b = bytes;
                b[i] ^= m;
                assert!(verify::<Sha256>(&b, &p.st.chain).is_err(), "seed {seed}: flip {m:#x} at byte {i} accepted");
                flips += 1;
            }
        }
        for i in 0..32 {
            let mut c = p.st.chain;
            c[i] ^= 1;
            assert_eq!(verify::<Sha256>(&bytes, &c), Err(VerifyError::BadCommit));
        }
    }
    println!("verifier rejected {flips} flipped records");
}

#[test]
fn verifier_rejects_forged_algo_and_trailing_rows() {
    let p = play_random(11, |_, _, _| {});
    let rec = RoundRecord::from_state(&p.st, p.script.table_id, p.script.round);
    let mut st = RoundState::zeroed();
    // a forged algo level is caught structurally, even before the commit check
    let mut f = rec;
    let i = (0..8).find(|&s| f.log[2 * s] & ALGO_FLAG != 0).expect("some algo ping on beat 1");
    f.log[2 * i + 1] = f.log[2 * i + 1] % 24 + 1;
    assert!(matches!(replay::<Sha256, _>(&f, &mut st, &mut NoSink, |_, _| {}), Err(VerifyError::BadAlgo { .. })));
    let mut f = rec;
    f.log[LOG_LEN - 1] = 1;
    if f.bell_beat < 29 {
        assert!(matches!(replay::<Sha256, _>(&f, &mut st, &mut NoSink, |_, _| {}), Err(VerifyError::TrailingLog { .. })));
    }
}

/// Field offsets of RoundState: the TypeScript decoder (app/src/core/state.ts) reads these.
#[test]
fn round_state_layout_is_stable() {
    use core::mem::offset_of;
    assert_eq!(core::mem::size_of::<RoundState>(), 1144);
    assert_eq!(core::mem::align_of::<RoundState>(), 2);
    let got = [
        offset_of!(RoundState, resting), offset_of!(RoundState, picked), offset_of!(RoundState, last_fill),
        offset_of!(RoundState, last_pinged), offset_of!(RoundState, beat), offset_of!(RoundState, bell_beat),
        offset_of!(RoundState, seed), offset_of!(RoundState, vrf), offset_of!(RoundState, salt_acc),
        offset_of!(RoundState, chain), offset_of!(RoundState, level), offset_of!(RoundState, initial_level),
        offset_of!(RoundState, placed), offset_of!(RoundState, pending_kind), offset_of!(RoundState, pending_level),
        offset_of!(RoundState, algo_next), offset_of!(RoundState, streak), offset_of!(RoundState, log),
        offset_of!(RoundState, phase), offset_of!(RoundState, vrf_set), offset_of!(RoundState, fallback),
        offset_of!(RoundState, top_desk),
    ];
    assert_eq!(got, [0, 16, 32, 48, 432, 434, 436, 468, 500, 532, 564, 572, 580, 588, 596, 604, 612, 676, 1140, 1141, 1142, 1143]);
}
