//! Writes / checks tests/vectors/engine.json: full rounds through the program path (acts,
//! VRF, ticks) with every tick's outputs, the round record and the commit hash. The TypeScript
//! port replays the same file. Regenerate with `PING_WRITE_VECTORS=1 cargo test -p ping-core --test parity`.
mod common;
use common::*;
use ping_core::*;
use serde_json::{json, Value};

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn acts_json(a: &[Act]) -> Value {
    Value::Array(a.iter().map(|(d, k, l, s)| json!([d, k, l, hex(s)])).collect())
}

fn out_json(o: &BeatOut) -> Value {
    json!({
        "beat": o.beat, "phase": o.phase, "pings": o.pings, "fills": o.fills, "top_desk": o.top_desk,
        "picked": o.picked, "totals": o.totals, "chain": hex(&o.chain),
        "desks": o.desks.iter().map(|d| json!([d.resting, d.picked, d.fill_amt, d.lost_amt, d.level, d.action_kind,
            d.action_level, d.action_algo, d.result, d.victims, d.hits_taken, d.next_algo])).collect::<Vec<_>>(),
    })
}

/// The raw #[repr(C)] bytes of the state (no padding, so every byte is initialised).
fn state_bytes(st: &RoundState) -> &[u8] {
    // SAFETY: RoundState is repr(C), padding-free (size asserted), and made of integers only.
    unsafe { core::slice::from_raw_parts(st as *const RoundState as *const u8, core::mem::size_of::<RoundState>()) }
}

#[test]
fn engine_vectors() {
    let mut rounds = Vec::new();
    for seed in 1000..1016u64 {
        let p = play_random(seed, |_, _, _| {});
        let rec = RoundRecord::from_state(&p.st, p.script.table_id, p.script.round);
        let mut bytes = [0u8; RECORD_LEN];
        rec.write(&mut bytes);
        rounds.push(json!({
            "table_id": p.script.table_id, "round": p.script.round,
            "vrf": p.script.vrf.map(|v| hex(&v)), "hide_slot": p.script.hide_slot,
            "hide_acts": acts_json(&p.script.hide_acts),
            "beat_acts": p.script.beat_acts.iter().map(|a| acts_json(a)).collect::<Vec<_>>(),
            "outs": p.outs.iter().map(out_json).collect::<Vec<_>>(),
            "record": hex(&bytes), "commit": hex(&p.st.chain), "final_state": hex(state_bytes(&p.st)),
        }));
    }
    let doc = json!({
        "about": "Full rounds through open_round / record_act / set_vrf / tick: inputs (acts as [desk, kind, level, salt]) and every tick's outputs; desks rows are [resting, picked, fill_amt, lost_amt, level, action_kind, action_level, action_algo, result, victims, hits_taken, next_algo]. tick slot is hide_slot for the HIDE end and 0 afterwards.",
        "rounds": rounds,
    });
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/vectors/engine.json");
    if std::env::var("PING_WRITE_VECTORS").is_ok() {
        std::fs::write(path, serde_json::to_string(&doc).unwrap()).unwrap();
    }
    let file: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("engine.json missing: run with PING_WRITE_VECTORS=1")).unwrap();
    assert_eq!(file, doc, "engine.json is stale");
}
