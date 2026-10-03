//! Private covenant on a local chain: the real RISC Zero Groth16 proof from zk/risc0 (NVIDIA's
//! sample H100 report + a strong Razorpay month signed by two attestors) flips a loan to PASS and
//! unlocks a draw, with no amounts onchain. Fixtures: tests/fixtures/covenant-strong-groth16.json
//! and zk-revenue-claims.json (copies of zk/fixtures).

mod common;

use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{instruction::Instruction, system_program},
    },
    common::{boot_with, default_params, hex, keccak, pda, Harness},
    pct_oracle::{
        instructions::{LoanTerms, ZkCovenant, ZK_PASS},
        SourceArgs,
    },
    serde_json::Value,
    solana_keypair::Keypair,
    solana_signer::Signer,
};

const SOL: u64 = 1_000_000_000;

fn json(s: &str) -> Value {
    serde_json::from_str(s).unwrap()
}

fn compute_limit(units: u32) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&units.to_le_bytes());
    Instruction::new_with_bytes("ComputeBudget111111111111111111111111111111".parse().unwrap(), &data, vec![])
}

struct Setup {
    h: Harness,
    proof: Value,
    borrower: Keypair,
    loan: Pubkey,
    source_id: [u8; 32],
    as_of: u32,
}

fn field(v: &Value, k: &str) -> Vec<u8> {
    hex(v[k].as_str().unwrap())
}

/// Config with the two test attestors, the Razorpay revenue source, a funded INR loan with the
/// terms the proof was made for, and the zk config pinned to the guest's image id.
fn setup(debt_service_micro: u64) -> Setup {
    let fx = json(include_str!("fixtures/zk-revenue-claims.json"));
    let proof = json(include_str!("fixtures/covenant-strong-groth16.json"));
    let t = &fx["terms"];
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
    let borrower = Keypair::new();
    h.svm.airdrop(&borrower.pubkey(), SOL).unwrap();
    let operator_key: [u8; 32] = hex(t["operator_key"].as_str().unwrap()).try_into().unwrap();
    let loan = pda(&[b"loan", payer.as_ref(), &operator_key]);
    let terms = LoanTerms {
        operator_key,
        borrower: borrower.pubkey(),
        sku: 0,
        fleet_gpus: 1,
        period_s: period_s as u32,
        debt_service_micro,
        min_coverage_bps: t["min_coverage_bps"].as_u64().unwrap() as u16,
        currency: *b"INR",
        covenant_periods: t["covenant_periods"].as_u64().unwrap() as u8,
    };
    let image_id: [u8; 32] = field(&proof, "imageId").try_into().unwrap();
    h.send(&[
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
            pct_oracle::instruction::SetZkConfig { image_id, attestor_threshold: 2 },
            pct_oracle::accounts::SetZkConfig {
                authority: payer,
                config: pda(&[b"config"]),
                zk_config: pda(&[b"zk_config"]),
                system_program: system_program::ID,
            },
        ),
        Harness::ix(
            pct_oracle::instruction::OpenLoan { terms },
            pct_oracle::accounts::OpenLoan { lender: payer, loan, system_program: system_program::ID },
        ),
        Harness::ix(
            pct_oracle::instruction::FundLoan { lamports: 10 * SOL },
            pct_oracle::accounts::FundLoan { lender: payer, loan, system_program: system_program::ID },
        ),
    ])
    .unwrap();
    Setup { h, proof, borrower, loan, source_id, as_of }
}

impl Setup {
    fn challenge(&mut self, c: [u8; 32]) {
        let payer = self.h.payer.pubkey();
        self.h
            .send(&[Harness::ix(
                pct_oracle::instruction::IssueGpuChallenge { challenge: c },
                pct_oracle::accounts::IssueGpuChallenge {
                    lender: payer,
                    loan: self.loan,
                    zk_covenant: pda(&[b"zk_covenant", self.loan.as_ref()]),
                    system_program: system_program::ID,
                },
            )])
            .unwrap();
    }

    /// The nonce the sample GPU report signed (journal word 1).
    fn gpu_nonce(&self) -> [u8; 32] {
        field(&self.proof, "journal")[32..64].try_into().unwrap()
    }

