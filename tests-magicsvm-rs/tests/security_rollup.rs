//! Security tests of the rollup instructions: permissions, commit, crank and `tick`, `act`, the
//! VRF callback, joins, account substitution and lookalike accounts. Long-running checks that
//! already exist elsewhere are referenced, not repeated: constant compute over thousands of
//! hidden states (cu.rs), the reset after `open_round` and crank task ids (lifecycle.rs).
mod common;
use common::*;
use solana_address::Address;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

/// Beats and HIDE take 0 slots: every tick resolves one deadline, so a round runs on ticks alone.
fn fast() -> Params {
    Params { hide_slots: 0, beat_slots: 0, ..Params::default() }
}

/// Delegates a base-only pool (from `Env::base_pool`) and seals and seats it like `Env::pool`.
fn seat_pool(e: &mut Env, mut pool: Pool) -> Pool {
    let h = e.house.insecure_clone();
    for a in [pool.table, pool.book].iter().chain(pool.desks.iter()) {
        e.svm.delegate_account(*a).unwrap();
    }
    let ixs = [e.ix_setup_permissions(&pool, 0, 0), e.ix_setup_permissions(&pool, 1, 0)];
    e.ok(Er, &h, &[], &ixs, "setup_permissions");
    for s in 0..8u8 {
        let k = pool.bots[s as usize].pubkey();
        let ix = e.ix_join_bot(&pool, s, &k);
        // A staked table refuses bots too; leave those seats empty
        let _ = e.send(Er, &h, &[], &[ix]);
    }
    pool.seq = [1; 8];
    pool
}

fn stranger(e: &mut Env) -> Keypair {
    e.funded(1_000_000_000)
}

fn as_signer(mut ix: Instruction, k: &Address) -> Instruction {
    ix.accounts[0].pubkey = *k;
    ix
}

fn desk_out(e: &Env, pool: &Pool, s: usize, beat: usize) -> Vec<u8> {
    let d = e.er(&pool.desks[s]);
    d[off::desk::RESULTS + 16 * beat..off::desk::RESULTS + 16 * beat + 16].to_vec()
}

/// Every permission change is house-only, phase-gated and fixed by the program (never by an
/// argument); `join` sets exactly one member, the joiner, with flags 0.
#[test]
fn s01_permissions_only_by_the_program_rules() {
    let mut e = Env::new();
    e.set_config(fast());
    let pool = e.pool(1, None);
    e.record(&pool, 1);
    let s = stranger(&mut e);
    for (kind, idx) in [(0u8, 0u64), (1, 0), (2, 3), (3, 1)] {
        let ix = as_signer(e.ix_setup_permissions(&pool, kind, idx), &s.pubkey());
        expect_code(e.send(Er, &s, &[], &[ix]), code::NOT_HOUSE, &format!("stranger setup_permissions kind {kind}"));
    }
    for (kind, idx) in [(1u8, 0u64), (2, 3)] {
        let ix = as_signer(e.ix_unseal(&pool, kind, idx), &s.pubkey());
        expect_code(e.send(Er, &s, &[], &[ix]), code::NOT_HOUSE, "stranger unseal");
    }
    let ix = as_signer(e.ix_join_bot(&pool, 2, &s.pubkey()), &s.pubkey());
    expect_code(e.send(Er, &s, &[], &[ix]), code::NOT_HOUSE, "stranger join_bot");
    // Wrong permission account / wrong target for the kind
    let h = e.house.insecure_clone();
    let mut ix = e.ix_setup_permissions(&pool, 2, 3);
    ix.accounts[3].pubkey = permission_pda(&pool.desks[4]);
    expect_code(e.send(Er, &h, &[], &[ix]), code::BAD_ACCOUNT, "permission of another desk");
    let mut ix = e.ix_setup_permissions(&pool, 2, 3);
    ix.accounts[2].pubkey = pool.desks[4];
    ix.accounts[3].pubkey = permission_pda(&pool.desks[4]);
    expect_code(e.send(Er, &h, &[], &[ix]), code::BAD_ACCOUNT, "desk 4 sealed as desk 3");
    let mut ix = e.ix_setup_permissions(&pool, 1, 0);
    ix.accounts[2].pubkey = pool.desks[0];
    ix.accounts[3].pubkey = permission_pda(&pool.desks[0]);
    expect_code(e.send(Er, &h, &[], &[ix]), code::BAD_ACCOUNT, "a desk sealed as the Book");
    // The house cannot unseal before the reveal, nor reveal before the bell
    e.open(&pool, 1, true);
    expect_code(e.send(Er, &h, &[], &[e.ix_unseal(&pool, 1, 0)]), code::BAD_PHASE, "unseal in HIDE");
    expect_code(e.send(Er, &h, &[], &[e.ix_reveal(&pool, Some(1))]), code::BAD_PHASE, "reveal in HIDE");
    let ix = as_signer(e.ix_reveal(&pool, Some(1)), &s.pubkey());
    expect_code(e.send(Er, &s, &[], &[ix]), code::NOT_HOUSE, "stranger reveal");
    // Nobody reads the Book in play, not even the house; a desk only by its key
    for v in [None, Some(s.pubkey()), Some(h.pubkey()), Some(pool.bots[0].pubkey())] {
        assert!(!e.can_read(v, &pool.book), "Book readable by {v:?}");
    }
    assert!(e.can_read(Some(pool.bots[3].pubkey()), &pool.desks[3]) && !e.can_read(Some(pool.bots[4].pubkey()), &pool.desks[3]));
    // Join: exactly one member, the joiner, flags 0; the old key is out
    let p = Keypair::new();
    let ix = e.ix_join(&pool, &p.pubkey(), 3, None);
    e.ok(Er, &p, &[], &[ix], "join");
    let (private, members) = e.permission(&pool.desks[3]).expect("desk permission");
    // (the permission program lists the owner program as a default member)
    let real: Vec<_> = members.iter().filter(|(_, k)| *k != Address::default() && *k != PROGRAM).collect();
    assert!(private && real.len() == 1 && real[0].1 == p.pubkey() && real[0].0 == 0, "desk 3 members after join: {members:?}");
    assert!(members.iter().all(|(f, _)| *f == 0), "member flags {members:?}");
    assert!(!e.can_read(Some(pool.bots[3].pubkey()), &pool.desks[3]), "old bot still reads desk 3");
    let (bp, bm) = e.permission(&pool.book).expect("book permission");
    assert!(bp && bm.iter().all(|(_, k)| *k == Address::default() || *k == PROGRAM), "Book members {bm:?}");
    // After the bell the house reveals, then unseals
    e.tick_to_bell(&pool);
    e.reveal(&pool, Some(1));
    e.unseal_all(&pool);
    assert!(e.can_read(None, &pool.book));
    println!("s01: permission changes house-only and fixed; join = [joiner, flags 0]; Book unreadable until unseal");
}

