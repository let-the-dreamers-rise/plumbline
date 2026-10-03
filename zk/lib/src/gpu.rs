//! NVIDIA Hopper GPU attestation: an SPDM GET_MEASUREMENTS request/response signed by the GPU's
//! own key, plus the certificate chain that ties that key to NVIDIA's Device Identity CA.
//! Mirrors NVIDIA's local_gpu_verifier (nvtrust): same byte layout, same signed bytes, same root.

use p384::ecdsa::{signature::Verifier, Signature, VerifyingKey};
use sha2::{Digest, Sha256};
use x509_cert::{
    der::{Decode, Encode},
    Certificate,
};

/// NVIDIA Device Identity CA, the root every H100 chain ends in (nvtrust verifier_device_root.pem).
pub const NVIDIA_DEVICE_ROOT_PEM: &str = include_str!("nvidia_device_root.pem");

/// sha256 of NVIDIA's shared upper chain for Hopper (Provisioner ICA 1, GH100 Identity, Device
/// Identity CA). Every link of this chain is verified natively in `pinned_upper_chain_verifies`;
/// when a GPU presents exactly these certificates the guest skips re-verifying their signatures
/// (the costliest part of the proof). Any other upper chain is verified link by link.
pub const PINNED_UPPER_CHAINS: &[[[u8; 32]; 3]] = &[[
    hex32("b20040bdc80f6961a2b9c9493cb804b61f41f1008f14ba80010039f4dd467ee9"),
    hex32("24713555df10fcfd2cb8941e94a064edd1e14e028be12c6523b2136694bbe5f5"),
    hex32("102bf659d5419614c9d8e6aecebc80454eb26b1df6a769ac720b9a690b167b48"),
]];

const fn nib(c: u8) -> u8 {
    match c {
        b'0'..=b'9' => c - b'0',
        _ => c - b'a' + 10,
    }
}

const fn hex32(s: &str) -> [u8; 32] {
    let b = s.as_bytes();
    let mut out = [0u8; 32];
    let mut i = 0;
    while i < 32 {
        out[i] = nib(b[2 * i]) << 4 | nib(b[2 * i + 1]);
        i += 1;
    }
    out
}

