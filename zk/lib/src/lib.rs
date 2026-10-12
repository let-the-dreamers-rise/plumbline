//! Shared verification logic for the PCT zk guest: runs natively in tests and inside the zkVM.
#[cfg(any(test, feature = "host"))]
pub mod fixtures;
pub mod gpu;
#[cfg(feature = "risc0")]
pub mod p384_risc0;
pub mod revenue;
pub mod tdx;

use gpu::GpuAttestation;
use revenue::{AttestorSet, CovenantResult, Terms};
use sha2::{Digest, Sha256};
use tdx::TdxAttestation;

/// Length of the guest's public output.
pub const PUBLIC_VALUES_LEN: usize = 6 * 32 + 8 + 8 + 4 + 1 + 32 + 16 + 1;

/// What the guest says about the confidential VM holding the GPU.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VmResult {
    /// sha256(mr_td || sha256(rtmr0..3)): which VM image and runtime the quote measured.
    pub measurement: [u8; 32],
    pub tee_tcb_svn: [u8; 16],
    /// The VM vouched for this exact GPU report: report_data = sha256(GPU report) || GPU nonce,
    /// and it is not a debug TD.
    pub bound: bool,
}

/// Ties the TDX quote to the GPU report: the VM must have put sha256 of the very report the GPU
/// signed in report_data[0..32], and the same challenge the GPU signed in report_data[32..64].
/// A debug TD never binds: its host can write report_data.
pub fn vm_result(gpu_report: &[u8], gpu: &GpuAttestation, vm: &TdxAttestation) -> VmResult {
    let mut h = Sha256::new();
    h.update(vm.mr_td);
    h.update(vm.rtmrs);
    let report_hash: [u8; 32] = Sha256::digest(gpu_report).into();
    VmResult {
        measurement: h.finalize().into(),
        tee_tcb_svn: vm.tee_tcb_svn,
        bound: !vm.debug() && vm.report_data[..32] == report_hash && vm.report_data[32..] == gpu.nonce,
    }
}

/// The guest's public output, fixed layout (the Solana program reads it by offset):
/// chip id | GPU nonce | measurements | attestor set hash | source params hash | terms hash |
/// revenue (u64 LE, micro units of the loan currency) | coverage bps (u64 LE) | claims (u32 LE) |
/// pass (u8) | VM measurement | TDX tcb svn (16) | VM bound to this GPU report (u8).
pub fn public_values(
    gpu: &GpuAttestation,
    vm: &VmResult,
    attestors: &AttestorSet,
    params_hash: &[u8; 32],
    terms: &Terms,
    r: &CovenantResult,
) -> Vec<u8> {
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
    out.extend_from_slice(&vm.measurement);
    out.extend_from_slice(&vm.tee_tcb_svn);
    out.push(vm.bound as u8);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{fixtures::sample_gpu, gpu::verify_gpu, tdx::verify_tdx};

    const QUOTE: &[u8] = include_bytes!("../../fixtures/tdx/quote.bin");

    fn vm_with(report_data: [u8; 64]) -> TdxAttestation {
        TdxAttestation { report_data, ..verify_tdx(QUOTE).unwrap() }
    }

    #[test]
    fn vm_bound_only_to_the_exact_report_and_nonce() {
        let (report, chain) = sample_gpu();
        let gpu = verify_gpu(&report, &chain).unwrap();
        let mut rd = [0u8; 64];
        rd[..32].copy_from_slice(&Sha256::digest(&report));
        rd[32..].copy_from_slice(&gpu.nonce);
        assert!(vm_result(&report, &gpu, &vm_with(rd)).bound);
        let mut other_nonce = rd;
        other_nonce[40] ^= 1;
        assert!(!vm_result(&report, &gpu, &vm_with(other_nonce)).bound);
        let mut other_report = rd;
        other_report[3] ^= 1;
        assert!(!vm_result(&report, &gpu, &vm_with(other_report)).bound);
    }

    #[test]
    fn a_debug_td_never_vouches_for_a_gpu() {
        // Red team: in a debug TD the host can write report_data itself, so the binding is forgeable.
        let (report, chain) = sample_gpu();
        let gpu = verify_gpu(&report, &chain).unwrap();
        let mut rd = [0u8; 64];
        rd[..32].copy_from_slice(&Sha256::digest(&report));
        rd[32..].copy_from_slice(&gpu.nonce);
        let mut vm = vm_with(rd);
        vm.td_attributes[0] |= 1;
        assert!(!vm_result(&report, &gpu, &vm).bound);
    }

    #[test]
    fn fixture_vm_is_not_bound_to_the_sample_gpu() {
        // VoltageGPU's quote vouches for its own report_data, not NVIDIA's sample report.
        let (report, chain) = sample_gpu();
        let gpu = verify_gpu(&report, &chain).unwrap();
        let vm = vm_result(&report, &gpu, &verify_tdx(QUOTE).unwrap());
        assert!(!vm.bound);
        assert_eq!(public_values(&gpu, &vm, &crate::fixtures::setup().1, &[0; 32], &crate::fixtures::setup().3, &CovenantResult { revenue_micro: 0, coverage_bps: 0, pass: false, claims: 0 }).len(), PUBLIC_VALUES_LEN);
    }
}
