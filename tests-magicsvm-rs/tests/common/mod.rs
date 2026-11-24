//! Harness for the ping program on MagicSVM (base layer + ephemeral rollup in one process).
//! Instructions are encoded by hand: the Anchor discriminator (`sha256("global:<name>")[0..8]`),
//! fixed-size Borsh arguments and the account lists of the IDL, so the tests also pin the wire
//! format every client uses. Accounts are read by byte offset (layouts: programs/ping/src/state.rs).
#![allow(dead_code)]

use magicsvm::{MagicSVM, TransactionTarget};
use sha2::{Digest, Sha256};
use solana_account::Account;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use std::path::PathBuf;

pub use TransactionTarget::{Base, Ephemeral as Er};

pub const PROGRAM: Address = Address::from_str_const("5eP2A36T97mwaGHf6XoHZU6VoKh1NGxA2QwvtJhAJ6ms");
pub const SYSTEM: Address = Address::from_str_const("11111111111111111111111111111111");
pub const MAGIC_PROGRAM: Address = Address::from_str_const("Magic11111111111111111111111111111111111111");
pub const MAGIC_CONTEXT: Address = Address::from_str_const("MagicContext1111111111111111111111111111111");
pub const EPHEMERAL_VAULT: Address = Address::from_str_const("MagicVau1t999999999999999999999999999999999");
pub const PERMISSION_PROGRAM: Address = Address::from_str_const("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");
pub const VRF_PROGRAM: Address = Address::from_str_const("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");
pub const ER_QUEUE: Address = Address::from_str_const("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");
pub const SLOT_HASHES: Address = Address::from_str_const("SysvarS1otHashes111111111111111111111111111");
pub const LOCAL_VALIDATOR: Address = Address::from_str_const("mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev");

// phases
pub const IDLE: u8 = 0;
pub const HIDE: u8 = 1;
pub const LIVE: u8 = 2;
pub const BELL: u8 = 3;
pub const REVEALED: u8 = 4;

// ---- account offsets (discriminator included)
pub mod off {
    pub mod table {
        pub const ROUND: usize = 16;
        pub const OPEN_SLOT: usize = 24;
        pub const HIDE_END_SLOT: usize = 32;
        pub const NEXT_DEADLINE: usize = 40;
        pub const BELL_SLOT: usize = 48;
        pub const TASK_ID: usize = 64;
        pub const TICK_CALLS: usize = 80;
        pub const RESOLVES: usize = 88;
        pub const VRF_FULFIL_SLOT: usize = 104;
        pub const CHAIN_HEAD: usize = 248;
        pub const COMMIT: usize = 280;
        pub const SEATS: usize = 312;
        pub const PICKED: usize = 760;
        pub const TOTALS: usize = 776;
        pub const BEAT_FILL: usize = 792;
        pub const SEALED: usize = 808;
        pub const BEAT: usize = 810;
        pub const PRINTS: usize = 812;
        pub const BEAT_COUNTS: usize = 1004;
        pub const PHASE: usize = 1069;
        pub const TOP_DESK: usize = 1072;
        pub const FALLBACK: usize = 1074;
        pub const VRF_FULFILS: usize = 1075;
        pub const PRINT_COUNT: usize = 148;
    }
    pub mod book {
        pub const ROUND: usize = 16;
        pub const VRF_SLOT: usize = 24;
        pub const STATE: usize = 40;
        pub const STATE_LEN: usize = 1144;
    }
    pub mod desk {
        pub const TABLE_ID: usize = 8;
        pub const ROUND: usize = 16;
        pub const ACK_SLOT: usize = 24;
        pub const KEY: usize = 40;
        pub const LAST_SEQ: usize = 72;
        pub const ACTS: usize = 76;
        pub const RESTING: usize = 80;
        pub const LEVEL: usize = 87;
        pub const PHASE: usize = 88;
        pub const PENDING_KIND: usize = 90;
        pub const PENDING_LEVEL: usize = 91;
        pub const PLACED: usize = 92;
        pub const RESULTS: usize = 96;
    }
    pub mod round {
        pub const COMMIT: usize = 96;
        pub const TOTALS: usize = 128;
        pub const STATUS: usize = 144;
        pub const TOP_DESK: usize = 146;
        pub const FALLBACK: usize = 147;
        pub const N_BEATS: usize = 148;
        pub const RECORD: usize = 160;
    }
}

