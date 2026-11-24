//! Security tests of the base-layer instructions: Config, pool and record creation, delegation,
//! and the Tape money path (`place_call`, `settle_round`, `claim_call`, `close_round`).
//! A finished Round is produced here by writing a REVEALED/ABORTED status into a Round that lives
//! on base and is owned by the program, the state `commit_round` leaves it in (the real commit is
//! exercised in security_rollup.rs `s02_only_the_house_commits_only_a_finished_round`).
mod common;
use common::*;
use solana_account::Account;
use solana_address::Address;
use solana_keypair::Keypair;
use solana_signer::Signer;

const T0: i64 = 1_800_000_000;
const CALL: u64 = 10_000_000;

mod tape_off {
    pub const CLOSE_UNIX: usize = 24;
    pub const POOL: usize = 32;
    pub const TOTAL: usize = 96;
    pub const PAID: usize = 104;
    pub const OPEN_CALLS: usize = 112;
    pub const WINNER: usize = 120;
    pub const RESOLVED: usize = 121;
    pub const VOID: usize = 122;
}

fn setup(id: u64) -> (Env, Pool) {
    let mut e = Env::new();
    e.set_base_unix(T0);
    let pool = e.base_pool(id);
    (e, pool)
}

/// Creates record `n` planned at T0 (calls close at T0 + 5 + 15).
fn record(e: &mut Env, pool: &Pool, n: u64) -> (Address, Address) {
    let h = e.house.insecure_clone();
    let ix = e.ix_create_record_at(&h.pubkey(), pool, n, T0);
    e.ok(Base, &h, &[], &[ix], "create_record");
    (pool.round_pda(n), pool.tape_pda(n))
}

fn finish_round(e: &mut Env, round: &Address, status: u8, top: u8) {
    e.patch_base(round, off::round::STATUS, &[status]);
    e.patch_base(round, off::round::TOP_DESK, &[top]);
}

fn call(e: &mut Env, tape: Address, desk: u8) -> Keypair {
    let b = e.funded(1_000_000_000);
    let ix = e.ix_place_call(&b.pubkey(), tape, desk);
    e.ok(Base, &b, &[], &[ix], "place_call");
    b
}

fn claim(e: &mut Env, caller: &Keypair, tape: Address, bettor: &Address) -> Result<u64, String> {
    let ix = Env::ix_claim(&caller.pubkey(), tape, Env::call_pda(&tape, bettor), *bettor);
    e.send(Base, caller, &[], &[ix])
}

/// Pool, desk and record creation are house-only; the Config can only
/// be created by a listed admin and changed by its admin.
#[test]
fn s06_only_the_house_creates_pools_desks_records() {
    let (mut e, pool) = setup(600);
    let s = e.funded(10_000_000_000);
    let ix = e.ix_create_pool_kind(&s.pubkey(), 601, 0);
    expect_code(e.send(Base, &s, &[], &[ix]), code::NOT_HOUSE, "stranger create_pool");
    // A pool with no desks yet: the stranger tries to add one
    let h = e.house.insecure_clone();
    e.ok(Base, &h, &[], &[e.ix_create_pool(602)], "create_pool 602");
    let mut ix2 = e.ix_create_desk(602, 3);
    ix2.accounts[0].pubkey = s.pubkey();
    expect_code(e.send(Base, &s, &[], &[ix2]), code::NOT_HOUSE, "stranger create_desk");
    let ix = e.ix_create_record_at(&s.pubkey(), &pool, 1, T0);
    expect_code(e.send(Base, &s, &[], &[ix]), code::NOT_HOUSE, "stranger create_record");
    // Update_config: only Config.admin
    let p = CfgParams { house: s.pubkey(), tee_validator: TEE_VALIDATOR, vrf_queue: ER_QUEUE, beat_slots: 150, hide_slots: 500, crank_iterations: 220 };
    let ix = e.ix_update_config(&s.pubkey(), &p);
    expect_code(e.send(Base, &s, &[], &[ix]), code::NOT_ADMIN, "stranger update_config");
    // Init_config (Config not yet created): an unlisted key is refused, before anyone else
    let mut e2 = Env::new();
    e2.svm.set_account(e2.config, Account::default()).unwrap();
    let s2 = e2.funded(1_000_000_000);
    let ix = e2.ix_init_config(&s2.pubkey(), &p);
    expect_code(e2.send(Base, &s2, &[], &[ix]), code::NOT_ADMIN, "stranger init_config");
    assert!(!e2.exists(Base, &e2.config), "Config created by a stranger");
    println!("s06: create_pool / create_desk / create_record / update_config / init_config refuse strangers");
}

