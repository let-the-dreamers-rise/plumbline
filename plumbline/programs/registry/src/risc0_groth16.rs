//! RISC Zero Groth16 receipt verification over Solana's alt_bn128 syscalls.
//!
//! A RISC Zero Groth16 seal is `A (64) | B (128) | C (64)`, big-endian EIP-197 encoding. The
//! circuit has five public inputs: the recursion control root split into two 128-bit halves, the
//! receipt claim digest split the same way, and the BN254 identity control id. The claim digest
//! commits to the guest image id and sha256 of its journal, so a valid seal means "this exact guest
//! ran to completion and wrote this journal". Same checks as risc0-groth16's `Verifier`; written
//! after paid-compute-tape's oracle/programs/pct_oracle/src/risc0_groth16.rs.

use anchor_lang::solana_program::hash::hashv;
use solana_bn254::prelude::{alt_bn128_addition, alt_bn128_multiplication, alt_bn128_pairing};

use crate::risc0_vk::{ALPHA_G1, BETA_G2, BN254_CONTROL_ID, CONTROL_ROOT, DELTA_G2, GAMMA_G2, IC};

pub const SEAL_LEN: usize = 256;

/// BN254 base field modulus, big-endian.
const FQ: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d, 0x97, 0x81, 0x6a, 0x91,
    0x68, 0x71, 0xca, 0x8d, 0x3c, 0x20, 0x8c, 0x16, 0xd8, 0x7c, 0xfd, 0x47,
];

/// sha256 tagged digest of a halted guest's post state (`SystemState { pc: 0, merkle_root: 0 }`).
const SYSTEM_STATE_ZERO_DIGEST: [u8; 32] = [
    0xa3, 0xac, 0xc2, 0x71, 0x17, 0x41, 0x89, 0x96, 0x34, 0x0b, 0x84, 0xe5, 0xa9, 0x0f, 0x3e, 0xf4, 0xc4, 0x9d, 0x22, 0xc7,
    0x9e, 0x44, 0xaa, 0xd8, 0x22, 0xec, 0x9c, 0x31, 0x3e, 0x1e, 0xb8, 0xe2,
];

#[derive(Debug, PartialEq, Eq)]
pub enum Groth16Error {
    Length,
    Syscall,
    Invalid,
}

/// -P for a G1 point (x, p - y); the point at infinity stays as is.
fn negate_g1(p: &[u8]) -> [u8; 64] {
    let mut out = [0u8; 64];
    out[..32].copy_from_slice(&p[..32]);
    if p[32..].iter().all(|b| *b == 0) {
        return out;
    }
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let d = FQ[i] as i16 - p[32 + i] as i16 - borrow;
        out[32 + i] = d.rem_euclid(256) as u8;
        borrow = (d < 0) as i16;
    }
    out
}

/// RISC Zero tagged-struct hash: sha256(sha256(tag) | down digests | data words LE | len(down) u16 LE).
fn tagged(tag: &[u8], down: &[&[u8; 32]], data: &[u32]) -> [u8; 32] {
    let tag_digest = hashv(&[tag]).to_bytes();
    let mut parts: Vec<&[u8]> = vec![&tag_digest];
    for d in down {
        parts.push(*d);
    }
    let data_bytes: Vec<u8> = data.iter().flat_map(|w| w.to_le_bytes()).collect();
    parts.push(&data_bytes);
    let len = (down.len() as u16).to_le_bytes();
    parts.push(&len);
    hashv(&parts).to_bytes()
}

/// risc0 `ReceiptClaim::ok(image_id, journal).digest()`: halted with exit code 0, no assumptions.
pub fn claim_digest(image_id: &[u8; 32], journal_digest: &[u8; 32]) -> [u8; 32] {
    let output = tagged(b"risc0.Output", &[journal_digest, &[0u8; 32]], &[]);
    tagged(b"risc0.ReceiptClaim", &[&[0u8; 32], image_id, &SYSTEM_STATE_ZERO_DIGEST, &output], &[0, 0])
}