pub fn sha(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

pub fn disc(name: &str) -> [u8; 8] {
    sha(&[format!("global:{name}").as_bytes()])[..8].try_into().unwrap()
}

pub fn acct_disc(name: &str) -> [u8; 8] {
    sha(&[format!("account:{name}").as_bytes()])[..8].try_into().unwrap()
}

pub fn pda(seeds: &[&[u8]]) -> (Address, u8) {
    Address::find_program_address(seeds, &PROGRAM)
}

pub fn permission_pda(target: &Address) -> Address {
    Address::find_program_address(&[b"permission:", target.as_ref()], &PERMISSION_PROGRAM).0
}

pub fn u16_at(d: &[u8], o: usize) -> u16 {
    u16::from_le_bytes(d[o..o + 2].try_into().unwrap())
}
pub fn u32_at(d: &[u8], o: usize) -> u32 {
    u32::from_le_bytes(d[o..o + 4].try_into().unwrap())
}
pub fn u64_at(d: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(d[o..o + 8].try_into().unwrap())
}

fn w(a: Address) -> AccountMeta {
    AccountMeta::new(a, false)
}
fn r(a: Address) -> AccountMeta {
    AccountMeta::new_readonly(a, false)
}
fn ws(a: Address) -> AccountMeta {
    AccountMeta::new(a, true)
}
fn rs(a: Address) -> AccountMeta {
    AccountMeta::new_readonly(a, true)
}

/// Network-ish parameters of a test pool (copied into the Table by `create_pool`).
#[derive(Clone, Copy)]
pub struct Params {
    pub beat_slots: u64,
    pub hide_slots: u64,
    pub crank_interval_ms: u32,
    pub crank_iterations: u32,
    pub tick_cu_limit: u32,
    pub vrf: bool,
}

impl Default for Params {
    /// MagicSVM runs 20 slots/s: 1.5-s beats = 30 slots, 5-s HIDE = 100 slots, 250-ms crank.
    fn default() -> Self {
        Params { beat_slots: 30, hide_slots: 100, crank_interval_ms: 250, crank_iterations: 400, tick_cu_limit: 400_000, vrf: true }
    }
}

pub struct Pool {
    pub id: u64,
    pub table: Address,
    pub book: Address,
    pub ledger: Address,
    pub desks: [Address; 8],
    pub bots: Vec<Keypair>,
    /// next seq per desk
    pub seq: [u32; 8],
}

impl Pool {
    pub fn round_pda(&self, n: u64) -> Address {
        pda(&[b"round", &self.id.to_le_bytes(), &n.to_le_bytes()]).0
    }
    pub fn tape_pda(&self, n: u64) -> Address {
        pda(&[b"tape", &self.id.to_le_bytes(), &n.to_le_bytes()]).0
    }
}

pub struct Env {
    pub svm: MagicSVM,
    pub house: Keypair,
    pub config: Address,
    nonce: u64,
}

pub fn deploy_so() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target/deploy/ping.so")
}

impl Env {
    pub fn new() -> Env {
        let mut svm = MagicSVM::new();
        let so = deploy_so();
        svm.add_program_from_file(PROGRAM, &so).unwrap_or_else(|e| panic!("load {}: {e} (run `make build-ping`)", so.display()));
        let house = Keypair::new();
        svm.airdrop(&house.pubkey(), 1_000_000_000_000).unwrap();
        let config = pda(&[b"config"]).0;
        let mut e = Env { svm, house, config, nonce: 0 };
        e.set_config(Params::default());
        e
    }

