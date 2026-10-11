//! Cross-lender device registry: the GPU chip id in a covenant proof can back one loan at a time,
//! and a challenge nonce belongs to the one loan that claimed it.
//! Both fixture proofs (tests/fixtures/covenant-strong*.json) use NVIDIA's same sample H100 report,
//! so they carry the same chip id and the same nonce; two lenders opening loans with the terms those
//! proofs were made for stand in for one operator pledging the same card twice, or for an attacker
//! copying a victim's terms to replay the victim's proof.

mod common;

use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{
            instruction::{AccountMeta, Instruction},
            system_program,
        },
        AccountDeserialize, AccountSerialize,
    },
    common::{boot_with, default_params, hex, keccak, pda, Harness},
    pct_oracle::{
        instructions::{Device, LoanTerms, NonceClaim, RegistryConfig, ZkCovenant, ZK_NONE, ZK_PASS, ZK_WATCH},
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
    borrower: Keypair,
    loan: Pubkey,
}

struct World {
    h: Harness,
    source_id: [u8; 32],
    as_of: u32,
    /// The harness payer is the config authority and submits proofs; A and B are unrelated lenders.
    a: Lender,
    b: Lender,
}

fn chip_id(proof: &str) -> [u8; 32] {
    field(&json(proof), "journal")[..32].try_into().unwrap()
}

fn nonce(proof: &str) -> [u8; 32] {
    field(&json(proof), "journal")[32..64].try_into().unwrap()
}

fn device_pda(proof: &str) -> Pubkey {
    pda(&[b"device", &chip_id(proof)])
}

fn claim_pda(nonce: &[u8; 32]) -> Pubkey {
    pda(&[b"nonce", nonce])
}

fn registry_config() -> Pubkey {
    pda(&[b"registry_config"])
}

/// Remaining accounts of prove_covenant while the registry is enforced.
fn registry_metas(proof: &str) -> Vec<AccountMeta> {
    vec![
        AccountMeta::new_readonly(registry_config(), false),
        AccountMeta::new(device_pda(proof), false),
        AccountMeta::new_readonly(claim_pda(&nonce(proof)), false),
    ]
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
    let terms = |debt_service_micro: u64, borrower: Pubkey| LoanTerms {
        operator_key,
        borrower,
        sku: 0,
        fleet_gpus: 1,
        period_s: period_s as u32,
        debt_service_micro,
        min_coverage_bps: t["min_coverage_bps"].as_u64().unwrap() as u16,
        currency: *b"INR",
        covenant_periods: t["covenant_periods"].as_u64().unwrap() as u8,
    };
    let open = |h: &mut Harness, debt: u64| -> Lender {
        let (kp, borrower) = (Keypair::new(), Keypair::new());
        h.svm.airdrop(&kp.pubkey(), 10 * SOL).unwrap();
        h.svm.airdrop(&borrower.pubkey(), SOL).unwrap();
        let loan = pda(&[b"loan", kp.pubkey().as_ref(), &operator_key]);
        let ix = Harness::ix(
            pct_oracle::instruction::OpenLoan { terms: terms(debt, borrower.pubkey()) },
            pct_oracle::accounts::OpenLoan { lender: kp.pubkey(), loan, system_program: system_program::ID },
        );
        h.send_as(&[ix], &kp).unwrap();
        Lender { kp, borrower, loan }
    };
    let a = open(&mut h, STRONG_DEBT);
    let b = open(&mut h, b_debt);
    World { h, source_id, as_of, a, b }
}

