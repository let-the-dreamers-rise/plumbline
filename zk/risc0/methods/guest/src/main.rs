//! RISC Zero guest: same checks as zk/program (SP1), with P-384 on the curve accelerator.
//! Verifies an NVIDIA H100 attestation report and the operator's revenue covenant, and commits
//! only hashes and the covenant result (zk/lib `public_values`).
use pct_zk_lib::{
    gpu::verify_gpu,
    public_values,
    revenue::{check_covenant, AttestorSet, Claim, Terms},
};
use risc0_zkvm::guest::env;

fn main() {
    let report: Vec<u8> = env::read();
    let chain: Vec<Vec<u8>> = env::read();
    let claims: Vec<Claim> = env::read();
    let attestors: AttestorSet = env::read();
    let params_hash: [u8; 32] = env::read();
    let terms: Terms = env::read();

    let gpu = verify_gpu(&report, &chain).expect("GPU attestation rejected");
    let covenant = check_covenant(&claims, &attestors, &params_hash, &terms).expect("revenue claims rejected");
    env::commit_slice(&public_values(&gpu, &attestors, &params_hash, &terms, &covenant));
}
