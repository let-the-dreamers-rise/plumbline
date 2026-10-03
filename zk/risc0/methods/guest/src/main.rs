//! RISC Zero guest, three roots in one proof: an NVIDIA H100 attestation report (P-384 on the
//! curve accelerator), the Intel TDX quote of the confidential VM holding that GPU (P-256), and the
//! operator's 2-of-n attested revenue covenant. Commits only hashes and results (zk/lib
//! `public_values`).
use pct_zk_lib::{
    gpu::verify_gpu,
    public_values,
    revenue::{check_covenant, AttestorSet, Claim, Terms},
    tdx::verify_tdx,
    vm_result,
};
use risc0_zkvm::guest::env;

fn main() {
    let report: Vec<u8> = env::read();
    let chain: Vec<Vec<u8>> = env::read();
    let claims: Vec<Claim> = env::read();
    let attestors: AttestorSet = env::read();
    let params_hash: [u8; 32] = env::read();
    let terms: Terms = env::read();
    let quote: Vec<u8> = env::read();

    let gpu = verify_gpu(&report, &chain).expect("GPU attestation rejected");
    let vm = verify_tdx(&quote).expect("TDX quote rejected");
    let vm = vm_result(&report, &gpu, &vm);
    let covenant = check_covenant(&claims, &attestors, &params_hash, &terms).expect("revenue claims rejected");
    env::commit_slice(&public_values(&gpu, &vm, &attestors, &params_hash, &terms, &covenant));
}
