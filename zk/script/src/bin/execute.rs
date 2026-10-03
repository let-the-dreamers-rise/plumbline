//! Runs the guest without proving (sample H100 report + MONTH=strong|weak claims); prints cycles and outputs.
use pct_zk_lib::fixtures::{claims, sample_gpu, setup};
use sp1_sdk::{include_elf, utils, Elf, Prover, ProverClient, SP1Stdin};

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
    let (public_values, report) = client.execute(ELF, stdin).await.unwrap();
    println!("cycles: {}", report.total_instruction_count() + report.total_syscall_count());
    println!("public values: 0x{}", hex::encode(public_values.as_slice()));
}
