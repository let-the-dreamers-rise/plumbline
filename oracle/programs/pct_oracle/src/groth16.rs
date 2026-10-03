//! SP1 v6 Groth16 verification over Solana's alt_bn128 syscalls.
//!
//! An SP1 Groth16 proof is `vk prefix (4) | exit code (32) | vk root (32) | proof nonce (32) |
//! A (64) | B (128) | C (64)`, points uncompressed big-endian as gnark writes them. The circuit
//! has five public inputs: program vkey hash, sha256(public values) with the top 3 bits cleared,
//! exit code, vk root and proof nonce. Same checks as sp1-verifier's `Groth16Verifier`.

#![allow(deprecated)]

use solana_bn254::prelude::{alt_bn128_addition, alt_bn128_multiplication, alt_bn128_pairing};
use solana_sha256_hasher::hashv;

use crate::sp1_vk::{ALPHA_G1, BETA_G2, DELTA_G2, GAMMA_G2, IC, VK_PREFIX, VK_ROOT};

pub const PROOF_LEN: usize = 4 + 96 + 256;

/// BN254 base field modulus, big-endian.
const FQ: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d, 0x97, 0x81, 0x6a, 0x91,
    0x68, 0x71, 0xca, 0x8d, 0x3c, 0x20, 0x8c, 0x16, 0xd8, 0x7c, 0xfd, 0x47,
];

#[derive(Debug, PartialEq, Eq)]
pub enum Groth16Error {
    Length,
    WrongCircuit,
    WrongVkRoot,
    NonZeroExit,
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

/// The commitment the circuit binds to: sha256 of the public values, reduced below 2^253.
pub fn public_values_digest(public_values: &[u8]) -> [u8; 32] {
    let mut d = hashv(&[public_values]).to_bytes();
    d[0] &= 0x1f;
    d
}

/// Verifies `proof` for the program with `program_vkey` (SP1's bytes32 vkey hash) and these
/// public values.
pub fn verify(proof: &[u8], program_vkey: &[u8; 32], public_values: &[u8]) -> Result<(), Groth16Error> {
    if proof.len() != PROOF_LEN {
        return Err(Groth16Error::Length);
    }
    if proof[..4] != VK_PREFIX {
        return Err(Groth16Error::WrongCircuit);
    }
    let exit_code: &[u8] = &proof[4..36];
    let vk_root: &[u8] = &proof[36..68];
    let nonce: &[u8] = &proof[68..100];
    if vk_root != VK_ROOT {
        return Err(Groth16Error::WrongVkRoot);
    }
    if exit_code.iter().any(|b| *b != 0) {
        return Err(Groth16Error::NonZeroExit);
    }
    let digest = public_values_digest(public_values);
    let inputs: [&[u8]; 5] = [program_vkey, &digest, exit_code, vk_root, nonce];

    // vk_x = IC[0] + sum(input_i * IC[i + 1])
    let mut acc = IC[0];
    for (i, input) in inputs.iter().enumerate() {
        let mut mul = [0u8; 96];
        mul[..64].copy_from_slice(&IC[i + 1]);
        mul[64..].copy_from_slice(input);
        let term = alt_bn128_multiplication(&mul).map_err(|_| Groth16Error::Syscall)?;
        let mut add = [0u8; 128];
        add[..64].copy_from_slice(&acc);
        add[64..].copy_from_slice(&term);
        acc.copy_from_slice(&alt_bn128_addition(&add).map_err(|_| Groth16Error::Syscall)?);
    }

    let body = &proof[100..];
    let (a, b, c) = (&body[..64], &body[64..192], &body[192..256]);
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
