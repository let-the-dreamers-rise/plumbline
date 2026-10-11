//! Operator revenue proofs against a loan: covenant-gated draws, per-period receipts, and realized
//! rent flowing into the paid tape. Fixtures come from scripts/make-revenue-fixtures.ts.

mod common;

use {
    anchor_lang::{prelude::Pubkey, solana_program::system_program},
    common::{boot, default_params, hex, keccak, pda, Harness},
    pct_oracle::{
        instructions::{revenue_item_key, revenue_receipt_key, ClaimSig, LoanTerms},
        state::{Book, Loan},
        SourceArgs,
    },
    serde_json::Value,
    solana_keypair::Keypair,
    solana_signer::Signer,
};

const SOL: u64 = 1_000_000_000;

fn fixtures() -> Value {
    serde_json::from_str(include_str!("fixtures/revenue.json")).unwrap()
}

fn claim<'a>(fx: &'a Value, name: &str) -> &'a Value {
    fx["claims"].as_array().unwrap().iter().find(|c| c["name"] == name).unwrap()
}

/// Same as revenueSourceArgs in packages/oracle: keccak("name:paramsHash").
fn source_id(fx: &Value, name: &str) -> [u8; 32] {
    let s = fx["sources"].as_array().unwrap().iter().find(|s| s["name"] == name).unwrap();
    keccak(format!("{}:{}", name, s["paramsHash"].as_str().unwrap()).as_bytes())
}

struct Setup {
    h: Harness,
    fx: Value,
    borrower: Keypair,
    loan: Pubkey,
    operator_key: [u8; 32],
}

