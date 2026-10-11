//! Cross-lender device registry: the GPU chip id in a covenant proof can back one loan at a time.
//! Both fixture proofs (tests/fixtures/covenant-strong*.json) use NVIDIA's same sample H100 report,
//! so they carry the same chip id; two lenders opening loans with the terms those proofs were made
//! for stand in for one operator pledging the same card twice.

mod common;

use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{
            instruction::{AccountMeta, Instruction},
            system_program,
        },
    },
    common::{boot_with, default_params, hex, keccak, pda, Harness},
    pct_oracle::{
        instructions::{Device, LoanTerms, ZkCovenant, ZK_NONE, ZK_PASS, ZK_WATCH},
        SourceArgs,
    },
    serde_json::Value,
    solana_keypair::Keypair,
    solana_signer::Signer,
};

const SOL: u64 = 1_000_000_000;
const STRONG: &str = include_str!("fixtures/covenant-strong-groth16.json");
const WATCH: &str = include_str!("fixtures/covenant-strong-watch114-groth16.json");
/// Debt service each fixture proof was made for (see tests/zk.rs).
const STRONG_DEBT: u64 = 120_000_000_000;
const WATCH_DEBT: u64 = 142_500_000_000;

fn json(s: &str) -> Value {
    serde_json::from_str(s).unwrap()
}

fn field(v: &Value, k: &str) -> Vec<u8> {
    hex(v[k].as_str().unwrap())
}

fn compute_limit(units: u32) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&units.to_le_bytes());
    Instruction::new_with_bytes("ComputeBudget111111111111111111111111111111".parse().unwrap(), &data, vec![])
}

struct Lender {
    kp: Keypair,
    loan: Pubkey,
}

struct World {
    h: Harness,
    source_id: [u8; 32],
    as_of: u32,
    /// Lender A is the harness payer (also the config authority); B is an unrelated lender.
    a: Lender,
    b: Lender,
}

fn chip_id(proof: &Value) -> [u8; 32] {
    field(proof, "journal")[..32].try_into().unwrap()
}

fn device_pda(proof: &Value) -> Pubkey {
    pda(&[b"device", &chip_id(proof)])
}

/// Config, Razorpay source and zk config as in tests/zk.rs; lender A's loan has the terms of the
/// strong proof, lender B's those of `b_debt` (STRONG_DEBT or WATCH_DEBT).
fn world(enforce: bool, b_debt: u64) -> World {
    let fx = json(include_str!("fixtures/zk-revenue-claims.json"));
    let t = fx["terms"].clone();
    let as_of = t["as_of_period"].as_u64().unwrap() as u32;
    let period_s = t["period_s"].as_u64().unwrap();
    let attestors: Vec<[u8; 20]> =
        fx["attestors"]["attestors"].as_array().unwrap().iter().map(|a| hex(a.as_str().unwrap()).try_into().unwrap()).collect();
    let mut h = boot_with(attestors, default_params(), (as_of as u64 * period_s + 2 * 86_400) as i64);
    let payer = h.payer.pubkey();
    let source_id = keccak(b"razorpay-zk");
    let args = SourceArgs {
        source_id,
        params_hash: hex(fx["paramsHash"].as_str().unwrap()).try_into().unwrap(),
        provider_id: 7,
        sku: 0,
        kind: 2,
        gpu_count: 1,
        value_mode: 1,
        requires_nullifier: true,
    };
    let image_id: [u8; 32] = field(&json(STRONG), "imageId").try_into().unwrap();
    let mut ixs = vec![
        Harness::ix(
            pct_oracle::instruction::RegisterSource { args },
            pct_oracle::accounts::RegisterSource {
                authority: payer,
                config: pda(&[b"config"]),
                source: pda(&[b"source", &source_id]),
                system_program: system_program::ID,
            },
        ),
        Harness::ix(
            pct_oracle::instruction::SetZkConfig { image_id, attestor_threshold: 2, require_vm_bound: false, vm_measurement: [0u8; 32] },
            pct_oracle::accounts::SetZkConfig {
                authority: payer,
                config: pda(&[b"config"]),
                zk_config: pda(&[b"zk_config"]),
                system_program: system_program::ID,
            },
        ),
    ];
    if enforce {
        ixs.push(set_registry_ix(payer, true));
    }
    h.send(&ixs).unwrap();

    let operator_key: [u8; 32] = hex(t["operator_key"].as_str().unwrap()).try_into().unwrap();
    let terms = |debt_service_micro: u64| LoanTerms {
        operator_key,
        borrower: Pubkey::new_unique(),
        sku: 0,
        fleet_gpus: 1,
        period_s: period_s as u32,
        debt_service_micro,
        min_coverage_bps: t["min_coverage_bps"].as_u64().unwrap() as u16,
        currency: *b"INR",
        covenant_periods: t["covenant_periods"].as_u64().unwrap() as u8,
    };
    let a_kp = h.payer.insecure_clone();
    let b_kp = Keypair::new();
    h.svm.airdrop(&b_kp.pubkey(), 10 * SOL).unwrap();
    let open = |h: &mut Harness, kp: Keypair, debt: u64| -> Lender {
        let loan = pda(&[b"loan", kp.pubkey().as_ref(), &operator_key]);
        let ix = Harness::ix(
            pct_oracle::instruction::OpenLoan { terms: terms(debt) },
            pct_oracle::accounts::OpenLoan { lender: kp.pubkey(), loan, system_program: system_program::ID },
        );
        h.send_as(&[ix], &kp).unwrap();
        Lender { kp, loan }
    };
    let a = open(&mut h, a_kp, STRONG_DEBT);
    let b = open(&mut h, b_kp, b_debt);
    World { h, source_id, as_of, a, b }
}