    /// Writes the Config account directly (the admin keys of `init_config` are deployment keys).
    pub fn set_config(&mut self, p: Params) {
        let (config, bump) = pda(&[b"config"]);
        let mut d = vec![0u8; 272];
        d[0..8].copy_from_slice(&acct_disc("Config"));
        d[8..16].copy_from_slice(&p.beat_slots.to_le_bytes());
        d[16..24].copy_from_slice(&p.hide_slots.to_le_bytes());
        d[24..32].copy_from_slice(&10_000_000u64.to_le_bytes());
        d[32..40].copy_from_slice(&1_000_000u64.to_le_bytes());
        d[40..44].copy_from_slice(&p.crank_interval_ms.to_le_bytes());
        d[44..48].copy_from_slice(&p.crank_iterations.to_le_bytes());
        d[48..52].copy_from_slice(&p.tick_cu_limit.to_le_bytes());
        d[52..56].copy_from_slice(&250u32.to_le_bytes());
        d[56..60].copy_from_slice(&5u32.to_le_bytes());
        d[60..64].copy_from_slice(&15u32.to_le_bytes());
        d[64..96].copy_from_slice(self.house.pubkey().as_ref());
        d[96..128].copy_from_slice(self.house.pubkey().as_ref());
        d[128..160].copy_from_slice(LOCAL_VALIDATOR.as_ref());
        if p.vrf {
            d[160..192].copy_from_slice(ER_QUEUE.as_ref());
        }
        d[192..195].copy_from_slice(&[5, 10, 15]);
        d[195] = 20;
        d[196] = 29;
        d[197] = 4;
        d[198] = 10;
        d[199] = 8;
        d[200] = 24;
        d[201] = bump;
        d[202] = 1;
        self.svm
            .set_account(config, Account { lamports: 10_000_000, data: d, owner: PROGRAM, executable: false, rent_epoch: 0 })
            .unwrap();
    }

    pub fn slot(&self) -> u64 {
        self.svm.ephemeral().get_sysvar::<solana_clock::Clock>().slot
    }

    /// Raw account bytes (ledger access, no read filter).
    pub fn data(&self, t: TransactionTarget, a: &Address) -> Vec<u8> {
        let acc = match t {
            Base => self.svm.base().get_account(a),
            Er => self.svm.ephemeral().get_account(a).or_else(|| self.svm.base().get_account(a)),
        };
        acc.unwrap_or_else(|| panic!("missing {a} on {t:?}")).data
    }

    /// Whether `viewer` (None = anonymous) may read `a` on the rollup (the permission filter).
    pub fn can_read(&mut self, viewer: Option<Address>, a: &Address) -> bool {
        let prev = self.svm.authorized_user();
        self.svm.set_authorized_user(viewer);
        let ok = self.svm.get_account_for(Er, a).is_some();
        self.svm.set_authorized_user(prev);
        ok
    }
    pub fn er(&self, a: &Address) -> Vec<u8> {
        self.data(Er, a)
    }

    /// Sends one transaction; returns compute units or the error with logs.
    pub fn send(&mut self, target: TransactionTarget, payer: &Keypair, extra: &[&Keypair], ixs: &[Instruction]) -> Result<u64, String> {
        let mut signers: Vec<&Keypair> = vec![payer];
        for k in extra {
            if k.pubkey() != payer.pubkey() {
                signers.push(k);
            }
        }
        let tx = Transaction::new(&signers, Message::new(ixs, Some(&payer.pubkey())), self.svm.latest_blockhash_for(target));
        let res = self.svm.send_transaction_to(target, tx);
        self.svm.expire_blockhash_for(target);
        match res {
            Ok(meta) => Ok(meta.compute_units_consumed),
            Err(f) => Err(format!("{:?}\n{:#?}", f.err, f.meta.logs)),
        }
    }

    pub fn ok(&mut self, target: TransactionTarget, payer: &Keypair, extra: &[&Keypair], ixs: &[Instruction], what: &str) -> u64 {
        self.send(target, payer, extra, ixs).unwrap_or_else(|e| panic!("{what} failed: {e}"))
    }