fn set_registry_ix(authority: Pubkey, enforce: bool) -> Instruction {
    Harness::ix(
        pct_oracle::instruction::SetDeviceRegistry { enforce },
        pct_oracle::accounts::SetDeviceRegistry {
            authority,
            config: pda(&[b"config"]),
            registry_config: registry_config(),
            system_program: system_program::ID,
        },
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

    /// The loan's lender issues the nonce the sample report signed, claiming it when `claim`.
    fn challenge(&mut self, who: Who, claim: bool) -> Result<u64, String> {
        let n = nonce(STRONG);
        let (loan, lender) = (self.lender(who).loan, self.lender(who).kp.insecure_clone());
        let mut ix = Harness::ix(
            pct_oracle::instruction::IssueGpuChallenge { challenge: n },
            pct_oracle::accounts::IssueGpuChallenge {
                lender: lender.pubkey(),
                loan,
                zk_covenant: pda(&[b"zk_covenant", loan.as_ref()]),
                system_program: system_program::ID,
            },
        );
        if claim {
            ix.accounts.push(AccountMeta::new(claim_pda(&n), false));
        }
        self.h.send_as(&[ix], &lender)
    }

    /// The payer submits `proof` for `who`'s loan with exactly `remaining` as remaining accounts.
    fn submit(&mut self, who: Who, proof: &str, remaining: Vec<AccountMeta>) -> Result<u64, String> {
        let p = json(proof);
        let loan = self.lender(who).loan;
        let mut ix = Harness::ix(
            pct_oracle::instruction::ProveCovenant { seal: field(&p, "seal"), public_values: field(&p, "journal"), as_of_period: self.as_of },
            pct_oracle::accounts::ProveCovenant {
                submitter: self.h.payer.pubkey(),
                config: pda(&[b"config"]),
                zk_config: pda(&[b"zk_config"]),
                source: pda(&[b"source", &self.source_id]),
                loan,
                zk_covenant: pda(&[b"zk_covenant", loan.as_ref()]),
                treasury: pda(&[b"treasury"]),
                system_program: system_program::ID,
            },
        );
        ix.accounts.extend(remaining);
        self.h.send(&[compute_limit(1_400_000), ix])
    }

    /// The honest path: challenge with a nonce claim, then prove with the registry accounts.
    fn prove(&mut self, who: Who, proof: &str) -> Result<u64, String> {
        self.challenge(who, true)?;
        self.submit(who, proof, registry_metas(proof))
    }

    /// The attacker's path: B issues the victim's nonce without claiming it and replays `proof`.
    fn replay(&mut self, who: Who, proof: &str) -> Result<u64, String> {
        self.challenge(who, false).unwrap();
        self.submit(who, proof, registry_metas(proof))
    }

    fn status(&self, who: Who) -> u8 {
        self.h.account::<ZkCovenant>(&pda(&[b"zk_covenant", self.lender(who).loan.as_ref()])).status
    }

    fn device(&self) -> Device {
        self.h.account(&device_pda(STRONG))
    }

    fn claim(&self) -> NonceClaim {
        self.h.account(&claim_pda(&nonce(STRONG)))
    }

    /// `by` releases the GPU, naming `loan` as the loan it is bound to.
    fn release(&mut self, by: &Keypair, loan: Pubkey) -> Result<u64, String> {
        let ix = Harness::ix(
            pct_oracle::instruction::ReleaseDevice {},
            pct_oracle::accounts::ReleaseDevice {
                releaser: by.pubkey(),
                config: pda(&[b"config"]),
                device: device_pda(STRONG),
                loan,
                zk_covenant: pda(&[b"zk_covenant", loan.as_ref()]),
            },
        );
        self.h.send_as(&[ix], by)
    }

    fn release_by_lender(&mut self, who: Who) -> Result<u64, String> {
        let kp = self.lender(who).kp.insecure_clone();
        let loan = self.device().loan;
        self.release(&kp, loan)
    }
}

#[test]
fn fixture_proofs_share_one_chip_id_and_one_nonce() {
    assert_eq!(chip_id(STRONG), chip_id(WATCH));
    assert_eq!(nonce(STRONG), nonce(WATCH));
}

#[test]
fn same_gpu_is_refused_for_a_second_lenders_loan() {
    let mut w = world(true, STRONG_DEBT);
    let cu = w.prove(Who::A, STRONG).unwrap();
    println!("prove_covenant with device registry (first bind + nonce claim check): {cu} CU");
    let d = w.device();
    assert_eq!((d.chip_id, d.loan, d.lender, d.bound_period), (chip_id(STRONG), w.a.loan, w.a.kp.pubkey(), w.as_of));
    assert_eq!(d.first_seen_period, w.as_of);
    assert_eq!(w.status(Who::A), ZK_PASS);

    // Re-proving the same loan is fine (same nonce, already claimed by A).
    let cu = w.prove(Who::A, STRONG).unwrap();
    println!("prove_covenant with device registry (already bound): {cu} CU");

    // Lender B, same proof, same card: refused, and B's covenant stays unproven.
    assert!(w.replay(Who::B, STRONG).unwrap_err().contains("DevicePledgedElsewhere"));
    assert_eq!(w.status(Who::B), ZK_NONE);
    assert_eq!(w.device().loan, w.a.loan);
}

#[test]
fn a_different_proof_of_the_same_gpu_is_refused_too() {
    // B's loan matches the WATCH proof's terms: a separate proof, same chip.
    let mut w = world(true, WATCH_DEBT);
    w.prove(Who::A, STRONG).unwrap();
    assert!(w.replay(Who::B, WATCH).unwrap_err().contains("DevicePledgedElsewhere"));
}

#[test]
fn lender_b_cannot_claim_lender_as_nonce() {
    let mut w = world(true, STRONG_DEBT);
    w.challenge(Who::A, true).unwrap();
    let claim = w.claim();
    assert_eq!((claim.nonce, claim.loan), (nonce(STRONG), w.a.loan));

    assert!(w.challenge(Who::B, true).unwrap_err().contains("NonceTaken"));
    assert_eq!(w.claim().loan, w.a.loan);
    // B's loan never got the challenge either: the whole instruction failed.
    assert!(w.h.svm.get_account(&pda(&[b"zk_covenant", w.b.loan.as_ref()])).is_none_or(|a| a.lamports == 0));

    // A re-issuing its own nonce is fine.
    w.challenge(Who::A, true).unwrap();
}

#[test]
fn replaying_as_proof_after_release_is_refused_but_as_own_reproof_works() {
    // B's terms match the strong proof too: B is an attacker copying A's terms.
    let mut w = world(true, STRONG_DEBT);
    w.prove(Who::A, STRONG).unwrap();
    w.release_by_lender(Who::A).unwrap();
    assert_eq!(w.device().loan, Pubkey::default());
    assert_eq!(w.status(Who::A), ZK_NONE);

    // B issues A's nonce (unclaimed, since claiming it fails) and replays A's proof: refused.
    assert!(w.replay(Who::B, STRONG).unwrap_err().contains("NonceTaken"));
    assert!(w.challenge(Who::B, true).unwrap_err().contains("NonceTaken"));
    assert_eq!(w.status(Who::B), ZK_NONE);
    assert_eq!(w.device().loan, Pubkey::default(), "the released GPU is not squatted");

    // A's own re-proof with its nonce still binds the GPU back to A.
    w.prove(Who::A, STRONG).unwrap();
    assert_eq!(w.status(Who::A), ZK_PASS);
    assert_eq!((w.device().loan, w.device().lender), (w.a.loan, w.a.kp.pubkey()));
}

#[test]
fn a_fresh_nonce_lets_another_loan_bind_the_released_gpu() {
    let mut w = world(true, WATCH_DEBT);
    w.prove(Who::A, STRONG).unwrap();
    w.release_by_lender(Who::A).unwrap();

    // The fixtures share one nonce, so stand in for "B claimed a fresh nonce its operator's GPU
    // then signed" by moving the claim to B's loan directly in the ledger.
    let address = claim_pda(&nonce(STRONG));
    let mut account = w.h.svm.get_account(&address).unwrap();
    let mut claim = NonceClaim::try_deserialize(&mut account.data.as_slice()).unwrap();
    claim.loan = w.b.loan;
    let mut data = Vec::new();
    claim.try_serialize(&mut data).unwrap();
    account.data = data;
    w.h.svm.set_account(address, account).unwrap();

    w.challenge(Who::B, true).unwrap();
    w.submit(Who::B, WATCH, registry_metas(WATCH)).unwrap();
    assert_eq!(w.status(Who::B), ZK_WATCH);
    assert_eq!((w.device().loan, w.device().lender), (w.b.loan, w.b.kp.pubkey()));
    assert!(w.replay(Who::A, STRONG).unwrap_err().contains("DevicePledgedElsewhere"), "now A is the second pledge");
}

#[test]
fn release_by_lender_borrower_or_authority_only() {
    let mut w = world(true, STRONG_DEBT);
    w.prove(Who::A, STRONG).unwrap();

    let stranger = w.b.kp.insecure_clone();
    assert!(w.release(&stranger, w.a.loan).unwrap_err().contains("CannotReleaseDevice"));
    let b_borrower = w.b.borrower.insecure_clone();
    assert!(w.release(&b_borrower, w.a.loan).unwrap_err().contains("CannotReleaseDevice"));
    // Naming B's loan (whose borrower B controls) instead of the bound loan does not help.
    w.challenge(Who::B, false).unwrap();
    assert!(w.release(&b_borrower, w.b.loan).unwrap_err().contains("BadDeviceAccount"));

    // The bound loan's borrower can release; the loan's covenant then drops to NONE, so the borrower
    // cannot pledge the GPU elsewhere and keep drawing on this loan's old PASS.
    let a_borrower = w.a.borrower.insecure_clone();
    assert_eq!(w.status(Who::A), ZK_PASS);
    w.release(&a_borrower, w.a.loan).unwrap();
    assert_eq!((w.device().loan, w.device().lender), (Pubkey::default(), Pubkey::default()));
    assert_eq!(w.status(Who::A), ZK_NONE);
    assert!(w.release(&a_borrower, w.a.loan).unwrap_err().contains("DeviceNotPledged"));

    // The config authority can release too (recovery), and the lender as before.
    w.prove(Who::A, STRONG).unwrap();
    let authority = w.h.payer.insecure_clone();
    w.release(&authority, w.a.loan).unwrap();
    assert_eq!(w.device().loan, Pubkey::default());
    w.prove(Who::A, STRONG).unwrap();
    w.release_by_lender(Who::A).unwrap();
    assert_eq!(w.device().loan, Pubkey::default());
}

#[test]
fn with_the_registry_off_nothing_changes() {
    let mut w = world(false, STRONG_DEBT);
    let reg = || vec![AccountMeta::new_readonly(registry_config(), false)];
    w.challenge(Who::A, false).unwrap();
    w.submit(Who::A, STRONG, reg()).unwrap();
    w.challenge(Who::B, false).unwrap();
    w.submit(Who::B, STRONG, reg()).unwrap();
    assert_eq!((w.status(Who::A), w.status(Who::B)), (ZK_PASS, ZK_PASS));
    assert!(w.h.svm.get_account(&device_pda(STRONG)).is_none_or(|a| a.lamports == 0));
    assert!(w.h.svm.get_account(&claim_pda(&nonce(STRONG))).is_none_or(|a| a.lamports == 0));

    // Turned on and off again: off, with the config account now initialised.
    let payer = w.h.payer.pubkey();
    w.h.send(&[set_registry_ix(payer, true), set_registry_ix(payer, false)]).unwrap();
    assert!(!w.h.account::<RegistryConfig>(&registry_config()).enforce);
    w.challenge(Who::A, false).unwrap();
    w.submit(Who::A, STRONG, reg()).unwrap();
}

#[test]
fn the_registry_config_cannot_be_omitted_or_swapped() {
    for enforce in [true, false] {
        let mut w = world(enforce, STRONG_DEBT);
        w.challenge(Who::A, true).unwrap();
        let mut shifted = registry_metas(STRONG);
        shifted.remove(0);
        let others = [
            vec![],
            shifted,
            vec![AccountMeta::new_readonly(Pubkey::new_unique(), false)],
            // Program-owned, but not the RegistryConfig PDA.
            vec![AccountMeta::new_readonly(pda(&[b"zk_config"]), false)],
            vec![AccountMeta::new_readonly(claim_pda(&nonce(STRONG)), false)],
        ];
        for remaining in others {
            let err = w.submit(Who::A, STRONG, remaining).unwrap_err();
            assert!(err.contains("BadRegistryConfig"), "enforce={enforce}: {err}");
        }
        assert_eq!(w.status(Who::A), ZK_NONE);
        w.submit(Who::A, STRONG, registry_metas(STRONG)).unwrap();
        assert_eq!(w.status(Who::A), ZK_PASS);
        assert_eq!(w.h.svm.get_account(&device_pda(STRONG)).is_some_and(|a| a.lamports > 0), enforce);
    }
}

#[test]
fn enforced_registry_needs_the_right_device_account() {
    let mut w = world(true, STRONG_DEBT);
    w.challenge(Who::A, true).unwrap();
    let reg = AccountMeta::new_readonly(registry_config(), false);
    let claim = AccountMeta::new_readonly(claim_pda(&nonce(STRONG)), false);
    assert!(w.submit(Who::A, STRONG, vec![reg.clone()]).unwrap_err().contains("BadDeviceAccount"));
    let wrong = AccountMeta::new(pda(&[b"device", &[1u8; 32]]), false);
    assert!(w.submit(Who::A, STRONG, vec![reg.clone(), wrong, claim.clone()]).unwrap_err().contains("BadDeviceAccount"));
    let read_only = AccountMeta::new_readonly(device_pda(STRONG), false);
    assert!(w.submit(Who::A, STRONG, vec![reg.clone(), read_only, claim.clone()]).unwrap_err().contains("BadDeviceAccount"));
    // The nonce claim (program-owned) passed where the device goes.
    let swapped = AccountMeta::new(claim_pda(&nonce(STRONG)), false);
    assert!(w.submit(Who::A, STRONG, vec![reg, swapped, claim]).unwrap_err().contains("BadDeviceAccount"));
    assert_eq!(w.status(Who::A), ZK_NONE);
}

#[test]
fn enforced_registry_needs_this_loans_nonce_claim() {
    let mut w = world(true, STRONG_DEBT);
    // Challenge issued without claiming the nonce: the proof cannot bind.
    w.challenge(Who::A, false).unwrap();
    let mut metas = registry_metas(STRONG);
    metas.pop();
    assert!(w.submit(Who::A, STRONG, metas.clone()).unwrap_err().contains("BadNonceClaim"));
    assert!(w.submit(Who::A, STRONG, registry_metas(STRONG)).unwrap_err().contains("BadNonceClaim"), "unclaimed nonce");
    // A claim for another nonce, or a non-claim account, does not stand in.
    w.challenge(Who::A, true).unwrap();
    let other = [7u8; 32];
    let b_lender = w.b.kp.insecure_clone();
    let ix = {
        let mut ix = Harness::ix(
            pct_oracle::instruction::IssueGpuChallenge { challenge: other },
            pct_oracle::accounts::IssueGpuChallenge {
                lender: b_lender.pubkey(),
                loan: w.b.loan,
                zk_covenant: pda(&[b"zk_covenant", w.b.loan.as_ref()]),
                system_program: system_program::ID,
            },
        );
        ix.accounts.push(AccountMeta::new(claim_pda(&other), false));
        ix
    };
    w.h.send_as(&[ix], &b_lender).unwrap();
    for wrong in [claim_pda(&other), device_pda(STRONG), pda(&[b"zk_config"])] {
        let mut m = metas.clone();
        m.push(AccountMeta::new_readonly(wrong, false));
        assert!(w.submit(Who::A, STRONG, m).unwrap_err().contains("BadNonceClaim"));
    }
    assert_eq!(w.status(Who::A), ZK_NONE);
    w.submit(Who::A, STRONG, registry_metas(STRONG)).unwrap();
    assert_eq!(w.status(Who::A), ZK_PASS);
}

#[test]
fn a_wrong_or_read_only_claim_account_is_refused_at_issue() {
    let mut w = world(true, STRONG_DEBT);
    let n = nonce(STRONG);
    let lender = w.a.kp.insecure_clone();
    let issue = |claim: AccountMeta| {
        let mut ix = Harness::ix(
            pct_oracle::instruction::IssueGpuChallenge { challenge: n },
            pct_oracle::accounts::IssueGpuChallenge {
                lender: lender.pubkey(),
                loan: w.a.loan,
                zk_covenant: pda(&[b"zk_covenant", w.a.loan.as_ref()]),
                system_program: system_program::ID,
            },
        );
        ix.accounts.push(claim);
        ix
    };
    let wrong = issue(AccountMeta::new(claim_pda(&[9u8; 32]), false));
    assert!(w.h.send_as(&[wrong], &lender).unwrap_err().contains("BadNonceClaim"));
    let read_only = issue(AccountMeta::new_readonly(claim_pda(&n), false));
    assert!(w.h.send_as(&[read_only], &lender).unwrap_err().contains("BadNonceClaim"));
}

#[test]
fn prefunding_the_device_or_claim_address_does_not_block_them() {
    let mut w = world(true, STRONG_DEBT);
    w.h.svm.airdrop(&device_pda(STRONG), 1).unwrap();
    w.h.svm.airdrop(&claim_pda(&nonce(STRONG)), 1).unwrap();
    w.prove(Who::A, STRONG).unwrap();
    assert_eq!(w.device().loan, w.a.loan);
    assert_eq!(w.claim().loan, w.a.loan);
}

#[test]
fn only_the_authority_toggles_the_registry() {
    let mut w = world(false, STRONG_DEBT);
    let kp = w.b.kp.insecure_clone();
    assert!(w.h.send_as(&[set_registry_ix(kp.pubkey(), true)], &kp).unwrap_err().contains("Unauthorized"));
    let payer = w.h.payer.pubkey();
    w.h.send(&[set_registry_ix(payer, true)]).unwrap();
    assert!(w.h.account::<RegistryConfig>(&registry_config()).enforce);
    w.prove(Who::A, STRONG).unwrap();
    assert!(w.replay(Who::B, STRONG).unwrap_err().contains("DevicePledgedElsewhere"));
}