fn set_registry_ix(authority: Pubkey, enforce: bool) -> Instruction {
    Harness::ix(
        pct_oracle::instruction::SetDeviceRegistry { enforce },
        pct_oracle::accounts::SetDeviceRegistry { authority, config: pda(&[b"config"]), zk_config: pda(&[b"zk_config"]) },
    )
}

#[derive(Clone, Copy)]
enum Who {
    A,
    B,
}

impl World {
    fn lender(&self, who: Who) -> &Lender {
        match who {
            Who::A => &self.a,
            Who::B => &self.b,
        }
    }

    /// The loan's lender issues the nonce the sample report signed, then the payer submits the
    /// proof, passing `device` as remaining account (or none).
    fn prove_with(&mut self, who: Who, proof: &str, device: Option<AccountMeta>) -> Result<u64, String> {
        let proof = json(proof);
        let journal = field(&proof, "journal");
        let nonce: [u8; 32] = journal[32..64].try_into().unwrap();
        let (loan, lender) = (self.lender(who).loan, self.lender(who).kp.insecure_clone());
        let covenant = pda(&[b"zk_covenant", loan.as_ref()]);
        let challenge = Harness::ix(
            pct_oracle::instruction::IssueGpuChallenge { challenge: nonce },
            pct_oracle::accounts::IssueGpuChallenge { lender: lender.pubkey(), loan, zk_covenant: covenant, system_program: system_program::ID },
        );
        self.h.send_as(&[challenge], &lender).unwrap();
        let mut ix = Harness::ix(
            pct_oracle::instruction::ProveCovenant { seal: field(&proof, "seal"), public_values: journal, as_of_period: self.as_of },
            pct_oracle::accounts::ProveCovenant {
                submitter: self.h.payer.pubkey(),
                config: pda(&[b"config"]),
                zk_config: pda(&[b"zk_config"]),
                source: pda(&[b"source", &self.source_id]),
                loan,
                zk_covenant: covenant,
                treasury: pda(&[b"treasury"]),
                system_program: system_program::ID,
            },
        );
        ix.accounts.extend(device);
        self.h.send(&[compute_limit(1_400_000), ix])
    }

    fn prove(&mut self, who: Who, proof: &str) -> Result<u64, String> {
        let device = AccountMeta::new(device_pda(&json(proof)), false);
        self.prove_with(who, proof, Some(device))
    }

    fn status(&self, who: Who) -> u8 {
        self.h.account::<ZkCovenant>(&pda(&[b"zk_covenant", self.lender(who).loan.as_ref()])).status
    }

    fn device(&self) -> Device {
        self.h.account(&device_pda(&json(STRONG)))
    }

    fn release(&mut self, by: Who) -> Result<u64, String> {
        let kp = self.lender(by).kp.insecure_clone();
        let ix = Harness::ix(
            pct_oracle::instruction::ReleaseDevice {},
            pct_oracle::accounts::ReleaseDevice { lender: kp.pubkey(), device: device_pda(&json(STRONG)) },
        );
        self.h.send_as(&[ix], &kp)
    }
}

#[test]
fn fixture_proofs_share_one_chip_id() {
    assert_eq!(chip_id(&json(STRONG)), chip_id(&json(WATCH)));
}