/// Only the house commits, only the Round PDA of this table and number, never one in play;
/// the commit undelegates that Round alone; Table, Book and Desks stay on the rollup.
#[test]
fn s02_only_the_house_commits_only_a_finished_round() {
    let mut e = Env::new();
    e.set_config(fast());
    let pool = e.pool(2, None);
    let other = e.pool(3, None);
    e.record(&pool, 1);
    e.record(&other, 1);
    let h = e.house.insecure_clone();
    let s = stranger(&mut e);
    e.open(&pool, 1, true);
    let r1 = pool.round_pda(1);
    expect_code(e.send(Er, &h, &[], &[e.ix_commit_round(&h.pubkey(), &pool, r1, 1)]), code::ROUND_IN_PLAY, "commit in play");
    expect_code(e.send(Er, &s, &[], &[e.ix_commit_round(&s.pubkey(), &pool, r1, 1)]), code::NOT_HOUSE, "stranger commit");
    for (what, acc) in [("Book", pool.book), ("Desk", pool.desks[0]), ("Table", pool.table), ("other table's Round", other.round_pda(1))] {
        expect_code(e.send(Er, &h, &[], &[e.ix_commit_round(&h.pubkey(), &pool, acc, 1)]), code::CONSTRAINT_SEEDS, &format!("commit the {what}"));
    }
    e.tick_to_bell(&pool);
    e.reveal(&pool, Some(1));
    e.ok(Er, &h, &[], &[e.ix_commit_round(&h.pubkey(), &pool, r1, 1)], "commit_round");
    let base = e.svm.get_account_for(Base, &r1).expect("Round on base");
    assert_eq!(base.owner, PROGRAM, "Round not back with the program");
    assert_eq!(base.data[off::round::STATUS], 2, "REVEALED");
    for a in [pool.table, pool.book].iter().chain(pool.desks.iter()) {
        assert_eq!(e.svm.get_account_for(Base, a).unwrap().owner, DELEGATION_PROGRAM, "{a} left the rollup");
    }
    expect_fail(e.send(Er, &h, &[], &[e.ix_commit_round(&h.pubkey(), &pool, r1, 1)]), "second commit");
    // Round 1 can never be opened again (round numbers only go up), even once re-sealed
    e.unseal_all(&pool);
    e.reseal(&pool);
    expect_code(e.send(Er, &h, &[], &[e.ix_open_round(&pool, 1, false)]), code::BAD_ROUND, "reopen round 1");
    // And it settles on base: the Tape's winner is the round's Top Desk
    e.ok(Base, &s, &[], &[Env::ix_settle(&s.pubkey(), r1, pool.tape_pda(1))], "settle the committed round");
    let t = e.data(Base, &pool.tape_pda(1));
    assert_eq!(t[120], base.data[off::round::TOP_DESK]);
    println!("s02: commit house-only, Round alone, never in play; Table/Book/Desks never leave the rollup");
}

