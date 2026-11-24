//! The engine vectors (crates/ping-core/tests/vectors/engine.json) replayed through the program:
//! the same acts sent as `act` transactions, the same VRF output delivered by the VRF program (or
//! none: the fallback seed, drawn at the vector's HIDE-end slot), every tick through the crank or
//! a manual `tick`. Every tick's per-desk results and public row, the final Book state, the Round
//! record and the commit hash must equal the engine's, byte for byte.
mod common;
use common::*;
use serde_json::Value;

fn desk_out_bytes(row: &Value) -> [u8; 16] {
    let v: Vec<u64> = row.as_array().unwrap().iter().map(|x| x.as_u64().unwrap()).collect();
    let mut b = [0u8; 16];
    for i in 0..4 {
        b[2 * i..2 * i + 2].copy_from_slice(&(v[i] as u16).to_le_bytes());
    }
    for i in 4..12 {
        b[i + 4] = v[i] as u8;
    }
    b
}

/// Sends the acts; desk index -> that desk's bot.
fn send_acts(e: &mut Env, pool: &mut Pool, acts: &Value) {
    for a in acts.as_array().unwrap() {
        let a = a.as_array().unwrap();
        let salt: [u8; 16] = unhex(a[3].as_str().unwrap()).try_into().unwrap();
        e.act(pool, a[0].as_u64().unwrap() as usize, a[1].as_u64().unwrap() as u8, a[2].as_u64().unwrap() as u8, salt);
    }
}

/// Resolves the tick due at `deadline` exactly at that slot (crank or manual tick); records CU.
fn resolve_at(e: &mut Env, pool: &Pool, deadline: u64, cu: &mut Cu) {
    let before = u64_at(&e.er(&pool.table), off::table::RESOLVES);
    for (c, resolved, ph) in e.warp(pool, deadline) {
        cu.add(&if resolved { "crank tick resolve".to_string() } else { format!("crank tick noop phase {ph}") }, c);
    }
    if u64_at(&e.er(&pool.table), off::table::RESOLVES) == before {
        let c = e.tick(pool);
        cu.add("manual tick resolve", c);
    }
    assert_eq!(u64_at(&e.er(&pool.table), off::table::RESOLVES), before + 1, "deadline {deadline} not resolved");
    assert_eq!(e.slot(), deadline);
}

fn check_out(e: &Env, pool: &Pool, out: &Value, what: &str) {
    let beat = out["beat"].as_u64().unwrap() as usize;
    let t = e.er(&pool.table);
    assert_eq!(u16_at(&t, off::table::BEAT) as u64, beat as u64, "{what}: beat");
    assert_eq!(t[off::table::PHASE] as u64, out["phase"].as_u64().unwrap(), "{what}: phase");
    assert_eq!(hex(&t[off::table::CHAIN_HEAD..off::table::CHAIN_HEAD + 32]), out["chain"].as_str().unwrap(), "{what}: chain");
    let bc = off::table::BEAT_COUNTS + 2 * (beat % 32);
    assert_eq!(t[bc] as u64, out["pings"].as_u64().unwrap(), "{what}: pings");
    assert_eq!(t[bc + 1] as u64, out["fills"].as_u64().unwrap(), "{what}: fills");
    for s in 0..8 {
        assert_eq!(u16_at(&t, off::table::PICKED + 2 * s) as u64, out["picked"][s].as_u64().unwrap(), "{what}: picked {s}");
        let d = e.er(&pool.desks[s]);
        let o = off::desk::RESULTS + 16 * beat;
        assert_eq!(d[o..o + 16], desk_out_bytes(&out["desks"][s]), "{what}: desk {s} result");
    }
    if out["phase"].as_u64().unwrap() == BELL as u64 {
        assert_eq!(t[off::table::TOP_DESK] as u64, out["top_desk"].as_u64().unwrap(), "{what}: top desk");
        for s in 0..8 {
            assert_eq!(u16_at(&t, off::table::TOTALS + 2 * s) as u64, out["totals"][s].as_u64().unwrap(), "{what}: totals");
        }
    }
}

#[test]
fn engine_vectors_replay_through_the_program() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../crates/ping-core/tests/vectors/engine.json");
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let rounds = doc["rounds"].as_array().unwrap();
    let mut ticks = 0;
    let mut cu = Cu::default();
    for (i, v) in rounds.iter().enumerate() {
        // slots differ per vector (not increasing): one fresh ledger per round
        let mut e = Env::new();
        let table_id = v["table_id"].as_u64().unwrap();
        let round = v["round"].as_u64().unwrap();
        let hide_slot = v["hide_slot"].as_u64().unwrap();
        let vrf = v["vrf"].as_str().map(|h| <[u8; 32]>::try_from(unhex(h)).unwrap());
        let p = Params { vrf: vrf.is_some(), ..Params::default() };
        e.set_config(p);
        e.svm.set_vrf_randomness(vrf);
        let mut pool = e.pool(table_id, Some(round - 1));
        e.record(&pool, round);
        // open so that the HIDE deadline is the vector's HIDE-end slot
        let open_slot = hide_slot - p.hide_slots;
        assert!(e.svm.warp_to_slot(open_slot).is_empty());
        e.open(&pool, round, true);
        send_acts(&mut e, &mut pool, &v["hide_acts"]);
        resolve_at(&mut e, &pool, hide_slot, &mut cu);
        let outs = v["outs"].as_array().unwrap();
        check_out(&e, &pool, &outs[0], &format!("vector {i} hide end"));
        assert_eq!(e.er(&pool.table)[off::table::FALLBACK], vrf.is_none() as u8, "vector {i}: fallback flag");
        for (b, acts) in v["beat_acts"].as_array().unwrap().iter().enumerate() {
            let deadline = u64_at(&e.er(&pool.table), off::table::NEXT_DEADLINE);
            e.warp(&pool, deadline - 1);
            send_acts(&mut e, &mut pool, acts);
            resolve_at(&mut e, &pool, deadline, &mut cu);
            check_out(&e, &pool, &outs[b + 1], &format!("vector {i} beat {}", b + 1));
            ticks += 1;
        }
        let book = e.er(&pool.book);
        assert_eq!(hex(&book[off::book::STATE..off::book::STATE + off::book::STATE_LEN]), v["final_state"].as_str().unwrap(), "vector {i}: final Book state");
        e.reveal(&pool, Some(round));
        let r = e.er(&pool.round_pda(round));
        assert_eq!(hex(&r[off::round::RECORD..off::round::RECORD + ping_core::RECORD_LEN]), v["record"].as_str().unwrap(), "vector {i}: record");
        assert_eq!(hex(&r[off::round::COMMIT..off::round::COMMIT + 32]), v["commit"].as_str().unwrap(), "vector {i}: commit hash");
        assert_eq!(r[off::round::FALLBACK], vrf.is_none() as u8, "vector {i}: Round.fallback_seed");
    }
    println!("engine vectors: {} rounds, {ticks} live beats replayed byte for byte\n{}", rounds.len(), cu.report());
    cu.assert_constant();
}