/// `delegate` needs the house signer and `validator == Config.tee_validator`, derives the PDA
/// from (kind, table, index), and delegates nothing else. The default (devnet) build only accepts
/// the TEE validator and never the local identity or the VRF test queue in the Config.
#[test]
fn s03_delegate_only_by_the_house_to_the_pinned_validator() {
    let (mut e, pool) = setup(300);
    let h = e.house.insecure_clone();
    let s = e.funded(1_000_000_000);
    let cfg_validator = Address::try_from(&e.data(Base, &e.config)[128..160]).unwrap();
    let other_validator = Keypair::new().pubkey();
    let ix = e.ix_delegate(&s.pubkey(), 0, 300, 0, pool.table, cfg_validator);
    expect_code(e.send(Base, &s, &[], &[ix]), code::NOT_HOUSE, "stranger delegate");
    let ix = e.ix_delegate(&h.pubkey(), 0, 300, 0, pool.table, other_validator);
    expect_code(e.send(Base, &h, &[], &[ix]), code::BAD_VALIDATOR, "delegate to another validator");
    let ix = e.ix_delegate(&h.pubkey(), 1, 300, 0, pool.table, cfg_validator);
    expect_code(e.send(Base, &h, &[], &[ix]), code::BAD_ACCOUNT, "Table passed as the Book");
    let ix = e.ix_delegate(&h.pubkey(), 2, 300, 9, pool.desks[1], cfg_validator);
    expect_code(e.send(Base, &h, &[], &[ix]), code::BAD_KIND, "desk index 9");
    let ix = e.ix_delegate(&h.pubkey(), 4, 300, 0, pool.ledger, cfg_validator);
    expect_code(e.send(Base, &h, &[], &[ix]), code::BAD_KIND, "the Ledger");
    let ix = e.ix_delegate(&h.pubkey(), 2, 300, 1, pool.desks[1], cfg_validator);
    e.ok(Base, &h, &[], &[ix], "house delegates desk 1");
    assert_eq!(e.svm.get_account_for(Base, &pool.desks[1]).unwrap().owner, DELEGATION_PROGRAM);
    // Config validation (this build): TEE validator only, the rollup queue or none
    let mut p = CfgParams { house: h.pubkey(), tee_validator: TEE_VALIDATOR, vrf_queue: ER_QUEUE, beat_slots: 150, hide_slots: 500, crank_iterations: 220 };
    e.ok(Base, &h, &[], &[e.ix_update_config(&h.pubkey(), &p)], "update_config with the TEE validator");
    p.tee_validator = other_validator;
    expect_code(e.send(Base, &h, &[], &[e.ix_update_config(&h.pubkey(), &p)]), code::BAD_VALIDATOR, "foreign validator");
    p.tee_validator = LOCAL_VALIDATOR;
    expect_code(e.send(Base, &h, &[], &[e.ix_update_config(&h.pubkey(), &p)]), code::BAD_VALIDATOR, "local validator in a devnet build");
    p.tee_validator = TEE_VALIDATOR;
    p.vrf_queue = VRF_TEST_QUEUE;
    expect_code(e.send(Base, &h, &[], &[e.ix_update_config(&h.pubkey(), &p)]), code::BAD_PARAM, "VRF test queue in a devnet build");
    p.vrf_queue = Address::default();
    e.ok(Base, &h, &[], &[e.ix_update_config(&h.pubkey(), &p)], "VRF off (fallback seed)");
    // A crank that is never cancelled stops: iterations are bounded
    p.crank_iterations = 10_001;
    expect_code(e.send(Base, &h, &[], &[e.ix_update_config(&h.pubkey(), &p)]), code::BAD_PARAM, "crank iterations above the cap");
    p.crank_iterations = 10_000;
    e.ok(Base, &h, &[], &[e.ix_update_config(&h.pubkey(), &p)], "crank iterations at the cap");
    println!("s03: delegate house-only, pinned validator, PDA from (kind, table, index); Config pins the TEE");
}