/// Finding: `abort_round` of a recorded round without its Round left that Round OPEN for good
/// (never committable, its Tape never closable). It now needs the Round.
#[test]
fn f_abort_of_a_recorded_round_needs_its_record() {
    let mut e = Env::new();
    e.set_config(fast());
    let pool = e.pool(4, None);
    e.record(&pool, 1);
    e.open(&pool, 1, true);
    let h = e.house.insecure_clone();
    expect_code(e.send(Er, &h, &[], &[e.ix_abort_round(&h.pubkey(), &pool, None)]), code::NO_RECORD, "abort without the Round");
    let s = stranger(&mut e);
    expect_code(e.send(Er, &s, &[], &[e.ix_abort_round(&s.pubkey(), &pool, Some(1))]), code::NOT_HOUSE, "stranger abort");
    e.ok(Er, &h, &[], &[e.ix_abort_round(&h.pubkey(), &pool, Some(1))], "abort with the Round");
    let r1 = pool.round_pda(1);
    assert_eq!(e.er(&r1)[off::round::STATUS], 3, "ABORTED");
    assert!(!e.can_read(None, &pool.book), "abort made the Book public");
    e.ok(Er, &h, &[], &[e.ix_commit_round(&h.pubkey(), &pool, r1, 1)], "commit the aborted round");
    e.ok(Base, &s, &[], &[Env::ix_settle(&s.pubkey(), r1, pool.tape_pda(1))], "settle (void)");
    assert_eq!(e.data(Base, &pool.tape_pda(1))[122], 1, "void");
    println!("f-abort: a recorded round aborts only with its Round; Tape void, Book stays sealed");
}

/// `tick` takes the Table, the Book and the eight Desks as fixed, seed-checked accounts in
/// desk order; a duplicate, a swap, another table's desk or a Book in a desk slot is refused.
#[test]
fn s04_tick_accounts_are_fixed_and_distinct() {
    let mut e = Env::new();
    let pool = e.pool(5, None);
    let other = e.pool(6, None);
    let h = e.house.insecure_clone();
    let bad = |e: &mut Env, f: &dyn Fn(&mut Instruction), what: &str| {
        let mut ix = e.ix_tick(&pool);
        f(&mut ix);
        let r = e.send(Er, &h, &[], &[ix]);
        let msg = expect_fail(r, what);
        assert!(msg.contains("Custom(2006)") || msg.contains("Custom(3002)"), "{what}: {msg}");
    };
    bad(&mut e, &|ix| ix.accounts[3].pubkey = pool.desks[0], "desk 0 twice");
    bad(&mut e, &|ix| ix.accounts.swap(4, 5), "desks 2 and 3 swapped");
    bad(&mut e, &|ix| ix.accounts[6].pubkey = other.desks[4], "another table's desk 4");
    bad(&mut e, &|ix| ix.accounts[2].pubkey = pool.book, "the Book as desk 0");
    bad(&mut e, &|ix| ix.accounts[1].pubkey = other.book, "another table's Book");
    e.tick(&pool);
    println!("s04: tick refuses duplicate, swapped and foreign accounts");
}

/// `tick` is permissionless but harmless: before the deadline it only counts the call; at a
/// deadline it resolves exactly one, however often it is sent in that slot. There is no
/// instruction that schedules a crank or requests randomness on its own.
#[test]
fn s05_tick_resolves_at_most_one_deadline_per_slot() {
    let mut e = Env::new();
    let pool = e.pool(7, None);
    e.open(&pool, 1, false);
    let s = stranger(&mut e);
    let tick_by = |e: &mut Env, k: &Keypair, n: u32| {
        for i in 0..n {
            let mut cu = vec![2u8];
            cu.extend_from_slice(&(300_000 + i).to_le_bytes());
            let budget = Instruction { program_id: Address::from_str_const("ComputeBudget111111111111111111111111111111"), accounts: vec![], data: cu };
            e.ok(Er, k, &[], &[budget, e.ix_tick(&pool)], "stranger tick");
        }
    };
    tick_by(&mut e, &s, 50);
    let t = e.er(&pool.table);
    assert_eq!((u64_at(&t, off::table::RESOLVES), t[off::table::PHASE]), (0, HIDE), "a tick before the deadline resolved");
    assert_eq!(u64_at(&t, off::table::TICK_CALLS), 50);
    let d = u64_at(&t, off::table::NEXT_DEADLINE);
    e.warp_resolve(&pool, d);
    let r = u64_at(&e.er(&pool.table), off::table::RESOLVES);
    let slot = e.slot();
    tick_by(&mut e, &s, 50);
    assert_eq!(e.slot(), slot, "slot moved");
    assert_eq!(u64_at(&e.er(&pool.table), off::table::RESOLVES), r, "50 ticks in one slot resolved more than one deadline");
    for name in ["schedule_tick", "schedule_crank", "request_vrf", "request_er_vrf", "update_permission", "probe_commit", "settle", "ping_direct"] {
        let ix = Instruction { program_id: PROGRAM, accounts: vec![meta_ws(s.pubkey())], data: disc(name).to_vec() };
        expect_code(e.send(Er, &s, &[], &[ix]), code::FALLBACK_NOT_FOUND, name);
    }
    println!("s05: 100 stranger ticks, {r} resolve(s); no scheduling or VRF instruction exists");
}