/// A 32-byte digest as two field elements: little-endian halves, each as a big-endian scalar.
fn split_digest(d: &[u8; 32]) -> ([u8; 32], [u8; 32]) {
    let (mut lo, mut hi) = ([0u8; 32], [0u8; 32]);
    for i in 0..16 {
        lo[31 - i] = d[i];
        hi[31 - i] = d[16 + i];
    }
    (lo, hi)
}

/// Verifies a Groth16 `seal` for guest `image_id` and its `journal`.
pub fn verify(seal: &[u8], image_id: &[u8; 32], journal: &[u8]) -> Result<(), Groth16Error> {
    if seal.len() != SEAL_LEN {
        return Err(Groth16Error::Length);
    }
    let journal_digest = hashv(&[journal]).to_bytes();
    let claim = claim_digest(image_id, &journal_digest);
    let (a0, a1) = split_digest(&CONTROL_ROOT);
    let (c0, c1) = split_digest(&claim);
    let mut id = BN254_CONTROL_ID;
    id.reverse();
    let inputs: [&[u8; 32]; 5] = [&a0, &a1, &c0, &c1, &id];

    // vk_x = IC[0] + sum(input_i * IC[i + 1])
    let mut acc = IC[0];
    for (i, input) in inputs.iter().enumerate() {
        let mut mul = [0u8; 96];
        mul[..64].copy_from_slice(&IC[i + 1]);
        mul[64..].copy_from_slice(*input);
        let term = alt_bn128_multiplication(&mul).map_err(|_| Groth16Error::Syscall)?;
        let mut add = [0u8; 128];
        add[..64].copy_from_slice(&acc);
        add[64..].copy_from_slice(&term);
        acc.copy_from_slice(&alt_bn128_addition(&add).map_err(|_| Groth16Error::Syscall)?);
    }

    let (a, b, c) = (&seal[..64], &seal[64..192], &seal[192..256]);
    // e(-A, B) * e(alpha, beta) * e(vk_x, gamma) * e(C, delta) == 1
    let mut pairing = [0u8; 4 * 192];
    let pairs: [(&[u8], &[u8]); 4] = [(&negate_g1(a), b), (&ALPHA_G1, &BETA_G2), (&acc, &GAMMA_G2), (c, &DELTA_G2)];
    for (i, (g1, g2)) in pairs.iter().enumerate() {
        pairing[i * 192..i * 192 + 64].copy_from_slice(g1);
        pairing[i * 192 + 64..(i + 1) * 192].copy_from_slice(g2);
    }
    let out = alt_bn128_pairing(&pairing).map_err(|_| Groth16Error::Syscall)?;
    if out.len() == 32 && out[31] == 1 && out[..31].iter().all(|b| *b == 0) {
        Ok(())
    } else {
        Err(Groth16Error::Invalid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Test-root guest, synthetic quote bound to a statement with a payout (plumbline/zk/proofs).
    const PROOF: &str = include_str!("../../tests/fixtures/synthetic-payout-groth16.json");

    fn field(name: &str) -> Vec<u8> {
        let at = PROOF.find(&format!("\"{name}\": \"0x")).unwrap() + name.len() + 7;
        let hex = &PROOF[at..at + PROOF[at..].find('"').unwrap()];
        (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect()
    }

    fn id() -> [u8; 32] {
        field("imageId").try_into().unwrap()
    }

    #[test]
    fn claim_digest_matches_risc0() {
        let jd: [u8; 32] = field("journalDigest").try_into().unwrap();
        assert_eq!(hashv(&[&field("journal")]).to_bytes(), jd);
        assert_eq!(claim_digest(&id(), &jd).to_vec(), field("claimDigest"));
    }

    #[test]
    fn real_proof_verifies_and_tampering_fails() {
        let (seal, journal) = (field("seal"), field("journal"));
        assert_eq!(verify(&seal, &id(), &journal), Ok(()));
        let mut j = journal.clone();
        j[256] ^= 1;
        assert_eq!(verify(&seal, &id(), &j), Err(Groth16Error::Invalid));
        let mut other = id();
        other[0] ^= 1;
        assert_eq!(verify(&seal, &other, &journal), Err(Groth16Error::Invalid));
        assert_eq!(verify(&seal[..255], &id(), &journal), Err(Groth16Error::Length));
    }
}
