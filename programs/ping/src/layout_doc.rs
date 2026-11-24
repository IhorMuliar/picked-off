//! Generates the offset tables of docs/LAYOUT.md from the real structs and checks that the
//! document (when present in the checkout) contains them verbatim.
//!   cargo test -p ping --lib layout_doc -- --nocapture   (prints the tables)
use crate::state::*;

struct Field {
    name: &'static str,
    off: usize,
    size: usize,
    ty: &'static str,
}

macro_rules! fields {
    ($t:ty; $( $f:ident : $ty:literal ),* $(,)?) => {{
        let z: $t = bytemuck::Zeroable::zeroed();
        let _ = &z;
        vec![ $( Field { name: stringify!($f), off: 8 + core::mem::offset_of!($t, $f), size: core::mem::size_of_val(&z.$f), ty: $ty } ),* ]
    }};
}

fn table(title: &str, total: usize, fs: &[Field]) -> String {
    let mut s = format!("#### {title} ({total} bytes incl. the 8-byte discriminator)\n\n| offset | size | field | type |\n|---:|---:|---|---|\n| 0 | 8 | discriminator | `[u8; 8]` |\n");
    let mut next = 8;
    for f in fs {
        assert_eq!(f.off, next, "{title}.{} is not packed", f.name);
        next = f.off + f.size;
        s += &format!("| {} | {} | {} | `{}` |\n", f.off, f.size, f.name, f.ty);
    }
    assert_eq!(next, total, "{title} fields do not cover the account");
    s
}

