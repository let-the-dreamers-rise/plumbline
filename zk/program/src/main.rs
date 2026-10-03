//! Guest: one proof that (a) an NVIDIA H100 attestation report is genuine (chain to NVIDIA's
//! Device Identity CA, report signed by the GPU's own key) and (b) the operator's revenue claims
//! for the covenant window carry enough attestor signatures, are unique, and cover debt service.
//! Only hashes and the covenant result are public; amounts, payment ids and the report stay private.
#![no_main]
sp1_zkvm::entrypoint!(main);

use pct_zk_lib::{
    gpu::verify_gpu,
    revenue::{check_covenant, AttestorSet, Claim, Terms},
    public_values,
};

pub fn main() {
    let report = sp1_zkvm::io::read_vec();
    let chain: Vec<Vec<u8>> = sp1_zkvm::io::read();
    let claims: Vec<Claim> = sp1_zkvm::io::read();
    let attestors: AttestorSet = sp1_zkvm::io::read();
    let params_hash: [u8; 32] = sp1_zkvm::io::read();
    let terms: Terms = sp1_zkvm::io::read();

    let gpu = verify_gpu(&report, &chain).expect("GPU attestation rejected");
    let covenant = check_covenant(&claims, &attestors, &params_hash, &terms).expect("revenue claims rejected");
    sp1_zkvm::io::commit_slice(&public_values(&gpu, &attestors, &params_hash, &terms, &covenant));
}
