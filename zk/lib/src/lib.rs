//! Shared verification logic for the PCT zk guest: runs natively in tests and inside SP1.
#[cfg(any(test, feature = "host"))]
pub mod fixtures;
pub mod gpu;
#[cfg(feature = "risc0")]
pub mod p384_risc0;
pub mod revenue;

use gpu::GpuAttestation;
use revenue::{AttestorSet, CovenantResult, Terms};

/// Length of the guest's public output.
pub const PUBLIC_VALUES_LEN: usize = 6 * 32 + 8 + 8 + 4 + 1;

/// The guest's public output, fixed layout (the Solana program reads it by offset):
/// chip id | GPU nonce | measurements | attestor set hash | source params hash | terms hash |
/// revenue (u64 LE, micro units of the loan currency) | coverage bps (u64 LE) | claims (u32 LE) |
/// pass (u8).
pub fn public_values(gpu: &GpuAttestation, attestors: &AttestorSet, params_hash: &[u8; 32], terms: &Terms, r: &CovenantResult) -> Vec<u8> {
    let mut out = Vec::with_capacity(PUBLIC_VALUES_LEN);
    out.extend_from_slice(&gpu.chip_id);
    out.extend_from_slice(&gpu.nonce);
    out.extend_from_slice(&gpu.measurements);
    out.extend_from_slice(&attestors.hash());
    out.extend_from_slice(params_hash);
    out.extend_from_slice(&terms.hash());
    out.extend_from_slice(&r.revenue_micro.to_le_bytes());
    out.extend_from_slice(&r.coverage_bps.to_le_bytes());
    out.extend_from_slice(&r.claims.to_le_bytes());
    out.push(r.pass as u8);
    out
}
