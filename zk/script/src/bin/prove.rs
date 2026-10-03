//! Proves the guest on NVIDIA's sample H100 report and wraps it in Groth16 for Solana.
//! Writes proofs/gpu-sample.json: { vkey, publicValues, proof } as hex.
use pct_zk_lib::fixtures::{claims, sample_gpu, setup};
use sp1_sdk::{include_elf, utils, Elf, HashableKey, ProveRequest, Prover, ProverClient, ProvingKey, SP1Stdin};

const ELF: Elf = include_elf!("pct-zk-program");

/// Guest input: the sample GPU report and the strong (PASS) or weak (WATCH) month of claims.
fn stdin_for(month: &str) -> SP1Stdin {
    let (report, chain) = sample_gpu();
    let (fx, attestors, params, terms) = setup();
    let mut stdin = SP1Stdin::new();
    stdin.write_vec(report);
    stdin.write(&chain);
    stdin.write(&claims(&fx[month]));
    stdin.write(&attestors);
    stdin.write(&params);
    stdin.write(&terms);
    stdin
}

#[tokio::main]
async fn main() {
    utils::setup_logger();
    let month = std::env::var("MONTH").unwrap_or_else(|_| "strong".into());
    let stdin = stdin_for(&month);

    let client = ProverClient::from_env().await;
    let pk = client.setup(ELF).await.unwrap();
    let vkey = pk.verifying_key().bytes32();
    println!("program vkey {vkey}");
    let started = std::time::Instant::now();
    let mode = std::env::args().nth(1).unwrap_or_else(|| "groth16".into());
    let request = client.prove(&pk, stdin);
    let proof = match mode.as_str() {
        "core" => request.core().await.unwrap(),
        "compressed" => request.compressed().await.unwrap(),
        _ => request.groth16().await.unwrap(),
    };
    println!("{mode} proof in {:?}", started.elapsed());
    if mode != "groth16" {
        client.verify(&proof, pk.verifying_key(), None).expect("proof does not verify");
        println!("{mode} proof verifies");
        return;
    }
    client.verify(&proof, pk.verifying_key(), None).expect("proof does not verify");

    std::fs::create_dir_all("proofs").unwrap();
    let json = format!(
        "{{\n  \"vkey\": \"{vkey}\",\n  \"publicValues\": \"0x{}\",\n  \"proof\": \"0x{}\"\n}}\n",
        hex::encode(proof.public_values.as_slice()),
        hex::encode(proof.bytes())
    );
    std::fs::write(format!("proofs/covenant-{month}.json"), json).unwrap();
    proof.save(format!("proofs/covenant-{month}.bin")).unwrap();
    println!("wrote proofs/covenant-{month}.json");
}