/// `act` only records a pending choice; one action per desk resolves per beat (the latest);
/// a stale seq, a wrong key and a wrong phase are no-ops.
#[test]
fn s07_one_action_per_desk_per_beat() {
    let mut e = Env::new();
    let mut pool = e.pool(8, None);
    e.open(&pool, 1, false);
    for s in 0..8 {
        e.act(&mut pool, s, 2, 1 + s as u8, [s as u8; 16]);
    }
    let d = u64_at(&e.er(&pool.table), off::table::NEXT_DEADLINE);
    e.warp_resolve(&pool, d);
    assert_eq!(e.er(&pool.table)[off::table::PHASE], LIVE);
    for i in 0..50u8 {
        e.act(&mut pool, 0, 1 + i % 2, 1 + ((i as u32 * 7) % 24) as u8, [i; 16]);
    }
    e.act(&mut pool, 0, 1, 17, [99; 16]);
    let last = pool.seq[0] - 1;
    // Stale seq and a wrong key change nothing
    let desk0 = e.er(&pool.desks[0]);
    let bot0 = pool.bots[0].insecure_clone();
    e.act_raw(&bot0, &pool.desks[0], &pool.book, 2, 3, last, [1; 16]);
    let bot1 = pool.bots[1].insecure_clone();
    e.act_raw(&bot1, &pool.desks[0], &pool.book, 2, 3, last + 10, [1; 16]);
    assert_eq!(e.er(&pool.desks[0]), desk0, "stale seq or wrong key changed desk 0");
    let d = u64_at(&e.er(&pool.table), off::table::NEXT_DEADLINE);
    e.warp_resolve(&pool, d);
    let o = desk_out(&e, &pool, 0, 1);
    assert_eq!((o[9], o[10], o[11]), (1, 17, 0), "beat 1 action of desk 0 (kind, level, algo)");
    let b = e.er(&pool.book);
    let log0 = off::book::STATE + 676;
    assert_eq!(&b[log0..log0 + 2], &[1, 17], "log row of beat 1, desk 0");
    // After the bell: acts change nothing in the Book
    let mut e2 = Env::new();
    e2.set_config(fast());
    let mut p2 = e2.pool(9, None);
    e2.open(&p2, 1, false);
    e2.tick_to_bell(&p2);
    let book = e2.er(&p2.book);
    for s in 0..8 {
        e2.act(&mut p2, s, 1, 5, [7; 16]);
        e2.act(&mut p2, s, 2, 6, [7; 16]);
    }
    assert_eq!(e2.er(&p2.book), book, "acts after the bell changed the Book");
    println!("s07: 51 acts in one beat -> one action (the latest); stale/wrong-key/after-bell acts are no-ops");
}

/// Sends `ix` signed by `payer` plus a forged second signer (rollup sigverify off for one tx).
fn send_forged(e: &mut Env, payer: &Keypair, ix: Instruction) -> Result<u64, String> {
    let mut tx = Transaction::new_unsigned(Message::new(&[ix], Some(&payer.pubkey())));
    tx.message.recent_blockhash = e.svm.latest_blockhash_for(Er);
    let n = tx.message.header.num_required_signatures as usize;
    tx.signatures = vec![Default::default(); n];
    e.svm.ephemeral_mut().set_sigverify(false);
    let res = e.svm.send_transaction_to(Er, tx);
    e.svm.ephemeral_mut().set_sigverify(true);
    e.svm.expire_blockhash_for(Er);
    res.map(|m| m.compute_units_consumed).map_err(|f| format!("{:?}\n{:#?}", f.err, f.meta.logs))
}

fn ix_vrf_callback(identity: Address, table: Address, book: Address, r: [u8; 32]) -> Instruction {
    let mut data = disc("vrf_callback").to_vec();
    data.extend_from_slice(&r);
    Instruction { program_id: PROGRAM, accounts: vec![meta_rs(identity), meta_w(table), meta_w(book)], data }
}

