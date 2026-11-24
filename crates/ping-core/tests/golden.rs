//! Reference rounds (tests/vectors/golden.json) replay exactly through `apply_beat`.
use ping_core::*;
use serde_json::Value;

struct Events(Vec<[u64; 4]>);
impl Sink for Events {
    fn pair(&mut self, _h: usize, v: usize, level: u64, hit: u64, amt: u64) {
        if hit == 1 {
            self.0.push([v as u64, 2, level, amt]);
        }
    }
    fn ping(&mut self, p: usize, level: u64, pinged: u64, fill: u64) {
        if pinged == 1 {
            self.0.push([p as u64, (fill > 0) as u64, level, fill]);
        }
    }
}

fn arr8(v: &Value) -> [u64; 8] {
    let a = v.as_array().unwrap();
    assert_eq!(a.len(), 8);
    core::array::from_fn(|i| a[i].as_u64().unwrap())
}

#[test]
fn golden_vectors_replay_exactly() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/vectors/golden.json");
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let rounds = doc["rounds"].as_array().unwrap();
    let (mut nbeats, mut nevents) = (0, 0);
    for rd in rounds {
        let beats = rd["beats"].as_array().unwrap();
        let mut st = RoundState::zeroed();
        open_round(&mut st);
        st.phase = LIVE;
        let l0 = arr8(&beats[0]["levels_before"]);
        for s in 0..8 {
            st.level[s] = l0[s] as u8;
        }
        let mut out = BeatOut::zeroed();
        for (i, bt) in beats.iter().enumerate() {
            let id = rd["id"].as_u64().unwrap();
            let lb = arr8(&bt["levels_before"]);
            assert_eq!(st.level.map(|x| x as u64), lb, "round {id} beat {i}: levels_before");
            let order = arr8(&bt["order"]).map(|x| x as u8);
            let acts: [Action; 8] = core::array::from_fn(|s| {
                let a = bt["actions"][s].as_array().unwrap();
                Action { kind: a[0].as_u64().unwrap() as u8, level: a[1].as_u64().unwrap() as u8, algo: a[2].as_u64().unwrap() as u8 }
            });
            let mut ev = Events(Vec::new());
            let b = (i + 1) as u16;
            apply_beat(&mut st, &acts, &order, b, 1, &mut ev, &mut out);
            st.beat = b;
            let want: Vec<[u64; 4]> = bt["events"]
                .as_array()
                .unwrap()
                .iter()
                .map(|e| core::array::from_fn(|k| e[k].as_u64().unwrap()))
                .collect();
            assert_eq!(ev.0, want, "round {id} beat {i}: events");
            assert_eq!(st.resting.map(|x| x as u64), arr8(&bt["resting"]), "round {id} beat {i}: resting");
            assert_eq!(st.picked.map(|x| x as u64), arr8(&bt["picked"]), "round {id} beat {i}: picked");
            let sum: u64 = (0..8).map(|s| st.resting[s] as u64 + st.picked[s] as u64).sum();
            assert_eq!(sum, 800);
            nbeats += 1;
            nevents += want.len();
        }
        let tot: [u64; 8] = core::array::from_fn(|s| st.resting[s] as u64 + st.picked[s] as u64);
        assert_eq!(tot, arr8(&rd["final_total"]));
    }
    println!("golden: {} rounds, {} beats, {} events", rounds.len(), nbeats, nevents);
    assert!(rounds.len() >= 5 && nbeats > 100);
}
