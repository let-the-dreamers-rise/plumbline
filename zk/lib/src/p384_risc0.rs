//! ECDSA P-384 verification on RISC Zero's 384-bit elliptic-curve and modular-arithmetic
//! accelerators (risc0-bigint2). Inside the RISC Zero guest this replaces the software `p384`
//! crate, which costs tens of millions of cycles per signature. Words are little-endian u32s.

use risc0_bigint2::{
    ec::{AffinePoint, Secp384r1Curve},
    field::{modinv_384, modmul_384},
};

type Point = AffinePoint<12, Secp384r1Curve>;

const N_BE: [u8; 48] = hex48("ffffffffffffffffffffffffffffffffffffffffffffffffc7634d81f4372ddf581a0db248b0a77aecec196accc52973");
const GX_BE: [u8; 48] = hex48("aa87ca22be8b05378eb1c71ef320ad746e1d3b628ba79b9859f741e082542a385502f25dbf55296c3a545e3872760ab7");
const GY_BE: [u8; 48] = hex48("3617de4a96262c6f5d9e98bf9292dc29f8f41dbd289a147ce9da3113b5f0b8c00a60b1ce1d7e819d7a431d7c90ea0e5f");

const fn nib(c: u8) -> u8 {
    match c {
        b'0'..=b'9' => c - b'0',
        _ => c - b'a' + 10,
    }
}

const fn hex48(s: &str) -> [u8; 48] {
    let b = s.as_bytes();
    let mut out = [0u8; 48];
    let mut i = 0;
    while i < 48 {
        out[i] = nib(b[2 * i]) << 4 | nib(b[2 * i + 1]);
        i += 1;
    }
    out
}

/// Big-endian 48 bytes to 12 little-endian u32 words.
fn words(be: &[u8]) -> [u32; 12] {
    let mut w = [0u32; 12];
    for (i, word) in w.iter_mut().enumerate() {
        let at = 48 - 4 * (i + 1);
        *word = u32::from_be_bytes([be[at], be[at + 1], be[at + 2], be[at + 3]]);
    }
    w
}

/// a < b for little-endian word arrays.
fn less(a: &[u32; 12], b: &[u32; 12]) -> bool {
    for i in (0..12).rev() {
        if a[i] != b[i] {
            return a[i] < b[i];
        }
    }
    false
}

fn sub(a: &[u32; 12], b: &[u32; 12]) -> [u32; 12] {
    let mut out = [0u32; 12];
    let mut borrow = 0u64;
    for i in 0..12 {
        let d = (a[i] as u64).wrapping_sub(b[i] as u64).wrapping_sub(borrow);
        out[i] = d as u32;
        borrow = (d >> 63) & 1;
    }
    out
}

fn is_zero(a: &[u32; 12]) -> bool {
    a.iter().all(|w| *w == 0)
}

/// Verifies `sig` (r || s, 96 bytes big-endian) over `digest` (SHA-384, 48 bytes) with the
/// uncompressed SEC1 public key `pubkey` (0x04 || x || y). The key must already be trusted
/// (pinned, or taken from a certificate whose signature was verified first).
pub fn verify_prehashed(pubkey: &[u8], digest: &[u8; 48], sig: &[u8]) -> bool {
    if pubkey.len() != 97 || pubkey[0] != 4 || sig.len() != 96 {
        return false;
    }
    let n = words(&N_BE);
    let r = words(&sig[..48]);
    let s = words(&sig[48..]);
    if is_zero(&r) || is_zero(&s) || !less(&r, &n) || !less(&s, &n) {
        return false;
    }
    // z < 2^384 < 2n, so one subtraction reduces it mod n.
    let mut z = words(digest);
    if !less(&z, &n) {
        z = sub(&z, &n);
    }
    let mut w = [0u32; 12];
    modinv_384(&s, &n, &mut w);
    let (mut u1, mut u2) = ([0u32; 12], [0u32; 12]);
    modmul_384(&z, &w, &n, &mut u1);
    modmul_384(&r, &w, &n, &mut u2);

    let g = Point::new_unchecked(words(&GX_BE), words(&GY_BE));
    let q = Point::new_unchecked(words(&pubkey[1..49]), words(&pubkey[49..97]));
    let (mut p1, mut p2, mut sum) = (Point::IDENTITY, Point::IDENTITY, Point::IDENTITY);
    g.mul(&u1, &mut p1);
    q.mul(&u2, &mut p2);
    p1.add(&p2, &mut sum);
    let Some([x, _]) = sum.as_u32s() else { return false };
    let mut x = *x;
    if !less(&x, &n) {
        x = sub(&x, &n);
    }
    x == r
}