/// Settlement writes owed amounts only; each claim pays the Call's own
/// bettor whoever sends it; a repeated claim pays nothing; Σ payouts ≤ pool with the floor
/// remainder left in the Tape; the Tape never goes below its rent minimum.
#[test]
fn s12_claims_pay_each_owner_once() {
    let (mut e, pool) = setup(120);
    let (round, tape) = record(&mut e, &pool, 1);
    let winners: Vec<Keypair> = (0..3).map(|_| call(&mut e, tape, 2)).collect();
    let loser = call(&mut e, tape, 5);
    // A second call from the same bettor: refused (one Call PDA per bettor per Tape)
    let ix = e.ix_place_call(&loser.pubkey(), tape, 2);
    expect_fail(e.send(Base, &loser, &[], &[ix]), "second call");
    let ix = e.ix_place_call(&loser.pubkey(), tape, 8);
    expect_fail(e.send(Base, &loser, &[], &[ix]), "call on desk 8");
    let late = e.funded(1_000_000_000);
    e.set_base_unix(T0 + 20);
    let ix = e.ix_place_call(&late.pubkey(), tape, 2);
    expect_code(e.send(Base, &late, &[], &[ix]), code::CALLS_CLOSED, "call at close_unix");
    // Settle before the round is finished: refused; then REVEALED with desk 2 on top
    finish_round(&mut e, &round, 1, 255);
    let s = e.funded(1_000_000_000);
    expect_code(e.send(Base, &s, &[], &[Env::ix_settle(&s.pubkey(), round, tape)]), code::ROUND_IN_PLAY, "settle an OPEN round");
    // A claim before settlement (and before the 30-min refund point): refused
    expect_code(claim(&mut e, &s, tape, &winners[0].pubkey()), code::NOT_SETTLED, "claim before settle");
    finish_round(&mut e, &round, 2, 2);
    e.ok(Base, &s, &[], &[Env::ix_settle(&s.pubkey(), round, tape)], "settle");
    let t = e.data(Base, &tape);
    assert_eq!((t[tape_off::WINNER], t[tape_off::RESOLVED], t[tape_off::VOID]), (2, 1, 0));
    // Settle again (even after the Round changes): a no-op
    finish_round(&mut e, &round, 3, 5);
    e.ok(Base, &s, &[], &[Env::ix_settle(&s.pubkey(), round, tape)], "settle twice");
    assert_eq!(e.data(Base, &tape), t, "second settle changed the Tape");
    finish_round(&mut e, &round, 2, 2);
    let total = u64_at(&t, tape_off::TOTAL);
    assert_eq!(total, 4 * CALL);
    let want = (CALL as u128 * total as u128 / (3 * CALL) as u128) as u64;
    // A stranger sends the claim for winner 0: the winner is paid, the stranger only pays the fee
    let (w0, s_before) = (e.lamports(Base, &winners[0].pubkey()), e.lamports(Base, &s.pubkey()));
    let call_rent = e.lamports(Base, &Env::call_pda(&tape, &winners[0].pubkey()));
    e.ok(Base, &s, &[], &[Env::ix_claim(&s.pubkey(), tape, Env::call_pda(&tape, &winners[0].pubkey()), winners[0].pubkey())], "claim for w0");
    assert_eq!(e.lamports(Base, &winners[0].pubkey()), w0 + want + call_rent, "w0 payout + Call rent");
    assert!(e.lamports(Base, &s.pubkey()) <= s_before, "the caller gained");
    // The stranger names itself as bettor with w1's Call: seeds bind the Call to its bettor
    let ix = Env::ix_claim(&s.pubkey(), tape, Env::call_pda(&tape, &winners[1].pubkey()), s.pubkey());
    expect_code(e.send(Base, &s, &[], &[ix]), code::CONSTRAINT_SEEDS, "claim w1's Call to the stranger");
    // Repeat claim: the Call is closed, nothing is paid
    let w0_after = e.lamports(Base, &winners[0].pubkey());
    // (the closed Call belongs to the System program again)
    expect_code(claim(&mut e, &s, tape, &winners[0].pubkey()), code::WRONG_OWNER, "repeat claim");
    assert_eq!(e.lamports(Base, &winners[0].pubkey()), w0_after);
    for w in &winners[1..] {
        let k = w.insecure_clone();
        claim(&mut e, &k, tape, &w.pubkey()).expect("winner claim");
    }
    let l_before = e.lamports(Base, &loser.pubkey());
    let lk = loser.insecure_clone();
    claim(&mut e, &lk, tape, &loser.pubkey()).expect("loser claim (closes its Call)");
    assert!(e.lamports(Base, &loser.pubkey()) > l_before - 10_000, "loser lost more than the fee");
    let t = e.data(Base, &tape);
    let paid = u64_at(&t, tape_off::PAID);
    assert_eq!(paid, 3 * want);
    assert!(paid <= total && total - paid < 3, "Σ payouts {paid} vs pool {total}");
    assert_eq!(u32_at(&t, tape_off::OPEN_CALLS), 0);
    let rent_min = e.svm.base().minimum_balance_for_rent_exemption(t.len());
    assert_eq!(e.lamports(Base, &tape), rent_min + total - paid, "Tape = rent + floor remainder");
    println!("s12: pool {total}, 3 winners × {want}, dust {} left for the house", total - paid);
}