fn setup() -> Setup {
    let fx = fixtures();
    let attestor: [u8; 20] = hex(fx["attestor"].as_str().unwrap()).try_into().unwrap();
    let start = claim(&fx, "op1-vast-w0")["timestampS"].as_i64().unwrap() + 60;
    let mut h = boot(attestor, default_params(), start);
    let payer = h.payer.pubkey();

    for s in fx["sources"].as_array().unwrap() {
        let id = source_id(&fx, s["name"].as_str().unwrap());
        let args = SourceArgs {
            source_id: id,
            params_hash: hex(s["paramsHash"].as_str().unwrap()).try_into().unwrap(),
            provider_id: s["provider"].as_u64().unwrap() as u16,
            sku: 0,
            kind: 2,
            gpu_count: 1,
            value_mode: 1,
            requires_nullifier: true,
        };
        h.send(&[Harness::ix(
            pct_oracle::instruction::RegisterSource { args },
            pct_oracle::accounts::RegisterSource {
                authority: payer,
                config: pda(&[b"config"]),
                source: pda(&[b"source", &id]),
                system_program: system_program::ID,
            },
        )])
        .unwrap();
    }

    let borrower = Keypair::new();
    h.svm.airdrop(&borrower.pubkey(), SOL).unwrap();
    let operator_key = keccak(fx["operators"]["op1"].as_str().unwrap().as_bytes());
    let loan = pda(&[b"loan", payer.as_ref(), &operator_key]);
    let terms = LoanTerms {
        operator_key,
        borrower: borrower.pubkey(),
        sku: 0,
        fleet_gpus: 8,
        period_s: fx["periodS"].as_u64().unwrap() as u32,
        debt_service_micro: 1_500_000_000, // $1,500 per week
        min_coverage_bps: 11_500, // 1.15x, the demo's coverage ratio (the lender sets it)
        currency: *b"USD",
        covenant_periods: 2,
    };
    h.send(&[
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
    Setup { h, fx, borrower, loan, operator_key }
}

/// Uploads and submits one revenue claim at its own timestamp (+60s) against `loan`.
fn submit(s: &mut Setup, name: &str, loan: Pubkey, receipt_operator: [u8; 32]) -> Result<u64, String> {
    let c = claim(&s.fx, name).clone();
    s.h.set_time(c["timestampS"].as_i64().unwrap() + 60);
    let buffer = s.h.upload(b"http", c["parameters"].as_str().unwrap().as_bytes(), c["context"].as_str().unwrap().as_bytes())?;
    let source_name = c["source"].as_str().unwrap();
    let source = pda(&[b"source", &source_id(&s.fx, source_name)]);
    let provider = s.fx["sources"].as_array().unwrap().iter().find(|x| x["name"] == source_name).unwrap()["provider"].as_u64().unwrap() as u16;
    let timestamp_s = c["timestampS"].as_u64().unwrap() as u32;
    let extracted = &c["extracted"];
    let receipt_key = match extracted["item"].as_str() {
        Some(item) => revenue_item_key(&receipt_operator, item.as_bytes()),
        None => {
            let earned_at = extracted["at"].as_str().map_or(timestamp_s as u64, |a| a.parse().unwrap());
            revenue_receipt_key(&receipt_operator, (earned_at / s.fx["periodS"].as_u64().unwrap()) as u32)
        }
    };
    let sig = ClaimSig {
        owner: c["owner"].as_str().unwrap().to_string(),
        timestamp_s,
        epoch: 1,
        signature: hex(c["signature"].as_str().unwrap()).try_into().unwrap(),
    };
    let payer = s.h.payer.pubkey();
    let result = s.h.send(&[Harness::ix(
        pct_oracle::instruction::SubmitRevenue { sig, receipt_key },
        pct_oracle::accounts::SubmitRevenue {
            submitter: payer,
            config: pda(&[b"config"]),
            source,
            loan,
            book: pda(&[b"book", &[0], &[0]]),
            buffer,
            receipt: pda(&[b"receipt", &provider.to_le_bytes(), loan.as_ref(), &receipt_key]),
            system_program: system_program::ID,
        },
    )]);
    if result.is_err() {
        s.h.close_buffer();
    }
    result
}

fn draw(s: &mut Setup, lamports: u64) -> Result<u64, String> {
    let blockhash = s.h.svm.latest_blockhash();
    let ix = Harness::ix(
        pct_oracle::instruction::Draw { lamports },
        pct_oracle::accounts::Draw { borrower: s.borrower.pubkey(), loan: s.loan },
    );
    let msg = solana_message::Message::new_with_blockhash(&[ix], Some(&s.borrower.pubkey()), &blockhash);
    let tx = solana_transaction::versioned::VersionedTransaction::try_new(solana_message::VersionedMessage::Legacy(msg), &[&s.borrower]).unwrap();
    let r = s.h.svm.send_transaction(tx);
    s.h.svm.expire_blockhash();
    r.map(|m| m.compute_units_consumed).map_err(|e| format!("{:?}\n{}", e.err, e.meta.logs.join("\n")))
}

#[test]
fn proven_revenue_unlocks_draws_and_feeds_the_tape() {
    let mut s = setup();
    let loan = s.loan;
    let op = s.operator_key;

    assert!(draw(&mut s, SOL).unwrap_err().contains("NoRecentRevenue"), "no proofs yet");

    submit(&mut s, "op1-vast-wm1", loan, op).expect("the week before");
    let cu_vast = submit(&mut s, "op1-vast-w0", loan, op).expect("vast payout accepted");
    let cu_stripe = submit(&mut s, "op1-stripe-w0", loan, op).expect("stripe balance accepted");
    let l: Loan = s.h.account(&loan);
    let latest = l.latest().unwrap();
    assert_eq!((latest.revenue_micro, latest.gpu_hours_micro, latest.proofs), (2_980_480_000, 1_075_200_000, 2));
    assert_eq!(l.coverage_bps(&latest), 19_869, "1.99x coverage");

    let cu_draw = draw(&mut s, 2 * SOL).expect("covenant met");
    assert_eq!(s.h.account::<Loan>(&loan).drawn_lamports, 2 * SOL);

    let book: Book = s.h.book(0, 0);
    assert_eq!(book.len, 2, "one realized rent per week with hours; stripe has none");
    assert_eq!(book.slots[0].price_micro, 2_400_000, "2580.48 / 1075.2 = $2.40 per GPU-hour");

    // Week 1: utilization collapses to 150 GPU-hours ($360). Two-week window:
    // (2980.48 + 360) / (2 x 1500) = 1.11x, under the 1.15x covenant.
    submit(&mut s, "op1-vast-w1", loan, op).expect("week 1 accepted");
    let l: Loan = s.h.account(&loan);
    assert_eq!(l.trailing_coverage_bps(l.latest().unwrap().period), 11_134);
    let err = draw(&mut s, SOL).unwrap_err();
    assert!(err.contains("CovenantBreached"), "{err}");
    assert!(err.contains("coverage 11134 bps"), "{err}");

    println!("submit_revenue CU: vast {cu_vast}, stripe {cu_stripe}; draw CU: {cu_draw}");
}

#[test]
fn one_proof_per_source_and_period() {
    let mut s = setup();
    let (loan, op) = (s.loan, s.operator_key);
    submit(&mut s, "op1-vast-w0", loan, op).unwrap();
    let err = submit(&mut s, "op1-vast-w0", loan, op).unwrap_err();
    assert!(err.contains("already in use"), "{err}");
}

#[test]
fn a_payout_counts_once_and_in_the_period_it_arrived() {
    let mut s = setup();
    let (loan, op) = (s.loan, s.operator_key);
    submit(&mut s, "op1-vast-w0", loan, op).unwrap();
    submit(&mut s, "op1-stripe-w0", loan, op).unwrap();
    // Proven again a week later: same payout id, so the receipt already exists.
    let err = submit(&mut s, "op1-stripe-w0-again", loan, op).unwrap_err();
    assert!(err.contains("already in use"), "{err}");

    let l: Loan = s.h.account(&loan);
    assert_eq!(l.latest().unwrap().revenue_micro, 2_980_480_000, "$400.00 payout from 40000 cents, counted once");
}

#[test]
fn another_operators_proof_cannot_count_toward_this_loan() {
    let mut s = setup();
    let (loan, op) = (s.loan, s.operator_key);
    let err = submit(&mut s, "op2-vast-w0", loan, op).unwrap_err();
    assert!(err.contains("OperatorMismatch"), "{err}");
}

#[test]
fn only_the_borrower_draws_and_only_what_is_funded() {
    let mut s = setup();
    let (loan, op) = (s.loan, s.operator_key);
    submit(&mut s, "op1-vast-wm1", loan, op).unwrap();
    submit(&mut s, "op1-vast-w0", loan, op).unwrap();
    assert!(draw(&mut s, 11 * SOL).unwrap_err().contains("InsufficientFunds"));

    let payer = s.h.payer.pubkey();
    let err = s
        .h
        .send(&[Harness::ix(pct_oracle::instruction::Draw { lamports: 1 }, pct_oracle::accounts::Draw { borrower: payer, loan })])
        .unwrap_err();
    assert!(err.contains("NotBorrower"), "{err}");
}

#[test]
fn stale_revenue_blocks_draws() {
    let mut s = setup();
    let (loan, op) = (s.loan, s.operator_key);
    submit(&mut s, "op1-vast-w0", loan, op).unwrap();
    let t = claim(&s.fx, "op1-vast-w0")["timestampS"].as_i64().unwrap();
    s.h.set_time(t + 2 * 604_800);
    assert!(draw(&mut s, SOL).unwrap_err().contains("NoRecentRevenue"));
}

/// Opens a second, INR loan bound to `operator` (the Razorpay claim owner) with the setup's lender.
fn open_inr_loan(s: &mut Setup, operator: &str) -> ([u8; 32], Pubkey) {
    let operator_key = keccak(operator.as_bytes());
    let lender = s.h.payer.pubkey();
    let loan = pda(&[b"loan", lender.as_ref(), &operator_key]);
    let terms = LoanTerms {
        operator_key,
        borrower: s.borrower.pubkey(),
        sku: 0,
        fleet_gpus: 8,
        period_s: s.fx["periodS"].as_u64().unwrap() as u32,
        debt_service_micro: 120_000_000_000, // ₹120,000 per week
        min_coverage_bps: 11_500,
        currency: *b"INR",
        covenant_periods: 2,
    };
    s.h.send(&[Harness::ix(
        pct_oracle::instruction::OpenLoan { terms },
        pct_oracle::accounts::OpenLoan { lender, loan, system_program: system_program::ID },
    )])
    .unwrap();
    (operator_key, loan)
}

#[test]
fn razorpay_payments_bind_to_the_claim_owner_and_the_loan_currency() {
    let mut s = setup();
    let owner = s.fx["operators"]["rzp"].as_str().unwrap().to_string();
    let (op, loan) = open_inr_loan(&mut s, &owner);

    submit(&mut s, "rzp-w0", loan, op).expect("captured INR payment from the operator's own app");
    let l: Loan = s.h.account(&loan);
    assert_eq!(l.latest().unwrap().revenue_micro, 250_000_000_000, "25,000,000 paise = ₹250,000");
    assert_eq!(l.trailing_coverage_bps(l.latest().unwrap().period), 10_416, "250k / (2 x 120k)");

    let err = submit(&mut s, "rzp-w0-other-owner", loan, op).unwrap_err();
    assert!(err.contains("OperatorMismatch"), "{err}");
    let err = submit(&mut s, "rzp-w0-usd", loan, op).unwrap_err();
    assert!(err.contains("CurrencyMismatch"), "{err}");

    // A USD loan refuses INR revenue even from the right operator key.
    let (usd_loan, usd_op) = (s.loan, s.operator_key);
    let err = submit(&mut s, "rzp-w0", usd_loan, usd_op).unwrap_err();
    assert!(err.contains("OperatorMismatch") || err.contains("CurrencyMismatch"), "{err}");
}

#[test]
fn rejects_malformed_loan_terms() {
    let mut s = setup();
    let lender = s.h.payer.pubkey();
    let operator_key = keccak(b"someone");
    let loan = pda(&[b"loan", lender.as_ref(), &operator_key]);
    let base = LoanTerms {
        operator_key,
        borrower: s.borrower.pubkey(),
        sku: 0,
        fleet_gpus: 8,
        period_s: 604_800,
        debt_service_micro: 1,
        min_coverage_bps: 11_500,
        currency: *b"USD",
        covenant_periods: 13,
    };
    for bad in [
        LoanTerms { currency: *b"JPY", ..base },
        LoanTerms { covenant_periods: 0, ..base },
        LoanTerms { covenant_periods: 14, ..base },
        LoanTerms { currency: *b"usd", ..base },
        LoanTerms { sku: 9, ..base },
        LoanTerms { fleet_gpus: 0, ..base },
        LoanTerms { period_s: 60, ..base },
        LoanTerms { debt_service_micro: 0, ..base },
    ] {
        let err = s
            .h
            .send(&[Harness::ix(
                pct_oracle::instruction::OpenLoan { terms: bad },
                pct_oracle::accounts::OpenLoan { lender, loan, system_program: system_program::ID },
            )])
            .unwrap_err();
        assert!(err.contains("BadLoanTerms"), "{err}");
    }
}

#[test]
fn one_good_week_cannot_carry_a_two_week_covenant() {
    let mut s = setup();
    let (loan, op) = (s.loan, s.operator_key);
    submit(&mut s, "op1-vast-w0", loan, op).unwrap();
    submit(&mut s, "op1-stripe-w0", loan, op).unwrap();
    let err = draw(&mut s, SOL).unwrap_err();
    assert!(err.contains("coverage 9934 bps"), "2980.48 / (2 x 1500): {err}");
}

#[test]
fn minor_units_need_a_currency() {
    let mut s = setup();
    let (loan, op) = (s.loan, s.operator_key);
    let err = submit(&mut s, "op1-stripe-nocurrency", loan, op).unwrap_err();
    assert!(err.contains("CurrencyMismatch"), "{err}");
}

fn withdraw_ix(lender: Pubkey, loan: Pubkey, lamports: u64) -> anchor_lang::solana_program::instruction::Instruction {
    Harness::ix(pct_oracle::instruction::Withdraw { lamports }, pct_oracle::accounts::Withdraw { lender, loan })
}

#[test]
fn only_the_lender_withdraws_undrawn_funds() {
    let mut s = setup();
    let lender = s.h.payer.pubkey();
    let before = s.h.svm.get_balance(&lender).unwrap();
    s.h.send(&[withdraw_ix(lender, s.loan, 3 * SOL)]).expect("lender withdraws");
    assert!(s.h.svm.get_balance(&lender).unwrap() > before + 3 * SOL - 10_000);

    // The borrower signing as "lender" is refused.
    let blockhash = s.h.svm.latest_blockhash();
    let ix = withdraw_ix(s.borrower.pubkey(), s.loan, SOL);
    let msg = solana_message::Message::new_with_blockhash(&[ix], Some(&s.borrower.pubkey()), &blockhash);
    let tx = solana_transaction::versioned::VersionedTransaction::try_new(solana_message::VersionedMessage::Legacy(msg), &[&s.borrower]).unwrap();
    let err = s.h.svm.send_transaction(tx).map_err(|e| e.meta.logs.join("\n")).unwrap_err();
    assert!(err.contains("NotLender"), "{err}");

    let err = s.h.send(&[withdraw_ix(lender, s.loan, 100 * SOL)]).unwrap_err();
    assert!(err.contains("InsufficientFunds"), "{err}");
}

#[test]
fn loans_from_other_lenders_do_not_feed_the_price_tape() {
    let mut s = setup();
    // A second lender (not the oracle authority) opens its own loan for the same operator: its
    // PDA differs, so it cannot squat the first lender's loan either.
    let other = Keypair::new();
    s.h.svm.airdrop(&other.pubkey(), 5 * SOL).unwrap();
    let op = s.operator_key;
    let loan = pda(&[b"loan", other.pubkey().as_ref(), &op]);
    assert_ne!(loan, s.loan);
    let terms = LoanTerms {
        operator_key: op,
        borrower: s.borrower.pubkey(),
        sku: 0,
        fleet_gpus: 8,
        period_s: 604_800,
        debt_service_micro: 1_500_000_000,
        min_coverage_bps: 11_500,
        currency: *b"USD",
        covenant_periods: 2,
    };
    let blockhash = s.h.svm.latest_blockhash();
    let ix = Harness::ix(
        pct_oracle::instruction::OpenLoan { terms },
        pct_oracle::accounts::OpenLoan { lender: other.pubkey(), loan, system_program: system_program::ID },
    );
    let msg = solana_message::Message::new_with_blockhash(&[ix], Some(&other.pubkey()), &blockhash);
    let tx = solana_transaction::versioned::VersionedTransaction::try_new(solana_message::VersionedMessage::Legacy(msg), &[&other]).unwrap();
    s.h.svm.send_transaction(tx).unwrap();

    submit(&mut s, "op1-vast-w0", loan, op).expect("revenue still counts for that lender's loan");
    assert_eq!(s.h.account::<Loan>(&loan).latest().unwrap().revenue_micro, 2_580_480_000);
    assert_eq!(s.h.book(0, 0).len, 0, "but its rent never reaches the public book");
}