const REQUEST_LEN: usize = 37;
const SIGNATURE_LEN: usize = 96;
const ECDSA_WITH_SHA384: &str = "1.2.840.10045.4.3.3";
const SERIAL_NUMBER_ATTR: &str = "2.5.4.5";
const COMMON_NAME_ATTR: &str = "2.5.4.3";
const OPAQUE_FWID: u16 = 20;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GpuAttestation {
    /// sha256 of the GPU's BROM certificate serial (a per-chip id burned in at manufacture).
    pub chip_id: [u8; 32],
    /// Nonce the verifier put in the request; the report is only fresh if this nonce was fresh.
    pub nonce: [u8; 32],
    /// sha256 of the signed measurement record (firmware, VBIOS, driver state).
    pub measurements: [u8; 32],
    /// Common name of the leaf certificate, e.g. "GH100 A01 GSP FMC LF".
    pub model: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum GpuError {
    BadPem,
    BadCert(usize),
    ChainTooShort,
    UntrustedRoot,
    IssuerMismatch(usize),
    BadCertSignature(usize),
    UnsupportedAlgorithm(usize),
    BadKey(usize),
    NotH100,
    BadReport(&'static str),
    BadReportSignature,
    FwidMismatch,
}

/// Splits a PEM bundle into DER certificates, in file order.
pub fn pem_chain(pem: &str) -> Result<Vec<Vec<u8>>, GpuError> {
    use base64::Engine;
    let mut out = Vec::new();
    let mut rest = pem;
    while let Some(start) = rest.find("-----BEGIN CERTIFICATE-----") {
        let body = &rest[start + 27..];
        let end = body.find("-----END CERTIFICATE-----").ok_or(GpuError::BadPem)?;
        let b64: String = body[..end].chars().filter(|c| !c.is_whitespace()).collect();
        out.push(base64::engine::general_purpose::STANDARD.decode(b64).map_err(|_| GpuError::BadPem)?);
        rest = &body[end..];
    }
    Ok(out)
}

fn key_of(cert: &Certificate, i: usize) -> Result<VerifyingKey, GpuError> {
    let spki = &cert.tbs_certificate.subject_public_key_info;
    VerifyingKey::from_sec1_bytes(spki.subject_public_key.raw_bytes()).map_err(|_| GpuError::BadKey(i))
}

/// ECDSA P-384 / SHA-384 over `msg` with `cert`'s key; `sig` is r || s. In the RISC Zero guest
/// this runs on the 384-bit curve accelerator, elsewhere on the `p384` crate.
fn verify_with(cert: &Certificate, i: usize, msg: &[u8], sig: &Signature) -> Result<bool, GpuError> {
    #[cfg(feature = "risc0")]
    {
        use sha2::Sha384;
        let key = key_of(cert, i)?.to_encoded_point(false);
        let digest: [u8; 48] = Sha384::digest(msg).into();
        Ok(crate::p384_risc0::verify_prehashed(key.as_bytes(), &digest, &sig.to_bytes()))
    }
    #[cfg(not(feature = "risc0"))]
    {
        Ok(key_of(cert, i)?.verify(msg, sig).is_ok())
    }
}

fn attr(cert: &Certificate, oid: &str) -> Option<Vec<u8>> {
    for rdn in cert.tbs_certificate.subject.0.iter() {
        for atv in rdn.0.iter() {
            if atv.oid.to_string() == oid {
                return Some(atv.value.value().to_vec());
            }
        }
    }
    None
}

/// Walks the opaque data (type u16 | size u16 | bytes) after the measurement record.
fn opaque_field(opaque: &[u8], wanted: u16) -> Option<&[u8]> {
    let mut i = 0;
    while i + 4 <= opaque.len() {
        let ty = u16::from_le_bytes([opaque[i], opaque[i + 1]]);
        let len = u16::from_le_bytes([opaque[i + 2], opaque[i + 3]]) as usize;
        let data = opaque.get(i + 4..i + 4 + len)?;
        if ty == wanted {
            return Some(data);
        }
        i += 4 + len;
    }
    None
}

/// Verifies the chain (leaf first, root last) up to the pinned NVIDIA root, then the report's
/// signature with the leaf key. Returns what the report attests to.
pub fn verify_gpu(report: &[u8], chain_der: &[Vec<u8>]) -> Result<GpuAttestation, GpuError> {
    let root = pem_chain(NVIDIA_DEVICE_ROOT_PEM)?.pop().ok_or(GpuError::BadPem)?;
    if chain_der.len() < 3 {
        return Err(GpuError::ChainTooShort);
    }
    if chain_der.last().unwrap() != &root {
        return Err(GpuError::UntrustedRoot);
    }
    let certs: Vec<Certificate> =
        chain_der.iter().enumerate().map(|(i, d)| Certificate::from_der(d).map_err(|_| GpuError::BadCert(i))).collect::<Result<_, _>>()?;

    // Fast path: a known, already verified upper chain only needs the device's own two links.
    let upper: Vec<[u8; 32]> = chain_der.iter().rev().take(3).rev().map(|d| Sha256::digest(d).into()).collect();
    let pinned = chain_der.len() == 5 && PINNED_UPPER_CHAINS.iter().any(|p| p[..] == upper[..]);
    let links = if pinned { 2 } else { certs.len() - 1 };
    for i in 0..links {
        let (child, parent) = (&certs[i], &certs[i + 1]);
        if child.tbs_certificate.issuer != parent.tbs_certificate.subject {
            return Err(GpuError::IssuerMismatch(i));
        }
        if child.signature_algorithm.oid.to_string() != ECDSA_WITH_SHA384 {
            return Err(GpuError::UnsupportedAlgorithm(i));
        }
        let tbs = child.tbs_certificate.to_der().map_err(|_| GpuError::BadCert(i))?;
        let sig = Signature::from_der(child.signature.raw_bytes()).map_err(|_| GpuError::BadCertSignature(i))?;
        if !verify_with(parent, i + 1, &tbs, &sig)? {
            return Err(GpuError::BadCertSignature(i));
        }
    }

    let leaf = &certs[0];
    let model = attr(leaf, COMMON_NAME_ATTR).map(|v| String::from_utf8_lossy(&v).into_owned()).unwrap_or_default();
    if !model.starts_with("GH100") {
        return Err(GpuError::NotH100);
    }

    // Request: SPDM header (4) | nonce (32) | slot (1). Response: header (4) | blocks (1) |
    // record length (3) | record | nonce (32) | opaque length (2) | opaque | signature (96).
    if report.len() <= REQUEST_LEN + 8 + 32 + 2 + SIGNATURE_LEN {
        return Err(GpuError::BadReport("too short"));
    }
    let (request, response) = report.split_at(REQUEST_LEN);
    if request[1] != 0xE0 || response[1] != 0x60 {
        return Err(GpuError::BadReport("not GET_MEASUREMENTS"));
    }
    let nonce: [u8; 32] = request[4..36].try_into().unwrap();
    let record_len = u32::from_le_bytes([response[5], response[6], response[7], 0]) as usize;
    let record = response.get(8..8 + record_len).ok_or(GpuError::BadReport("record"))?;
    let after = 8 + record_len + 32;
    let opaque_len = u16::from_le_bytes([*response.get(after).ok_or(GpuError::BadReport("opaque"))?, response[after + 1]]) as usize;
    let opaque = response.get(after + 2..after + 2 + opaque_len).ok_or(GpuError::BadReport("opaque"))?;
    if after + 2 + opaque_len + SIGNATURE_LEN != response.len() {
        return Err(GpuError::BadReport("length"));
    }

    let sig = Signature::from_slice(&report[report.len() - SIGNATURE_LEN..]).map_err(|_| GpuError::BadReportSignature)?;
    if !verify_with(leaf, 0, &report[..report.len() - SIGNATURE_LEN], &sig)? {
        return Err(GpuError::BadReportSignature);
    }

    // The firmware id the GPU reports must be the one its leaf certificate was issued for.
    let fwid = opaque_field(opaque, OPAQUE_FWID).ok_or(GpuError::FwidMismatch)?;
    let leaf_der = &chain_der[0];
    if fwid.is_empty() || !leaf_der.windows(fwid.len()).any(|w| w == fwid) {
        return Err(GpuError::FwidMismatch);
    }

    let brom_serial = attr(&certs[1], SERIAL_NUMBER_ATTR).ok_or(GpuError::BadCert(1))?;
    Ok(GpuAttestation {
        chip_id: Sha256::digest(&brom_serial).into(),
        nonce,
        measurements: Sha256::digest(record).into(),
        model,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::fixtures::sample_gpu as sample;

    #[test]
    fn nvidia_sample_report_verifies() {
        let (report, chain) = sample();
        let a = verify_gpu(&report, &chain).unwrap();
        assert_eq!(a.model, "GH100 A01 GSP FMC LF");
        println!("chip {} nonce {}", hex::encode(a.chip_id), hex::encode(a.nonce));
    }

    #[test]
    fn tampered_report_is_refused() {
        let (mut report, chain) = sample();
        report[60] ^= 1;
        assert_eq!(verify_gpu(&report, &chain), Err(GpuError::BadReportSignature));
    }

    #[test]
    fn tampered_nonce_is_refused() {
        let (mut report, chain) = sample();
        report[10] ^= 1;
        assert_eq!(verify_gpu(&report, &chain), Err(GpuError::BadReportSignature));
    }

    #[test]
    fn pinned_upper_chain_verifies() {
        let (_, chain) = sample();
        for pin in PINNED_UPPER_CHAINS {
            let upper: Vec<Vec<u8>> = chain.iter().rev().take(3).rev().cloned().collect();
            let hashes: Vec<[u8; 32]> = upper.iter().map(|d| Sha256::digest(d).into()).collect();
            assert_eq!(hashes[..], pin[..]);
            let certs: Vec<Certificate> = upper.iter().map(|d| Certificate::from_der(d).unwrap()).collect();
            for i in 0..2 {
                let tbs = certs[i].tbs_certificate.to_der().unwrap();
                let sig = Signature::from_der(certs[i].signature.raw_bytes()).unwrap();
                key_of(&certs[i + 1], i + 1).unwrap().verify(&tbs, &sig).unwrap();
            }
        }
    }

    #[test]
    fn unpinned_chain_is_verified_link_by_link() {
        let (report, mut chain) = sample();
        // Same certificates with one byte of the identity CA's signature flipped: no longer
        // matches the pin, so the full walk runs and catches it.
        let n = chain[3].len();
        chain[3][n - 5] ^= 1;
        assert!(matches!(verify_gpu(&report, &chain), Err(GpuError::BadCertSignature(_)) | Err(GpuError::BadCert(_))));
    }

    #[test]
    fn chain_must_end_in_nvidia_root() {
        let (report, mut chain) = sample();
        chain.pop();
        assert_eq!(verify_gpu(&report, &chain), Err(GpuError::UntrustedRoot));
    }

    #[test]
    fn forged_intermediate_is_refused() {
        let (report, mut chain) = sample();
        let n = chain[2].len();
        chain[2][n - 10] ^= 1; // corrupt the provisioner CA's signature
        assert!(matches!(verify_gpu(&report, &chain), Err(GpuError::BadCertSignature(_)) | Err(GpuError::BadCert(_))));
    }
}