/// A payout that would leave a 0-lamport bettor below the rent minimum stays owed and the
/// claim succeeds; once the bettor holds SOL the same claim pays it.
#[test]
fn s12_sub_minimum_payout_stays_owed() {
    let (mut e, pool) = setup(121);
    let small = 100_000u64;
    let cfg = e.config;
    e.patch_base(&cfg, 24, &small.to_le_bytes());
    let (round, tape) = record(&mut e, &pool, 1);
    let b = call(&mut e, tape, 4);
    e.svm.set_account(b.pubkey(), Account::default()).unwrap();
    finish_round(&mut e, &round, 3, 255); // ABORTED: everyone refunded
    let s = e.funded(1_000_000_000);
    e.ok(Base, &s, &[], &[Env::ix_settle(&s.pubkey(), round, tape)], "settle aborted");
    assert_eq!(e.data(Base, &tape)[tape_off::VOID], 1);
    let c = Env::call_pda(&tape, &b.pubkey());
    claim(&mut e, &s, tape, &b.pubkey()).expect("sub-minimum claim succeeds");
    assert_eq!(e.lamports(Base, &b.pubkey()), 0, "a sub-minimum amount was sent");
    assert_eq!(u64_at(&e.data(Base, &c), 16), small, "Call.owed");
    e.svm.airdrop(&b.pubkey(), 1_000_000_000).unwrap();
    claim(&mut e, &s, tape, &b.pubkey()).expect("claim once funded");
    assert!(!e.exists(Base, &c), "Call still open");
    assert!(e.lamports(Base, &b.pubkey()) >= 1_000_000_000 + small);
    println!("s12: {small} lamports owed to a 0-lamport burner, paid after it was funded");
}

/// A Round settles only its own Tape, and a Call is claimed only against
/// its own Tape.
#[test]
fn s04_no_cross_table_round_tape_or_call() {
    let (mut e, a) = setup(130);
    let b = e.base_pool(131);
    let (ra, ta) = record(&mut e, &a, 1);
    let (rb, tb) = record(&mut e, &b, 1);
    let bettor = call(&mut e, ta, 2);
    call(&mut e, tb, 2);
    finish_round(&mut e, &ra, 2, 2);
    finish_round(&mut e, &rb, 2, 7);
    let s = e.funded(1_000_000_000);
    expect_code(e.send(Base, &s, &[], &[Env::ix_settle(&s.pubkey(), ra, tb)]), code::CONSTRAINT_SEEDS, "Round A settles Tape B");
    expect_code(e.send(Base, &s, &[], &[Env::ix_settle(&s.pubkey(), ra, ra)]), code::DISCRIMINATOR_MISMATCH, "Round passed as Tape");
    e.ok(Base, &s, &[], &[Env::ix_settle(&s.pubkey(), ra, ta)], "settle A");
    e.ok(Base, &s, &[], &[Env::ix_settle(&s.pubkey(), rb, tb)], "settle B");
    // The A call presented against Tape B
    let ix = Env::ix_claim(&s.pubkey(), tb, Env::call_pda(&ta, &bettor.pubkey()), bettor.pubkey());
    expect_code(e.send(Base, &s, &[], &[ix]), code::CONSTRAINT_SEEDS, "Call of Tape A claimed on Tape B");
    // A Ledger is not a Tape, a Desk is not a Round
    expect_fail(e.send(Base, &s, &[], &[Env::ix_settle(&s.pubkey(), a.desks[0], ta)]), "Desk as Round");
    println!("s04: Round/Tape/Call substitution across tables refused");
}