pub fn tables() -> Vec<String> {
    vec![
        table("Config", CONFIG_SPACE, &fields!(Config;
            beat_slots: "u64", hide_slots: "u64", call_lamports: "u64", lot_lamports: "u64",
            crank_interval_ms: "u32", crank_iterations: "u32", tick_cu_limit: "u32", act_interval_ms: "u32",
            hide_secs: "u32", tape_close_secs: "u32", admin: "Pubkey", house: "Pubkey", tee_validator: "Pubkey",
            vrf_queue: "Pubkey", skim: "[u8; 3]", bell_min: "u8", bell_max: "u8", algo_memory: "u8",
            tape_close_beat: "u8", n_desks: "u8", levels: "u8", bump: "u8", layout: "u8", _pad: "[u8; 5]",
            _reserved: "[u8; 64]")),
        table("Table", TABLE_SPACE, &fields!(Table;
            table_id: "u64", round: "u64", open_slot: "u64", hide_end_slot: "u64", next_deadline_slot: "u64",
            bell_slot: "u64", reveal_slot: "u64", task_id: "i64", task_slot: "u64", tick_calls: "u64",
            resolves: "u64", vrf_request_slot: "u64", vrf_fulfil_slot: "u64", planned_start_unix: "i64",
            beat_slots: "u64", hide_slots: "u64", crank_interval_ms: "u32", crank_iterations: "u32",
            tick_cu_limit: "u32", print_count: "u32", house: "Pubkey", vrf_queue: "Pubkey", round_key: "Pubkey",
            chain_head: "[u8; 32]", commit_hash: "[u8; 32]", seats: "[Seat; 8]", picked: "[u16; 8]",
            totals: "[u16; 8]", beat_fill: "[u16; 8]", sealed: "u16", beat: "u16", prints: "[Print; 32]",
            beat_counts: "[[u8; 2]; 32]", kind: "u8", phase: "u8", bell_min: "u8", bell_max: "u8",
            top_desk: "u8", recorded: "u8", fallback_seed: "u8", vrf_fulfils: "u8", bump: "u8", book_bump: "u8",
            layout: "u8", _pad: "[u8; 1]", desk_bump: "[u8; 8]", _reserved: "[u8; 64]")),
        table("Book", BOOK_SPACE, &fields!(Book;
            table_id: "u64", round: "u64", vrf_slot: "u64", _r0: "u64", state: "[u8; 1144] = ping_core::RoundState",
            layout: "u8", _pad: "[u8; 7]", _reserved: "[u8; 64]")),
        table("Desk", DESK_SPACE, &fields!(Desk;
            table_id: "u64", round: "u64", ack_slot: "u64", result_slot: "u64", key: "Pubkey",
            last_seq: "u32", acts: "u32", resting: "u16", picked: "u16", beat: "u16", index: "u8", level: "u8",
            phase: "u8", next_algo: "u8", pending_kind: "u8", pending_level: "u8", placed: "u8", layout: "u8",
            _pad: "[u8; 2]", results: "[u8; 480] = [ping_core::DeskOut; 30]", _reserved: "[u8; 32]")),
        table("Round", ROUND_SPACE, &fields!(Round;
            table_id: "u64", round: "u64", planned_start_unix: "i64", open_slot: "u64", hide_end_slot: "u64",
            bell_slot: "u64", reveal_slot: "u64", top_key: "Pubkey", commit_hash: "[u8; 32]", totals: "[u16; 8]",
            status: "u8", kind: "u8", top_desk: "u8", fallback_seed: "u8", n_beats: "u8", bump: "u8",
            layout: "u8", _pad: "u8", seat_kind: "[u8; 8]", record: "[u8; 522]", _reserved: "[u8; 134]")),
        table("Ledger", LEDGER_SPACE, &fields!(Ledger;
            table_id: "u64", last_record_round: "u64", records: "u64", bump: "u8", layout: "u8",
            _pad: "[u8; 6]", _reserved: "[u8; 32]")),
        table("Tape", TAPE_SPACE, &fields!(Tape;
            table_id: "u64", round: "u64", close_unix: "i64", pool: "[u64; 8]", total: "u64", paid: "u64",
            open_calls: "u32", n_calls: "u32", winner: "u8", resolved: "u8", void: "u8", bump: "u8",
            layout: "u8", _pad: "[u8; 3]", _reserved: "[u8; 32]")),
        table("Call", CALL_SPACE, &fields!(Call;
            amount: "u64", owed: "u64", tape: "Pubkey", bettor: "Pubkey", desk: "u8", claimed: "u8",
            bump: "u8", layout: "u8", _pad: "[u8; 4]", _reserved: "[u8; 16]")),
        sub("Seat (56 bytes, inside Table.seats)", core::mem::size_of::<Seat>(), &fields!(Seat;
            key: "Pubkey", name: "[u8; 16]", kind: "u8", personality: "u8", _pad: "[u8; 6]")),
        sub("Print (6 bytes, inside Table.prints)", core::mem::size_of::<Print>(), &fields!(Print;
            tenths: "u16", beat: "u16", desk: "u8", _pad: "u8")),
        sub("ping_core::RoundState (1,144 bytes, inside Book.state, account offset 40 + this offset)", core::mem::size_of::<ping_core::RoundState>(), &fields!(ping_core::RoundState;
            resting: "[u16; 8]", picked: "[u16; 8]", last_fill: "[u16; 8]", last_pinged: "[u16; 192]", beat: "u16",
            bell_beat: "u16", seed: "[u8; 32]", vrf: "[u8; 32]", salt_acc: "[u8; 32]", chain: "[u8; 32]",
            level: "[u8; 8]", initial_level: "[u8; 8]", placed: "[u8; 8]", pending_kind: "[u8; 8]",
            pending_level: "[u8; 8]", algo_next: "[u8; 8]", streak: "[u8; 64]", log: "[u8; 464]", phase: "u8",
            vrf_set: "u8", fallback: "u8", top_desk: "u8")),
        sub("ping_core::DeskOut (16 bytes; Desk.results[b] at account offset 96 + 16 * b)", core::mem::size_of::<ping_core::DeskOut>(), &fields!(ping_core::DeskOut;
            resting: "u16", picked: "u16", fill_amt: "u16", lost_amt: "u16", level: "u8", action_kind: "u8",
            action_level: "u8", action_algo: "u8", result: "u8", victims: "u8", hits_taken: "u8", next_algo: "u8")),
    ]
}

/// Nested structs: offsets relative to the struct start (no discriminator).
fn sub(title: &str, total: usize, fs: &[Field]) -> String {
    let mut s = format!("#### {title}\n\n| offset | size | field | type |\n|---:|---:|---|---|\n");
    let mut next = 0;
    for f in fs {
        let off = f.off - 8;
        assert_eq!(off, next, "{title}.{} is not packed", f.name);
        next = off + f.size;
        s += &format!("| {} | {} | {} | `{}` |\n", off, f.size, f.name, f.ty);
    }
    assert_eq!(next, total);
    s
}

#[test]
fn layout_doc() {
    let all = tables();
    for t in &all {
        println!("{t}");
    }
    let doc = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/LAYOUT.md");
    if let Ok(text) = std::fs::read_to_string(&doc) {
        for t in &all {
            assert!(text.contains(t.as_str()), "docs/LAYOUT.md is out of date; re-run this test with --nocapture and paste:\n{t}");
        }
    }
}
