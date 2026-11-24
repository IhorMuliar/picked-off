#![allow(dead_code)]
use ping_core::*;

/// splitmix64: small seeded PRNG for property tests.
pub struct Rng(pub u64);
impl Rng {
    pub fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e3779b97f4a7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
        z ^ (z >> 31)
    }
    pub fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    pub fn bytes<const N: usize>(&mut self) -> [u8; N] {
        let mut b = [0u8; N];
        for x in b.iter_mut() {
            *x = self.next() as u8;
        }
        b
    }
}

/// One act sent before a tick: (desk, kind, level, salt).
pub type Act = (usize, u8, u8, [u8; 16]);

/// A scripted round through the program path (open_round, record_act, set_vrf, tick).
pub struct Script {
    pub table_id: u64,
    pub round: u64,
    pub vrf: Option<[u8; 32]>,
    pub hide_slot: u64,
    pub hide_acts: Vec<Act>,
    /// acts sent before each live tick, generated lazily up to the bell
    pub beat_acts: Vec<Vec<Act>>,
}

/// Random acts: kinds/levels include invalid values sometimes; some desks stay silent.
pub fn random_acts(r: &mut Rng, hide: bool) -> Vec<Act> {
    let mut v = Vec::new();
    let n = r.below(12) as usize;
    for _ in 0..n {
        let desk = r.below(8) as usize;
        let kind = match r.below(10) {
            0 => r.below(256) as u8,
            1 => 0,
            2..=5 => PING,
            _ => REQUOTE,
        };
        let kind = if hide && kind == PING && r.below(2) == 0 { REQUOTE } else { kind };
        let level = if r.below(20) == 0 { r.below(256) as u8 } else { 1 + r.below(24) as u8 };
        v.push((desk, kind, level, r.bytes::<16>()));
    }
    v
}

/// Acts that cluster desks on few levels so fills and streaks happen often.
pub fn clustered_acts(r: &mut Rng, st: &RoundState) -> Vec<Act> {
    let mut v = Vec::new();
    for desk in 0..8 {
        match r.below(6) {
            0 => {}
            1 => v.push((desk, REQUOTE, 1 + r.below(4) as u8, [0; 16])),
            _ => {
                let t = r.below(8) as usize;
                let lvl = if r.below(3) == 0 { 1 + r.below(24) as u8 } else { st.level[t] };
                v.push((desk, PING, lvl, [0; 16]));
            }
        }
    }
    v
}

pub struct Played {
    pub st: RoundState,
    pub outs: Vec<BeatOut>,
    pub script: Script,
}

/// Play a whole round with random inputs; `on_tick(before, after, out)` sees every tick.
pub fn play_random(seed: u64, mut on_tick: impl FnMut(&RoundState, &RoundState, &BeatOut)) -> Played {
    let mut r = Rng(seed);
    let mut st = RoundState::zeroed();
    open_round(&mut st);
    let mut sc = Script {
        table_id: r.below(1000),
        round: r.below(1 << 20),
        vrf: if r.below(8) == 0 { None } else { Some(r.bytes::<32>()) },
        hide_slot: r.below(1 << 30),
        hide_acts: random_acts(&mut r, true),
        beat_acts: Vec::new(),
    };
    for a in &sc.hide_acts {
        record_act::<Sha256>(&mut st, a.0, a.1, a.2, &a.3, 1);
    }
    if let Some(v) = sc.vrf {
        set_vrf(&mut st, &v);
    }
    let mut outs = Vec::new();
    let mut out = BeatOut::zeroed();
    let before = st;
    tick::<Sha256, _>(&mut st, sc.table_id, sc.round, sc.hide_slot, &mut NoSink, &mut out);
    on_tick(&before, &st, &out);
    outs.push(out);
    let clustered = r.below(2) == 0;
    while st.phase == LIVE {
        let acts = if clustered { clustered_acts(&mut r, &st) } else { random_acts(&mut r, false) };
        for a in &acts {
            record_act::<Sha256>(&mut st, a.0, a.1, a.2, &a.3, 1);
        }
        sc.beat_acts.push(acts);
        let before = st;
        tick::<Sha256, _>(&mut st, sc.table_id, sc.round, 0, &mut NoSink, &mut out);
        on_tick(&before, &st, &out);
        outs.push(out);
    }
    Played { st, outs, script: sc }
}