/// Randomness is requested only by `open_round` (house, once per round); the callback takes
/// only the VRF program's identity for this program, binds Table and Book by seeds, keeps the
/// first output and changes nothing outside HIDE.
#[test]
fn s08_vrf_once_per_round_bound_and_first_wins() {
    let mut e = Env::new();
    let pool = e.pool(10, None);
    let other = e.pool(11, None);
    let h = e.house.insecure_clone();
    e.open(&pool, 1, false);
    expect_code(e.send(Er, &h, &[], &[e.ix_open_round(&pool, 2, false)]), code::BAD_PHASE, "second open_round (second VRF request)");
    let s = stranger(&mut e);
    let ix = ix_vrf_callback(s.pubkey(), pool.table, pool.book, [1; 32]);
    expect_code(e.send(Er, &s, &[], &[ix]), code::CONSTRAINT_ADDRESS, "stranger as the VRF identity");
    let identity = Address::find_program_address(&[b"identity", PROGRAM.as_ref()], &VRF_PROGRAM).0;
    // With the identity's signature forged, the accounts are still bound by seeds
    let ix = ix_vrf_callback(identity, pool.table, other.book, [2; 32]);
    expect_code(send_forged(&mut e, &h, ix), code::CONSTRAINT_SEEDS, "callback with another table's Book");
    // The real fulfil lands one slot after the request; a duplicate changes nothing
    let slot = e.slot();
    e.warp(&pool, slot + 1);
    let st = off::book::STATE;
    let book = e.er(&pool.book);
    assert_eq!(book[st + 1141], 1, "vrf_set");
    let ix = ix_vrf_callback(identity, pool.table, pool.book, [3; 32]);
    send_forged(&mut e, &h, ix).expect("duplicate fulfil never fails");
    let after = e.er(&pool.book);
    assert_eq!(&after[st + 468..st + 500], &book[st + 468..st + 500], "a duplicate fulfil replaced the VRF output");
    assert_eq!(after, book, "a duplicate fulfil changed the Book");
    println!("s08: one request per round; callback identity pinned, accounts seed-bound, first output wins");
}

/// Counters that may grow without bound wrap instead of failing `act` or `tick`.
#[test]
fn s11_program_counters_wrap_instead_of_failing() {
    let mut e = Env::new();
    let pool = e.base_pool(12);
    let t = pool.table;
    e.patch_base(&t, off::table::TICK_CALLS, &u64::MAX.to_le_bytes());
    e.patch_base(&pool.desks[0], off::desk::ACTS, &u32::MAX.to_le_bytes());
    let mut pool = seat_pool(&mut e, pool);
    e.tick(&pool);
    assert_eq!(u64_at(&e.er(&pool.table), off::table::TICK_CALLS), 0, "tick_calls wraps");
    e.act(&mut pool, 0, 0, 0, [0; 16]);
    assert_eq!(u32_at(&e.er(&pool.desks[0]), off::desk::ACTS), 0, "acts wraps");
    let bot = pool.bots[0].insecure_clone();
    e.act_raw(&bot, &pool.desks[0], &pool.book, 2, 4, u32::MAX, [0; 16]);
    e.act_raw(&bot, &pool.desks[0], &pool.book, 2, 4, u32::MAX, [1; 16]);
    println!("s11: tick_calls and acts wrap; seq u32::MAX is accepted once, then stale");
}

fn runtime_only(logs: &[String]) -> bool {
    logs.iter().all(|l| {
        let w: Vec<&str> = l.split_whitespace().collect();
        w.len() >= 3 && w[0] == "Program" && (w[2] == "invoke" || w[2] == "consumed" || w[2] == "success")
    })
}

/// `act` and `tick` print nothing but the runtime's own invoke/consumed/success lines, and
/// never fail whatever the input (the fuzz is cu.rs `act_fuzz_never_fails`).
#[test]
fn s14_act_and_tick_log_nothing() {
    let mut e = Env::new();
    let pool = e.pool(13, None);
    let other = e.pool(14, None);
    e.open(&pool, 1, false);
    let s = stranger(&mut e);
    let bot = pool.bots[2].insecure_clone();
    let cases = [
        (bot.insecure_clone(), pool.desks[2], pool.book, 2u8, 5u8, 1u32),
        (bot.insecure_clone(), pool.desks[2], pool.book, 2, 5, 1),
        (s.insecure_clone(), pool.desks[2], pool.book, 1, 9, 50),
        (bot.insecure_clone(), pool.desks[2], other.book, 7, 99, 60),
    ];
    for (k, d, b, kind, lvl, seq) in cases {
        let (_, logs) = e.send_logs(Er, &k, &[Env::ix_act(&k.pubkey(), &d, &b, kind, lvl, seq, [3; 16])]).expect("act");
        assert!(runtime_only(&logs), "act logged: {logs:#?}");
    }
    let h = e.house.insecure_clone();
    let (_, logs) = e.send_logs(Er, &h, &[e.ix_tick(&pool)]).expect("tick");
    assert!(runtime_only(&logs), "tick logged: {logs:#?}");
    let d = u64_at(&e.er(&pool.table), off::table::NEXT_DEADLINE);
    let slot = e.slot();
    e.svm.warp_to_slot(slot.max(d));
    let (_, logs) = e.send_logs(Er, &h, &[e.ix_tick(&pool)]).expect("resolving tick");
    assert!(runtime_only(&logs), "resolving tick logged: {logs:#?}");
    println!("s14: act and tick logs are runtime lines only");
}