/// A record number never repeats (even after `close_round`); `close_round` is house-only,
/// never on a Round in play, and only after every claim or the 24-h timeout; an unsettled Tape
/// refunds after 30 min and a later settle cannot undo that.
#[test]
fn s13_close_and_reopen_rules() {
    let (mut e, pool) = setup(140);
    let h = e.house.insecure_clone();
    let (round, tape) = record(&mut e, &pool, 1);
    let ix = e.ix_create_record_at(&h.pubkey(), &pool, 1, T0);
    expect_fail(e.send(Base, &h, &[], &[ix]), "create_record 1 twice");
    let b1 = call(&mut e, tape, 2);
    let b2 = call(&mut e, tape, 3);
    let s = e.funded(1_000_000_000);
    // In play (still on the rollup): the base copy belongs to the delegation program
    e.svm.delegate_account(round).unwrap();
    expect_fail(e.send(Base, &s, &[], &[Env::ix_settle(&s.pubkey(), round, tape)]), "settle a delegated Round");
    let ix = e.ix_close_round(&h.pubkey(), round, tape);
    expect_fail(e.send(Base, &h, &[], &[ix]), "close a delegated Round");
    // 30 min after the close the Tape refunds without a settle
    let close = i64::from_le_bytes(e.data(Base, &tape)[tape_off::CLOSE_UNIX..tape_off::CLOSE_UNIX + 8].try_into().unwrap());
    e.set_base_unix(close + 30 * 60 - 1);
    expect_code(claim(&mut e, &s, tape, &b1.pubkey()), code::NOT_SETTLED, "refund 1 s early");
    e.set_base_unix(close + 30 * 60);
    let before = e.lamports(Base, &b1.pubkey());
    claim(&mut e, &s, tape, &b1.pubkey()).expect("auto-void refund");
    assert!(e.lamports(Base, &b1.pubkey()) >= before + CALL);
    // The Round comes back REVEALED later: settle is a no-op, the Tape stays void
    e.svm.undelegate_account(round);
    finish_round(&mut e, &round, 2, 3);
    e.ok(Base, &s, &[], &[Env::ix_settle(&s.pubkey(), round, tape)], "late settle");
    assert_eq!(e.data(Base, &tape)[tape_off::VOID], 1, "late settle undid the refund");
    // Close: stranger refused; house refused while b2's call is open, before 24 h
    let ix = e.ix_close_round(&s.pubkey(), round, tape);
    expect_code(e.send(Base, &s, &[], &[ix]), code::NOT_HOUSE, "stranger close");
    let ix = e.ix_close_round(&h.pubkey(), round, tape);
    expect_code(e.send(Base, &h, &[], &[ix]), code::TAPE_OPEN, "close with an open call");
    // An OPEN Round is never closed
    finish_round(&mut e, &round, 1, 255);
    e.set_base_unix(close + 24 * 3600);
    let ix = e.ix_close_round(&h.pubkey(), round, tape);
    expect_code(e.send(Base, &h, &[], &[ix]), code::ROUND_IN_PLAY, "close an OPEN Round");
    finish_round(&mut e, &round, 2, 3);
    let hb = e.lamports(Base, &h.pubkey());
    let held = e.lamports(Base, &tape) + e.lamports(Base, &round);
    let ix = e.ix_close_round(&h.pubkey(), round, tape);
    e.ok(Base, &h, &[], &[ix], "close after 24 h");
    assert!(!e.exists(Base, &round) && !e.exists(Base, &tape));
    assert!(e.lamports(Base, &h.pubkey()) + 10_000 >= hb + held, "lamports went elsewhere");
    // The closed (table, round) can never be created again, nor an older number
    let ix = e.ix_create_record_at(&h.pubkey(), &pool, 1, T0);
    expect_code(e.send(Base, &h, &[], &[ix]), code::BAD_ROUND, "recreate closed record 1");
    let _ = b2;
    println!("s13: record numbers monotonic, close rules and the 30-min / 24-h timeouts hold");
}