    fn house_kp(&self) -> Keypair {
        self.house.insecure_clone()
    }

    // ------------------------------------------------------------------ instructions
    pub fn ix_create_pool(&self, id: u64) -> Instruction {
        let mut data = disc("create_pool").to_vec();
        data.extend_from_slice(&id.to_le_bytes());
        data.push(0);
        data.extend_from_slice(&50_000_000u64.to_le_bytes());
        let p = |s: &[u8]| pda(&[s, &id.to_le_bytes()]).0;
        Instruction {
            program_id: PROGRAM,
            accounts: vec![ws(self.house.pubkey()), r(self.config), w(p(b"table")), w(p(b"book")), w(p(b"ledger")), r(SYSTEM)],
            data,
        }
    }

    pub fn ix_create_desk(&self, id: u64, i: u8) -> Instruction {
        let mut data = disc("create_desk").to_vec();
        data.extend_from_slice(&id.to_le_bytes());
        data.push(i);
        Instruction {
            program_id: PROGRAM,
            accounts: vec![
                ws(self.house.pubkey()),
                r(self.config),
                w(pda(&[b"table", &id.to_le_bytes()]).0),
                w(pda(&[b"desk", &id.to_le_bytes(), &[i]]).0),
                r(SYSTEM),
            ],
            data,
        }
    }

    pub fn ix_setup_permissions(&self, pool: &Pool, kind: u8, index: u64) -> Instruction {
        let mut data = disc("setup_permissions").to_vec();
        data.push(kind);
        data.extend_from_slice(&index.to_le_bytes());
        let target = match kind {
            0 => pool.table,
            1 => pool.book,
            2 => pool.desks[index as usize],
            _ => pool.round_pda(index),
        };
        Instruction {
            program_id: PROGRAM,
            accounts: vec![
                rs(self.house.pubkey()),
                w(pool.table),
                if kind == 0 { r(PROGRAM) } else { w(target) },
                w(permission_pda(&target)),
                r(PERMISSION_PROGRAM),
                w(EPHEMERAL_VAULT),
                r(MAGIC_PROGRAM),
            ],
            data,
        }
    }

    pub fn ix_unseal(&self, pool: &Pool, kind: u8, index: u64) -> Instruction {
        let mut data = disc("unseal").to_vec();
        data.push(kind);
        data.extend_from_slice(&index.to_le_bytes());
        let target = if kind == 1 { pool.book } else { pool.desks[index as usize] };
        Instruction {
            program_id: PROGRAM,
            accounts: vec![
                rs(self.house.pubkey()),
                w(pool.table),
                w(target),
                w(permission_pda(&target)),
                r(PERMISSION_PROGRAM),
                w(EPHEMERAL_VAULT),
                r(MAGIC_PROGRAM),
            ],
            data,
        }
    }

    pub fn ix_join_bot(&self, pool: &Pool, seat: u8, key: &Address) -> Instruction {
        let mut data = disc("join_bot").to_vec();
        data.push(seat);
        data.extend_from_slice(key.as_ref());
        data.push(1 + seat % 3);
        let mut name = [0u8; 16];
        name[..4].copy_from_slice(b"bot ");
        name[4] = b'0' + seat;
        data.extend_from_slice(&name);
        let desk = pool.desks[seat as usize];
        Instruction {
            program_id: PROGRAM,
            accounts: vec![
                rs(self.house.pubkey()),
                w(pool.table),
                w(desk),
                w(permission_pda(&desk)),
                r(PERMISSION_PROGRAM),
                w(EPHEMERAL_VAULT),
                r(MAGIC_PROGRAM),
            ],
            data,
        }
    }

    pub fn ix_join(&self, pool: &Pool, player: &Address, seat: u8, seat_pda: Option<Address>) -> Instruction {
        let mut data = disc("join").to_vec();
        data.push(seat);
        data.extend_from_slice(b"player\0\0\0\0\0\0\0\0\0\0");
        let desk = seat_pda.unwrap_or(pool.desks[seat as usize % 8]);
        Instruction {
            program_id: PROGRAM,
            accounts: vec![
                rs(*player),
                w(pool.table),
                w(desk),
                w(permission_pda(&desk)),
                r(PERMISSION_PROGRAM),
                w(EPHEMERAL_VAULT),
                r(MAGIC_PROGRAM),
            ],
            data,
        }
    }