    fn prove(&mut self, seal: Vec<u8>, journal: Vec<u8>) -> Result<u64, String> {
        let payer = self.h.payer.pubkey();
        self.h.send(&[
            compute_limit(1_400_000),
            Harness::ix(
                pct_oracle::instruction::ProveCovenant { seal, public_values: journal, as_of_period: self.as_of },
                pct_oracle::accounts::ProveCovenant {
                    submitter: payer,
                    config: pda(&[b"config"]),
                    zk_config: pda(&[b"zk_config"]),
                    source: pda(&[b"source", &self.source_id]),
                    loan: self.loan,
                    zk_covenant: pda(&[b"zk_covenant", self.loan.as_ref()]),
                },
            ),
        ])
    }

    fn prove_real(&mut self) -> Result<u64, String> {
        let (seal, journal) = (field(&self.proof, "seal"), field(&self.proof, "journal"));
        self.prove(seal, journal)
    }

    fn draw(&mut self, lamports: u64) -> Result<u64, String> {
        let ix = Harness::ix(
            pct_oracle::instruction::DrawPrivate { lamports },
            pct_oracle::accounts::DrawPrivate {
                borrower: self.borrower.pubkey(),
                loan: self.loan,
                zk_covenant: pda(&[b"zk_covenant", self.loan.as_ref()]),
            },
        );
        let blockhash = self.h.svm.latest_blockhash();
        let msg = solana_message::Message::new_with_blockhash(&[ix], Some(&self.borrower.pubkey()), &blockhash);
        let tx = solana_transaction::versioned::VersionedTransaction::try_new(
            solana_message::VersionedMessage::Legacy(msg),
            &[&self.borrower],
        )
        .unwrap();
        let r = self.h.svm.send_transaction(tx);
        self.h.svm.expire_blockhash();
        r.map(|m| m.compute_units_consumed).map_err(|e| format!("{:?}\n{}", e.err, e.meta.logs.join("\n")))
    }
}

#[test]
fn real_proof_flips_the_loan_to_pass_and_unlocks_a_draw() {
    let mut s = setup(120_000_000_000);
    assert!(s.draw(SOL).is_err(), "no proof yet, no draw");
    let nonce = s.gpu_nonce();
    s.challenge(nonce);
    assert!(s.draw(SOL).unwrap_err().contains("NoRecentRevenue"), "challenge issued but nothing proven");
    let cu = s.prove_real().unwrap();
    println!("prove_covenant: {cu} CU");
    let z: ZkCovenant = s.h.account(&pda(&[b"zk_covenant", s.loan.as_ref()]));
    assert_eq!(z.status, ZK_PASS);
    assert_eq!(z.coverage_bps, 13_541);
    assert_eq!(z.claims, 4);
    assert_eq!(z.as_of_period, s.as_of);
    s.draw(2 * SOL).unwrap();
}

#[test]
fn proof_for_another_challenge_is_refused() {
    let mut s = setup(120_000_000_000);
    s.challenge([7u8; 32]);
    assert!(s.prove_real().unwrap_err().contains("ZkStaleChallenge"));
}

#[test]
fn edited_verdict_is_refused() {
    let mut s = setup(120_000_000_000);
    let nonce = s.gpu_nonce();
    s.challenge(nonce);
    let mut journal = field(&s.proof, "journal");
    let at = journal.len() - 9 - 8; // coverage_bps (u64 LE) sits before claims (u32) and pass (u8)
    journal[at..at + 8].copy_from_slice(&50_000u64.to_le_bytes());
    assert!(s.prove(field(&s.proof, "seal"), journal).unwrap_err().contains("BadZkProof"));
}

#[test]
fn proof_made_for_other_loan_terms_is_refused() {
    // A lender whose loan asks for twice the debt service cannot reuse the proof.
    let mut s = setup(240_000_000_000);
    let nonce = s.gpu_nonce();
    s.challenge(nonce);
    assert!(s.prove_real().unwrap_err().contains("ZkTermsMismatch"));
}

#[test]
fn proof_is_too_old_once_the_window_moves_on() {
    let mut s = setup(120_000_000_000);
    let nonce = s.gpu_nonce();
    s.challenge(nonce);
    let later = ((s.as_of + 2) as i64) * 604_800 + 60;
    s.h.set_time(later);
    assert!(s.prove_real().unwrap_err().contains("NoRecentRevenue"));
}