/// Counters and lamport sums are checked: an overflow is an error, never a wrap or a
/// panic that pays the wrong amount.
#[test]
fn s11_base_overflow_is_an_error() {
    let (mut e, pool) = setup(150);
    let (_, tape) = record(&mut e, &pool, 1);
    e.patch_base(&tape, tape_off::TOTAL, &(u64::MAX - 1).to_le_bytes());
    let b = e.funded(1_000_000_000);
    let ix = e.ix_place_call(&b.pubkey(), tape, 1);
    expect_code(e.send(Base, &b, &[], &[ix]), code::OVERFLOW, "Tape.total overflow");
    e.patch_base(&tape, tape_off::TOTAL, &0u64.to_le_bytes());
    e.patch_base(&tape, tape_off::POOL + 8, &u64::MAX.to_le_bytes());
    let ix = e.ix_place_call(&b.pubkey(), tape, 1);
    expect_code(e.send(Base, &b, &[], &[ix]), code::OVERFLOW, "Tape.pool overflow");
    let ledger = pool.ledger;
    e.patch_base(&ledger, 24, &u64::MAX.to_le_bytes());
    let h = e.house.insecure_clone();
    let ix = e.ix_create_record_at(&h.pubkey(), &pool, 2, T0);
    expect_code(e.send(Base, &h, &[], &[ix]), code::OVERFLOW, "Ledger.records overflow");
    let ix = e.ix_create_record_at(&h.pubkey(), &pool, 3, i64::MAX - 5);
    e.patch_base(&ledger, 24, &0u64.to_le_bytes());
    expect_code(e.send(Base, &h, &[], &[ix]), code::OVERFLOW, "close_unix overflow");
    println!("s11: Tape/Ledger overflows are errors");
}

/// Squatting: lamports sent in advance to the address of a future Table, Round, Tape, Call, or a
/// delegation buffer/record do not stop the house (or a bettor) from creating or delegating it.
#[test]
fn squat_prefunded_pdas_do_not_block_creation() {
    let mut e = Env::new();
    e.set_base_unix(T0);
    let h = e.house.insecure_clone();
    let squatter = e.funded(10_000_000_000);
    let fund = |e: &mut Env, a: Address| {
        let ix = solana_instruction::Instruction {
            program_id: SYSTEM,
            accounts: vec![meta_ws(squatter.pubkey()), meta_w(a)],
            data: {
                let mut d = 2u32.to_le_bytes().to_vec();
                d.extend_from_slice(&1_000_000u64.to_le_bytes());
                d
            },
        };
        let k = squatter.insecure_clone();
        e.ok(Base, &k, &[], &[ix], "prefund");
    };
    let ids = Env::pool_ids(170);
    for a in [ids.table, ids.book, ids.ledger, ids.desks[0]] {
        fund(&mut e, a);
    }
    let pool = e.base_pool(170);
    let round = pool.round_pda(1);
    let buffer = Address::find_program_address(&[b"buffer", round.as_ref()], &PROGRAM).0;
    let drec = Address::find_program_address(&[b"delegation", round.as_ref()], &DELEGATION_PROGRAM).0;
    for a in [round, pool.tape_pda(1), buffer, drec] {
        fund(&mut e, a);
    }
    let cfg_validator = Address::try_from(&e.data(Base, &e.config)[128..160]).unwrap();
    let ixs = [e.ix_create_record_at(&h.pubkey(), &pool, 1, T0), e.ix_delegate(&h.pubkey(), 3, 170, 1, round, cfg_validator)];
    e.ok(Base, &h, &[], &ixs, "create_record + delegate over squatted PDAs");
    assert_eq!(e.svm.get_account_for(Base, &round).unwrap().owner, DELEGATION_PROGRAM);
    let b = e.funded(1_000_000_000);
    fund(&mut e, Env::call_pda(&pool.tape_pda(1), &b.pubkey()));
    let ix = e.ix_place_call(&b.pubkey(), pool.tape_pda(1), 1);
    e.ok(Base, &b, &[], &[ix], "place_call over a squatted Call PDA");
    println!("squat: prefunded Table/Book/Ledger/Desk/Round/Tape/buffer/record/Call PDAs did not block anything");
}