    pub fn ix_open_round(&self, pool: &Pool, n: u64, recorded: bool) -> Instruction {
        let mut data = disc("open_round").to_vec();
        data.extend_from_slice(&n.to_le_bytes());
        let mut accounts = vec![ws(self.house.pubkey()), w(pool.table), w(pool.book)];
        accounts.extend(pool.desks.iter().map(|d| w(*d)));
        accounts.push(if recorded { w(pool.round_pda(n)) } else { r(PROGRAM) });
        accounts.push(w(ER_QUEUE));
        accounts.push(r(MAGIC_PROGRAM));
        accounts.push(r(pda(&[b"identity"]).0));
        accounts.push(r(VRF_PROGRAM));
        accounts.push(r(SLOT_HASHES));
        accounts.push(r(SYSTEM));
        Instruction { program_id: PROGRAM, accounts, data }
    }

    pub fn ix_tick(&self, pool: &Pool) -> Instruction {
        let mut accounts = vec![w(pool.table), w(pool.book)];
        accounts.extend(pool.desks.iter().map(|d| w(*d)));
        Instruction { program_id: PROGRAM, accounts, data: disc("tick").to_vec() }
    }

    pub fn ix_act(player: &Address, desk: &Address, book: &Address, kind: u8, level: u8, seq: u32, salt: [u8; 16]) -> Instruction {
        let mut data = disc("act").to_vec();
        data.push(kind);
        data.push(level);
        data.extend_from_slice(&seq.to_le_bytes());
        data.extend_from_slice(&salt);
        assert_eq!(data.len(), 30);
        Instruction { program_id: PROGRAM, accounts: vec![rs(*player), w(*desk), w(*book)], data }
    }

    pub fn ix_reveal(&self, pool: &Pool, round: Option<u64>) -> Instruction {
        let mut accounts = vec![ws(self.house.pubkey()), w(pool.table), w(pool.book)];
        accounts.push(match round {
            Some(n) => w(pool.round_pda(n)),
            None => r(PROGRAM),
        });
        accounts.push(w(MAGIC_CONTEXT));
        accounts.push(r(MAGIC_PROGRAM));
        Instruction { program_id: PROGRAM, accounts, data: disc("reveal").to_vec() }
    }

    pub fn ix_reschedule(&self, pool: &Pool) -> Instruction {
        let mut accounts = vec![ws(self.house.pubkey()), w(pool.table), w(pool.book)];
        accounts.extend(pool.desks.iter().map(|d| w(*d)));
        accounts.push(r(MAGIC_PROGRAM));
        accounts.push(r(SLOT_HASHES));
        Instruction { program_id: PROGRAM, accounts, data: disc("reschedule_crank").to_vec() }
    }

    pub fn ix_create_record(&self, pool: &Pool, n: u64) -> Instruction {
        let mut data = disc("create_record").to_vec();
        data.extend_from_slice(&pool.id.to_le_bytes());
        data.extend_from_slice(&n.to_le_bytes());
        data.extend_from_slice(&0i64.to_le_bytes());
        Instruction {
            program_id: PROGRAM,
            accounts: vec![ws(self.house.pubkey()), r(self.config), w(pool.ledger), w(pool.round_pda(n)), w(pool.tape_pda(n)), r(SYSTEM)],
            data,
        }
    }

