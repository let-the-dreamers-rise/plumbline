//! Runs or proves the RISC Zero covenant guest on NVIDIA's sample H100 report and the
//! MONTH=strong|weak fixture claims.
//!   cargo run --release -- execute
//!   cargo run --release -- prove            (succinct STARK)
//!   cargo run --release -- groth16          (Groth16 for Solana; needs Docker)
use pct_risc0_methods::{COVENANT_ELF, COVENANT_ID};
use pct_zk_lib::fixtures::{claims, sample_gpu, setup};
use risc0_zkvm::{default_executor, default_prover, sha::Digestible, ExecutorEnv, ProverOpts};

fn env_for(month: &str, po2: u32) -> ExecutorEnv<'static> {
    let (report, chain) = sample_gpu();
    let (fx, attestors, params, terms) = setup();
    ExecutorEnv::builder()
        .segment_limit_po2(po2)
        .write(&report)
        .unwrap()
        .write(&chain)
        .unwrap()
        .write(&claims(&fx[month]))
        .unwrap()
        .write(&attestors)
        .unwrap()
        .write(&params)
        .unwrap()
        .write(&terms)
        .unwrap()
        .build()
        .unwrap()
}

fn main() {
    let mode = std::env::args().nth(1).unwrap_or_else(|| "execute".into());
    let month = std::env::var("MONTH").unwrap_or_else(|_| "strong".into());
    let po2: u32 = std::env::var("SEGMENT_PO2").ok().and_then(|v| v.parse().ok()).unwrap_or(19);
    let image_id: risc0_zkvm::sha::Digest = COVENANT_ID.into();
    println!("image id 0x{}", hex::encode(image_id.as_bytes()));

    if mode == "execute" {
        let session = default_executor().execute(env_for(&month, po2), COVENANT_ELF).unwrap();
        println!("cycles: {} user, {} total in {} segments", session.cycles(), session.segments.iter().map(|s| 1u64 << s.po2).sum::<u64>(), session.segments.len());
        println!("public values: 0x{}", hex::encode(&session.journal.bytes));
        return;
    }

    let opts = if mode == "groth16" { ProverOpts::groth16() } else { ProverOpts::succinct() };
    let started = std::time::Instant::now();
    let info = default_prover().prove_with_opts(env_for(&month, po2), COVENANT_ELF, &opts).unwrap();
    println!("{mode} proof in {:?}", started.elapsed());
    info.receipt.verify(COVENANT_ID).expect("receipt does not verify");
    let journal = &info.receipt.journal.bytes;
    println!("public values: 0x{}", hex::encode(journal));

    std::fs::create_dir_all("proofs").unwrap();
    if let Ok(g) = info.receipt.inner.groth16() {
        let json = serde_json::json!({
            "imageId": format!("0x{}", hex::encode(image_id.as_bytes())),
            "journal": format!("0x{}", hex::encode(journal)),
            "journalDigest": format!("0x{}", hex::encode(info.receipt.journal.digest().as_bytes())),
            "seal": format!("0x{}", hex::encode(&g.seal)),
            "claimDigest": format!("0x{}", hex::encode(g.claim.digest().as_bytes())),
        });
        std::fs::write(format!("proofs/covenant-{month}-groth16.json"), serde_json::to_string_pretty(&json).unwrap()).unwrap();
        println!("wrote proofs/covenant-{month}-groth16.json");
    }
}