#[test]
fn same_gpu_is_refused_for_a_second_lenders_loan() {
    let mut w = world(true, STRONG_DEBT);
    let cu = w.prove(Who::A, STRONG).unwrap();
    println!("prove_covenant with device registry (first bind): {cu} CU");
    let d = w.device();
    assert_eq!((d.chip_id, d.loan, d.lender, d.bound_period), (chip_id(&json(STRONG)), w.a.loan, w.a.kp.pubkey(), w.as_of));
    assert_eq!(d.first_seen_period, w.as_of);
    assert_eq!(w.status(Who::A), ZK_PASS);

    // Re-proving the same loan is fine.
    w.prove(Who::A, STRONG).unwrap();

    // Lender B, same proof, same card: refused, and B's covenant stays unproven.
    assert!(w.prove(Who::B, STRONG).unwrap_err().contains("DevicePledgedElsewhere"));
    assert_eq!(w.status(Who::B), ZK_NONE);
    assert_eq!(w.device().loan, w.a.loan);
}

#[test]
fn a_different_proof_of_the_same_gpu_is_refused_too() {
    // B's loan matches the WATCH proof's terms: a separate proof, same chip.
    let mut w = world(true, WATCH_DEBT);
    w.prove(Who::A, STRONG).unwrap();
    assert!(w.prove(Who::B, WATCH).unwrap_err().contains("DevicePledgedElsewhere"));
}

#[test]
fn release_by_the_bound_lender_lets_the_gpu_be_pledged_again() {
    let mut w = world(true, WATCH_DEBT);
    w.prove(Who::A, STRONG).unwrap();
    assert!(w.release(Who::B).unwrap_err().contains("NotLender"), "only the bound loan's lender releases");
    w.release(Who::A).unwrap();
    let d = w.device();
    assert_eq!((d.loan, d.lender), (Pubkey::default(), Pubkey::default()));

    w.prove(Who::B, WATCH).unwrap();
    assert_eq!(w.status(Who::B), ZK_WATCH);
    let d = w.device();
    assert_eq!((d.loan, d.lender), (w.b.loan, w.b.kp.pubkey()));
    assert!(w.prove(Who::A, STRONG).unwrap_err().contains("DevicePledgedElsewhere"), "now A is the second pledge");
    assert!(w.release(Who::A).unwrap_err().contains("NotLender"));
}

#[test]
fn with_the_registry_off_nothing_changes() {
    let mut w = world(false, STRONG_DEBT);
    w.prove_with(Who::A, STRONG, None).unwrap();
    w.prove_with(Who::B, STRONG, None).unwrap();
    assert_eq!((w.status(Who::A), w.status(Who::B)), (ZK_PASS, ZK_PASS));
    assert!(w.h.svm.get_account(&device_pda(&json(STRONG))).is_none_or(|a| a.lamports == 0));
}

#[test]
fn enforced_registry_needs_the_right_device_account() {
    let mut w = world(true, STRONG_DEBT);
    assert!(w.prove_with(Who::A, STRONG, None).unwrap_err().contains("BadDeviceAccount"));
    let wrong = AccountMeta::new(pda(&[b"device", &[1u8; 32]]), false);
    assert!(w.prove_with(Who::A, STRONG, Some(wrong)).unwrap_err().contains("BadDeviceAccount"));
    let read_only = AccountMeta::new_readonly(device_pda(&json(STRONG)), false);
    assert!(w.prove_with(Who::A, STRONG, Some(read_only)).unwrap_err().contains("BadDeviceAccount"));
    assert_eq!(w.status(Who::A), ZK_NONE);
}

#[test]
fn prefunding_the_device_address_does_not_block_the_first_pledge() {
    let mut w = world(true, STRONG_DEBT);
    w.h.svm.airdrop(&device_pda(&json(STRONG)), 1).unwrap();
    w.prove(Who::A, STRONG).unwrap();
    assert_eq!(w.device().loan, w.a.loan);
}

#[test]
fn only_the_authority_toggles_the_registry() {
    let mut w = world(false, STRONG_DEBT);
    let kp = w.b.kp.insecure_clone();
    assert!(w.h.send_as(&[set_registry_ix(kp.pubkey(), true)], &kp).unwrap_err().contains("Unauthorized"));
    let payer = w.h.payer.pubkey();
    w.h.send(&[set_registry_ix(payer, true)]).unwrap();
    w.prove(Who::A, STRONG).unwrap();
    assert!(w.prove(Who::B, STRONG).unwrap_err().contains("DevicePledgedElsewhere"));
}