    // ------------------------------------------------------------------ flows
    /// Creates, delegates and seals a pool and seats 8 bots. `round_before` overrides
    /// `Table.round` before delegation (to replay vectors with a given round number).
    pub fn pool(&mut self, id: u64, round_before: Option<u64>) -> Pool {
        let h = self.house_kp();
        self.ok(Base, &h, &[], &[self.ix_create_pool(id)], "create_pool");
        for i in 0..8u8 {
            self.ok(Base, &h, &[], &[self.ix_create_desk(id, i)], "create_desk");
        }
        let idb = id.to_le_bytes();
        let table = pda(&[b"table", &idb]).0;
        let book = pda(&[b"book", &idb]).0;
        let ledger = pda(&[b"ledger", &idb]).0;
        let desks: [Address; 8] = core::array::from_fn(|i| pda(&[b"desk", &idb, &[i as u8]]).0);
        if let Some(n) = round_before {
            let mut a = self.svm.get_account_for(Base, &table).unwrap();
            a.data[off::table::ROUND..off::table::ROUND + 8].copy_from_slice(&n.to_le_bytes());
            self.svm.set_account(table, a).unwrap();
        }
        for a in [table, book].iter().chain(desks.iter()) {
            self.svm.delegate_account(*a).unwrap();
        }
        let bots: Vec<Keypair> = (0..8).map(|_| Keypair::new()).collect();
        let mut pool = Pool { id, table, book, ledger, desks, bots, seq: [1; 8] };
        let ixs: Vec<Instruction> = std::iter::once(self.ix_setup_permissions(&pool, 0, 0))
            .chain(std::iter::once(self.ix_setup_permissions(&pool, 1, 0)))
            .collect();
        self.ok(Er, &h, &[], &ixs, "setup_permissions table+book");
        for s in 0..8u8 {
            let k = pool.bots[s as usize].pubkey();
            let ix = self.ix_join_bot(&pool, s, &k);
            self.ok(Er, &h, &[], &[ix], "join_bot");
        }
        // join_bot sets each desk's permission (and its sealed bit); seq starts at 1
        pool.seq = [1; 8];
        pool
    }

    pub fn reseal(&mut self, pool: &Pool) {
        let h = self.house_kp();
        let ix = self.ix_setup_permissions(pool, 1, 0);
        self.ok(Er, &h, &[], &[ix], "reseal book");
        for s in 0..8u64 {
            let ix = self.ix_setup_permissions(pool, 2, s);
            self.ok(Er, &h, &[], &[ix], "reseal desk");
        }
    }

    pub fn record(&mut self, pool: &Pool, n: u64) {
        let h = self.house_kp();
        let ix = self.ix_create_record(pool, n);
        self.ok(Base, &h, &[], &[ix], "create_record");
        self.svm.delegate_account(pool.round_pda(n)).unwrap();
    }

    pub fn open(&mut self, pool: &Pool, n: u64, recorded: bool) {
        let h = self.house_kp();
        let ix = self.ix_open_round(pool, n, recorded);
        self.ok(Er, &h, &[], &[ix], "open_round");
    }

    /// One act from desk `s`'s seated bot (seq advances). Returns CU.
    pub fn act(&mut self, pool: &mut Pool, s: usize, kind: u8, level: u8, salt: [u8; 16]) -> u64 {
        let seq = pool.seq[s];
        pool.seq[s] += 1;
        let kp = pool.bots[s].insecure_clone();
        let ix = Env::ix_act(&kp.pubkey(), &pool.desks[s], &pool.book, kind, level, seq, salt);
        self.ok(Er, &kp, &[], &[ix], "act")
    }

    /// Any act (signer, seq chosen by the caller). Must never fail.
    pub fn act_raw(&mut self, signer: &Keypair, desk: &Address, book: &Address, kind: u8, level: u8, seq: u32, salt: [u8; 16]) -> u64 {
        let ix = Env::ix_act(&signer.pubkey(), desk, book, kind, level, seq, salt);
        self.ok(Er, signer, &[], &[ix], "act")
    }

    /// A tick sent by a fresh fee payer (the CU limit varies so the txs are distinct).
    pub fn tick(&mut self, pool: &Pool) -> u64 {
        self.nonce += 1;
        let h = self.house_kp();
        let mut cu = vec![2u8];
        cu.extend_from_slice(&(400_000u32 - (self.nonce % 997) as u32).to_le_bytes());
        let budget = Instruction { program_id: Address::from_str_const("ComputeBudget111111111111111111111111111111"), accounts: vec![], data: cu };
        let ix = self.ix_tick(pool);
        self.ok(Er, &h, &[], &[budget, ix], "tick")
    }

