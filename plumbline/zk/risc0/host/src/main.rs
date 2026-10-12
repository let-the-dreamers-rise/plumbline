//! Runs or proves the sealed-score guest.
//!   cargo run --release -- execute <quote.bin> <statement.json> [event_log.json]
//!   cargo run --release -- prove   <quote.bin> <statement.json> [event_log.json]   (succinct STARK)
//!   cargo run --release -- groth16 <quote.bin> <statement.json> [event_log.json]   (Groth16 for Solana)
//! IMAGE=testroot selects the TEST ONLY guest that pins fixtures/test-root.der instead of Intel.
//! The journal is 330 bytes: the sealed-eval 298 followed by the statement's payout (zeros if absent).
//! statement.json must be canonical(statement) bytes, exactly as the enclave hashed them.
use risc0_zkvm::{default_executor, default_prover, sha::Digestible, ExecutorEnv, ProverOpts};
use tessera_risc0_methods::{SEALED_SCORE_ELF, SEALED_SCORE_ID, SEALED_SCORE_TESTROOT_ELF, SEALED_SCORE_TESTROOT_ID};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mode = args.get(1).map(String::as_str).unwrap_or("execute");
    if mode == "vk" {
        // control ids the Groth16 verifier must pin (scripts/gen_vk.py)
        let p = risc0_zkvm::Groth16ReceiptVerifierParameters::default();
        println!("{} {}", hex::encode(p.control_root.as_bytes()), hex::encode(p.bn254_control_id.as_bytes()));
        return;
    }
    let quote = std::fs::read(args.get(2).expect("quote path")).unwrap();
    let statement = std::fs::read(args.get(3).expect("statement path")).unwrap();
    // dstack event log JSON as returned with the quote; "[]" when there is none
    let event_log = args.get(4).map(|p| std::fs::read(p).unwrap()).unwrap_or_else(|| b"[]".to_vec());
    let (elf, id) = if std::env::var("IMAGE").as_deref() == Ok("testroot") {
        (SEALED_SCORE_TESTROOT_ELF, SEALED_SCORE_TESTROOT_ID)
    } else {
        (SEALED_SCORE_ELF, SEALED_SCORE_ID)
    };
    let image_id: risc0_zkvm::sha::Digest = id.into();
    println!("image id 0x{}", hex::encode(image_id.as_bytes()));
    let env = || ExecutorEnv::builder().write(&quote).unwrap().write(&statement).unwrap().write(&event_log).unwrap().build().unwrap();

    if mode == "execute" {
        let s = default_executor().execute(env(), elf).unwrap();
        println!("cycles: {} user, {} total in {} segments", s.cycles(), s.segments.iter().map(|x| 1u64 << x.po2).sum::<u64>(), s.segments.len());
        println!("journal: 0x{}", hex::encode(&s.journal.bytes));
        return;
    }
    let opts = if mode == "groth16" { ProverOpts::groth16() } else { ProverOpts::succinct() };
    let t = std::time::Instant::now();
    let info = default_prover().prove_with_opts(env(), elf, &opts).unwrap();
    println!("{mode} proof in {:?}, {} user cycles", t.elapsed(), info.stats.user_cycles);
    info.receipt.verify(id).expect("receipt does not verify");
    let journal = &info.receipt.journal.bytes;
    println!("journal: 0x{}", hex::encode(journal));
    if let Ok(g) = info.receipt.inner.groth16() {
        let out = std::env::var("OUT").unwrap_or_else(|_| "proofs/sealed-score-groth16.json".into());
        if let Some(d) = std::path::Path::new(&out).parent() {
            std::fs::create_dir_all(d).unwrap();
        }
        let json = serde_json::json!({
            "imageId": format!("0x{}", hex::encode(image_id.as_bytes())),
            "journal": format!("0x{}", hex::encode(journal)),
            "journalDigest": format!("0x{}", hex::encode(info.receipt.journal.digest().as_bytes())),
            "seal": format!("0x{}", hex::encode(&g.seal)),
            "claimDigest": format!("0x{}", hex::encode(g.claim.digest().as_bytes())),
            "verifierParameters": format!("0x{}", hex::encode(g.verifier_parameters.as_bytes())),
        });
        std::fs::write(&out, serde_json::to_string_pretty(&json).unwrap()).unwrap();
        println!("wrote {out}");
    }
}