/// Typed, owner- and discriminator-checked accounts everywhere; pinned program ids;
/// lookalike accounts owned by another program, or of the wrong type, are refused.
#[test]
fn s15_lookalike_accounts_are_refused() {
    let mut e = Env::new();
    let mut pool = e.pool(15, None);
    let other = e.pool(16, None);
    e.open(&pool, 1, false);
    let h = e.house.insecure_clone();
    let bot = pool.bots[0].insecure_clone();
    // A byte-for-byte copy of desk 0 owned by another program, and one owned by System
    let desk0 = e.er(&pool.desks[0]);
    for owner in [VRF_PROGRAM, SYSTEM] {
        let fake = e.delegated_fake(owner, desk0.clone());
        let ix = Env::ix_act(&bot.pubkey(), &fake, &pool.book, 2, 4, 900, [0; 16]);
        expect_code(e.send(Er, &bot, &[], &[ix]), code::WRONG_OWNER, "act on a lookalike Desk");
    }
    let book = e.er(&pool.book);
    let fake_book = e.delegated_fake(VRF_PROGRAM, book.clone());
    let ix = Env::ix_act(&bot.pubkey(), &pool.desks[0], &fake_book, 2, 4, 901, [0; 16]);
    expect_code(e.send(Er, &bot, &[], &[ix]), code::WRONG_OWNER, "act with a lookalike Book");
    // Type confusion: Book as Desk, Desk as Book
    let ix = Env::ix_act(&bot.pubkey(), &pool.book, &pool.book, 2, 4, 902, [0; 16]);
    expect_fail(e.send(Er, &bot, &[], &[ix]), "Book as Desk");
    let ix = Env::ix_act(&bot.pubkey(), &pool.desks[0], &pool.desks[1], 2, 4, 903, [0; 16]);
    expect_code(e.send(Er, &bot, &[], &[ix]), code::DISCRIMINATOR_MISMATCH, "Desk as Book");
    // A desk of this table with the Book of another table: a silent no-op on both
    let (d0, ob) = (e.er(&pool.desks[0]), e.er(&other.book));
    e.act_raw(&bot, &pool.desks[0], &other.book, 2, 4, 904, [0; 16]);
    assert_eq!((e.er(&pool.desks[0]), e.er(&other.book)), (d0, ob), "cross-table act changed state");
    pool.seq[0] = 905;
    e.act(&mut pool, 0, 2, 4, [0; 16]);
    // Tick with a lookalike Table
    let table = e.er(&pool.table);
    let fake_table = e.delegated_fake(VRF_PROGRAM, table);
    let mut ix = e.ix_tick(&pool);
    ix.accounts[0].pubkey = fake_table;
    expect_code(e.send(Er, &h, &[], &[ix]), code::WRONG_OWNER, "tick with a lookalike Table");
    // Pinned program ids in the permission path
    let fake_prog = e.delegated_fake(SYSTEM, vec![]);
    for (i, what) in [(4usize, "permission program"), (5, "ephemeral vault"), (6, "magic program")] {
        let mut ix = e.ix_setup_permissions(&pool, 2, 1);
        ix.accounts[i].pubkey = fake_prog;
        expect_code(e.send(Er, &h, &[], &[ix]), code::CONSTRAINT_ADDRESS, what);
    }
    // The VRF queue of open_round must be the Table's
    let mut e2 = Env::new();
    let p2 = e2.pool(17, None);
    let fake_queue = e2.delegated_fake(SYSTEM, vec![0; 8]);
    let mut ix = e2.ix_open_round(&p2, 1, false);
    ix.accounts[12].pubkey = fake_queue;
    let hk = e2.house.insecure_clone();
    expect_code(e2.send(Er, &hk, &[], &[ix]), code::BAD_ACCOUNT, "open_round with another VRF queue");
    println!("s15: lookalike Desk/Book/Table, type confusion and unpinned programs refused");
}