    /// Advances one slot at a time to `slot`, running due cranks and VRF fulfils; returns
    /// (crank tick CU, resolved?) per crank execution and panics on any failed one.
    pub fn warp(&mut self, pool: &Pool, slot: u64) -> Vec<(u64, bool, u8)> {
        let mut out = Vec::new();
        let mut s = self.slot();
        while s < slot {
            s += 1;
            let before = u64_at(&self.er(&pool.table), off::table::RESOLVES);
            let phase_before = self.er(&pool.table)[off::table::PHASE];
            let res = self.svm.warp_to_slot(s);
            let after = u64_at(&self.er(&pool.table), off::table::RESOLVES);
            let mut cranks = 0;
            for r in &res {
                match r {
                    Ok(meta) => {
                        let is_vrf = meta.logs.iter().any(|l| l.contains(&VRF_PROGRAM.to_string()));
                        if !is_vrf {
                            cranks += 1;
                            out.push((meta.compute_units_consumed, after > before, phase_before));
                        }
                    }
                    Err(f) => panic!("crank/vrf failed at slot {s}: {:?}\n{:#?}", f.err, f.meta.logs),
                }
            }
            assert!(cranks <= 1 || after == before, "two crank ticks in one slot with a resolve");
        }
        out
    }

    /// Warps until the crank resolves the deadline at `deadline` (at most one crank interval
    /// later); returns the crank results seen on the way.
    pub fn warp_resolve(&mut self, pool: &Pool, deadline: u64) -> Vec<(u64, bool, u8)> {
        let start = u64_at(&self.er(&pool.table), off::table::RESOLVES);
        let mut all = self.warp(pool, deadline);
        let mut s = deadline;
        while u64_at(&self.er(&pool.table), off::table::RESOLVES) == start {
            assert!(s < deadline + 10, "deadline {deadline} not resolved by the crank");
            s += 1;
            all.extend(self.warp(pool, s));
        }
        all
    }

    pub fn reveal(&mut self, pool: &Pool, round: Option<u64>) {
        let h = self.house_kp();
        let ix = self.ix_reveal(pool, round);
        self.ok(Er, &h, &[], &[ix], "reveal");
    }

    pub fn unseal_all(&mut self, pool: &Pool) {
        let h = self.house_kp();
        let ix = self.ix_unseal(pool, 1, 0);
        self.ok(Er, &h, &[], &[ix], "unseal book");
        for s in 0..8 {
            let ix = self.ix_unseal(pool, 2, s);
            self.ok(Er, &h, &[], &[ix], "unseal desk");
        }
    }
}

/// splitmix64
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
    pub fn salt(&mut self) -> [u8; 16] {
        core::array::from_fn(|_| self.next() as u8)
    }
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
pub fn unhex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

/// Per-class CU tally: class -> sorted distinct values with counts.
#[derive(Default)]
pub struct Cu(pub std::collections::BTreeMap<String, std::collections::BTreeMap<u64, u64>>);
impl Cu {
    pub fn add(&mut self, class: &str, cu: u64) {
        *self.0.entry(class.to_string()).or_default().entry(cu).or_default() += 1;
    }
    pub fn report(&self) -> String {
        let mut s = String::new();
        for (k, v) in &self.0 {
            let n: u64 = v.values().sum();
            let min = v.keys().next().unwrap();
            let max = v.keys().last().unwrap();
            s += &format!("{k}: n={n} min={min} max={max} max-min={} values={:?}\n", max - min, v);
        }
        s
    }
    pub fn assert_constant(&self) {
        for (k, v) in &self.0 {
            assert_eq!(v.len(), 1, "CU class {k} is not constant: {v:?}\n{}", self.report());
        }
    }
}