/// `join` only on house pools, only an empty or bot desk, one desk per key per pool; a
/// mid-round join reads that one desk and nothing else.
#[test]
fn s16_join_rules_and_takeover_scope() {
    let mut e = Env::new();
    let pool = e.pool(18, None);
    let (p1, p2) = (Keypair::new(), Keypair::new());
    e.ok(Er, &p1, &[], &[e.ix_join(&pool, &p1.pubkey(), 3, None)], "join");
    expect_code(e.send(Er, &p2, &[], &[e.ix_join(&pool, &p2.pubkey(), 3, None)]), code::SEAT_TAKEN, "join a human's desk");
    expect_code(e.send(Er, &p1, &[], &[e.ix_join(&pool, &p1.pubkey(), 4, None)]), code::ALREADY_SEATED, "second desk, same key");
    let bot5 = pool.bots[5].insecure_clone();
    expect_code(e.send(Er, &bot5, &[], &[e.ix_join(&pool, &bot5.pubkey(), 6, None)]), code::ALREADY_SEATED, "a seated bot key joins again");
    // Staked table: no join, no bots
    let h = e.house.insecure_clone();
    e.ok(Base, &h, &[], &[e.ix_create_pool_kind(&h.pubkey(), 19, 1)], "staked pool");
    for i in 0..8u8 {
        e.ok(Base, &h, &[], &[e.ix_create_desk(19, i)], "desk");
    }
    let staked = seat_pool(&mut e, Env::pool_ids(19));
    expect_code(e.send(Er, &p2, &[], &[e.ix_join(&staked, &p2.pubkey(), 0, None)]), code::BAD_KIND, "join a staked table");
    // Mid-round takeover of a bot desk: the joiner reads that desk only
    e.open(&pool, 1, false);
    let d = u64_at(&e.er(&pool.table), off::table::NEXT_DEADLINE);
    e.warp_resolve(&pool, d);
    e.ok(Er, &p2, &[], &[e.ix_join(&pool, &p2.pubkey(), 6, None)], "join in LIVE");
    assert!(e.can_read(Some(p2.pubkey()), &pool.desks[6]));
    assert!(!e.can_read(Some(pool.bots[6].pubkey()), &pool.desks[6]), "the replaced bot still reads");
    assert!(!e.can_read(Some(p2.pubkey()), &pool.book), "joiner reads the Book");
    for s in (0..8).filter(|&s| s != 6) {
        assert!(!e.can_read(Some(p2.pubkey()), &pool.desks[s]), "joiner reads desk {s}");
    }
    println!("s16: join limited to empty/bot desks of house pools, one per key; takeover reads one desk");
}

/// One `act` CU value across kind, level, phase, key, seq and Book validity. The full
/// check (golden vectors, 1,000 random rounds, extreme states, ticks) is cu.rs
/// `constant_compute_ticks_and_acts`.
#[test]
fn s17_act_compute_is_one_value() {
    let mut e = Env::new();
    e.set_config(fast());
    let mut pool = e.pool(20, None);
    let other = e.pool(21, None);
    let s = stranger(&mut e);
    let mut cu = Cu::default();
    let bot = pool.bots[1].insecure_clone();
    let run = |e: &mut Env, pool: &mut Pool, cu: &mut Cu| {
        for (kind, lvl) in [(0u8, 0u8), (1, 3), (2, 24), (2, 0), (9, 30), (1, 255)] {
            cu.add("act", e.act(pool, 1, kind, lvl, [kind; 16]));
        }
        cu.add("act", e.act_raw(&s, &pool.desks[1], &pool.book, 2, 5, 4_000_000, [1; 16]));
        cu.add("act", e.act_raw(&bot, &pool.desks[1], &pool.book, 2, 5, 0, [1; 16]));
        cu.add("act", e.act_raw(&bot, &pool.desks[1], &other.book, 2, 5, pool.seq[1] + 1, [1; 16]));
        pool.seq[1] += 2;
    };
    run(&mut e, &mut pool, &mut cu); // IDLE
    e.open(&pool, 1, false);
    run(&mut e, &mut pool, &mut cu); // HIDE
    e.tick(&pool);
    run(&mut e, &mut pool, &mut cu); // LIVE
    e.tick_to_bell(&pool);
    run(&mut e, &mut pool, &mut cu); // BELL
    println!("s17: {}", cu.report());
    cu.assert_constant();
}

/// The crank task id is the on-chain derivation from the slot hash of the opening
/// slot, never an argument (`open_round` takes only the round number). Squat resistance and the
/// reschedule are lifecycle.rs `task_id_changes_with_the_slot_hash` and
/// `reschedule_crank_after_a_stall` (stranger refused, not before a stall, fresh id).
#[test]
fn s18_task_id_is_derived_on_chain() {
    let mut e = Env::new();
    let pool = e.pool(22, None);
    let sh = e.er(&SLOT_HASHES);
    let ix = e.ix_open_round(&pool, 1, false);
    assert_eq!(ix.data.len(), 16, "open_round takes only the round number");
    e.open(&pool, 1, false);
    let want = sha(&[b"ping/task", &22u64.to_le_bytes(), &1u64.to_le_bytes(), &sh[16..48]]);
    let want = u64::from_le_bytes(want[..8].try_into().unwrap()) & (i64::MAX as u64);
    assert_eq!(u64_at(&e.er(&pool.table), off::table::TASK_ID), want);
    let s = stranger(&mut e);
    let ix = as_signer(e.ix_reschedule(&pool), &s.pubkey());
    expect_code(e.send(Er, &s, &[], &[ix]), code::NOT_HOUSE, "stranger reschedule");
    let h = e.house.insecure_clone();
    expect_code(e.send(Er, &h, &[], &[e.ix_reschedule(&pool)]), code::NOT_STALLED, "reschedule without a stall");
    println!("s18: task id = sha256(ping/task, table, round, slot hash) & i64::MAX = {want}");
}

/// Finding: `Desk.last_seq` used to survive a change of key, so a player could send seq
/// u32::MAX and leave the desk unable to act for every later holder (bots included) for good.
/// A new key now starts its own run.
#[test]
fn f_seq_exhaustion_cannot_brick_a_desk() {
    let mut e = Env::new();
    let mut pool = e.pool(23, None);
    let h = e.house.insecure_clone();
    let p = Keypair::new();
    e.ok(Er, &p, &[], &[e.ix_join(&pool, &p.pubkey(), 3, None)], "join");
    e.act_raw(&p, &pool.desks[3], &pool.book, 0, 0, u32::MAX, [0; 16]);
    assert_eq!(u32_at(&e.er(&pool.desks[3]), off::desk::LAST_SEQ), u32::MAX);
    // The house reseats a bot between rounds: it can act again from seq 1
    let k = pool.bots[3].pubkey();
    e.ok(Er, &h, &[], &[e.ix_join_bot(&pool, 3, &k)], "reclaim");
    e.open(&pool, 1, false);
    pool.seq[3] = 1;
    e.act(&mut pool, 3, 2, 9, [1; 16]);
    let d = e.er(&pool.desks[3]);
    assert_eq!((u32_at(&d, off::desk::LAST_SEQ), d[off::desk::LEVEL]), (1, 9), "desk 3 stayed bricked after the reclaim");
    // A mid-round takeover starts the joiner at seq 1 too, and the bot's next acts are no-ops
    let q = Keypair::new();
    e.ok(Er, &q, &[], &[e.ix_join(&pool, &q.pubkey(), 3, None)], "join in HIDE");
    e.act_raw(&q, &pool.desks[3], &pool.book, 2, 11, 1, [2; 16]);
    let bot = pool.bots[3].insecure_clone();
    e.act_raw(&bot, &pool.desks[3], &pool.book, 2, 12, 50, [2; 16]);
    let d = e.er(&pool.desks[3]);
    assert_eq!((u32_at(&d, off::desk::LAST_SEQ), d[off::desk::LEVEL]), (1, 11));
    // The same bot re-seated on its own seat keeps its count
    let mut e2 = Env::new();
    let mut p2 = e2.pool(24, None);
    e2.act(&mut p2, 2, 0, 0, [0; 16]);
    e2.act(&mut p2, 2, 0, 0, [0; 16]);
    let k2 = p2.bots[2].pubkey();
    let h2 = e2.house.insecure_clone();
    e2.ok(Er, &h2, &[], &[e2.ix_join_bot(&p2, 2, &k2)], "re-seat same bot");
    assert_eq!(u32_at(&e2.er(&p2.desks[2]), off::desk::LAST_SEQ), 2);
    println!("f-seq: last_seq restarts for a new key; a reclaimed desk acts again");
}

/// Re-seal cycles cost the pool nothing: after three full rounds (reveal, unseal, re-seal, open)
/// the Table, Book and Desks hold the same lamports on the rollup as before.
#[test]
fn reseal_cycles_keep_pool_lamports() {
    let mut e = Env::new();
    e.set_config(fast());
    let pool = e.pool(25, None);
    let accs: Vec<Address> = [pool.table, pool.book].iter().chain(pool.desks.iter()).copied().collect();
    let before: Vec<u64> = accs.iter().map(|a| e.lamports(Er, a)).collect();
    for n in 1..=3u64 {
        e.open(&pool, n, false);
        e.tick_to_bell(&pool);
        e.reveal(&pool, None);
        e.unseal_all(&pool);
        e.reseal(&pool);
    }
    let after: Vec<u64> = accs.iter().map(|a| e.lamports(Er, a)).collect();
    println!("reseal: lamports before {before:?}\n        after  {after:?}");
    assert_eq!(before, after, "re-seal cycles drain the pool accounts");
}
