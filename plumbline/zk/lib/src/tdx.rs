//! Intel TDX v4 DCAP quote, structural checks: the PCK certificate chain ends in the pinned root
//! (Intel SGX Root CA), the Quoting Enclave report is signed by the PCK leaf, the QE report binds
//! the attestation key, and the quote (header + TD report) is signed by that key.
//! Same checks as sealed-eval/tdxq.py `verify_quote`, written after paid-compute-tape zk/lib/src/tdx.rs.
//!
//! Not checked (needs Intel collateral fetched off-box): TCB info / TCB status, QE identity,
//! CRLs and validity windows.

use p256::ecdsa::{signature::Verifier, Signature, VerifyingKey};
use sha2::{Digest, Sha256};
use x509_cert::{
    der::{Decode, Encode},
    Certificate,
};

/// Intel SGX Root CA (DER), sha256 44a0196b2b99f889b8e149e95b807a350e7424964399e885a7cbb8ccfab674d3.
pub const INTEL_SGX_ROOT_DER: &[u8] = include_bytes!("intel_sgx_root.der");
#[cfg(feature = "test-root")]
pub const PINNED_ROOT_DER: &[u8] = include_bytes!("../../fixtures/test-root.der");
#[cfg(not(feature = "test-root"))]
pub const PINNED_ROOT_DER: &[u8] = INTEL_SGX_ROOT_DER;

const HEADER_LEN: usize = 48;
const TD_REPORT_LEN: usize = 584;
const SIGNED_LEN: usize = HEADER_LEN + TD_REPORT_LEN;
const ECDSA_WITH_SHA256: &str = "1.2.840.10045.4.3.2";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TdxAttestation {
    pub mr_td: [u8; 48],
    /// sha256(rtmr0 || rtmr1 || rtmr2 || rtmr3)
    pub rtmrs_hash: [u8; 32],
    pub rtmr3: [u8; 48],
    pub report_data: [u8; 64],
    pub tee_tcb_svn: [u8; 16],
}

#[derive(Debug, PartialEq, Eq)]
pub enum TdxError {
    Format(&'static str),
    BadCert(usize),
    UntrustedRoot,
    IssuerMismatch(usize),
    BadCertSignature(usize),
    BadQeSignature,
    AttestationKeyNotBound,
    BadQuoteSignature,
}

fn u16_at(b: &[u8], at: usize) -> Result<usize, TdxError> {
    Ok(u16::from_le_bytes(b.get(at..at + 2).ok_or(TdxError::Format("truncated"))?.try_into().unwrap()) as usize)
}

fn u32_at(b: &[u8], at: usize) -> Result<usize, TdxError> {
    Ok(u32::from_le_bytes(b.get(at..at + 4).ok_or(TdxError::Format("truncated"))?.try_into().unwrap()) as usize)
}

fn raw_sig(rs: &[u8]) -> Result<Signature, TdxError> {
    Signature::from_slice(rs).map_err(|_| TdxError::Format("signature"))
}

fn key_of(cert: &Certificate, i: usize) -> Result<VerifyingKey, TdxError> {
    VerifyingKey::from_sec1_bytes(cert.tbs_certificate.subject_public_key_info.subject_public_key.raw_bytes()).map_err(|_| TdxError::BadCert(i))
}

pub fn pem_chain(pem: &str) -> Result<Vec<Vec<u8>>, TdxError> {
    use base64::Engine;
    let mut out = Vec::new();
    let mut rest = pem;
    while let Some(start) = rest.find("-----BEGIN CERTIFICATE-----") {
        let body = &rest[start + 27..];
        let end = body.find("-----END CERTIFICATE-----").ok_or(TdxError::Format("pem"))?;
        let b64: String = body[..end].chars().filter(|c| !c.is_whitespace()).collect();
        out.push(base64::engine::general_purpose::STANDARD.decode(b64).map_err(|_| TdxError::Format("pem"))?);
        rest = &body[end..];
    }
    Ok(out)
}

/// Verifies a TDX v4 quote against `root_der` (trailing bytes after the signature data are ignored).
pub fn verify_tdx_with_root(quote: &[u8], root_der: &[u8]) -> Result<TdxAttestation, TdxError> {
    if u16_at(quote, 0)? != 4 || u16_at(quote, 2)? != 2 || u32_at(quote, 4)? != 0x81 {
        return Err(TdxError::Format("not a TDX v4 quote with an ECDSA P-256 attestation key"));
    }
    let sig_len = u32_at(quote, SIGNED_LEN)?;
    let sd = quote.get(SIGNED_LEN + 4..SIGNED_LEN + 4 + sig_len).ok_or(TdxError::Format("signature data"))?;
    let (quote_sig, att_key) = (sd.get(..64).ok_or(TdxError::Format("sig"))?, sd.get(64..128).ok_or(TdxError::Format("key"))?);
    if u16_at(sd, 128)? != 6 {
        return Err(TdxError::Format("expected QE report certification data"));
    }
    let cd = sd.get(134..134 + u32_at(sd, 130)?).ok_or(TdxError::Format("cert data"))?;
    let qe_report = cd.get(..384).ok_or(TdxError::Format("qe report"))?;
    let qe_sig = cd.get(384..448).ok_or(TdxError::Format("qe sig"))?;
    let auth_len = u16_at(cd, 448)?;
    let auth = cd.get(450..450 + auth_len).ok_or(TdxError::Format("qe auth"))?;
    if u16_at(cd, 450 + auth_len)? != 5 {
        return Err(TdxError::Format("expected PCK certificate chain"));
    }
    let pem_len = u32_at(cd, 452 + auth_len)?;
    let pem = cd.get(456 + auth_len..456 + auth_len + pem_len).ok_or(TdxError::Format("pck chain"))?;
    let pem = core::str::from_utf8(pem).map_err(|_| TdxError::Format("pck chain"))?;
    let chain = pem_chain(pem)?;

    // 1. PCK leaf -> intermediate CA(s) -> pinned root, byte for byte.
    if chain.len() < 2 || chain.last().map(|d| d.as_slice()) != Some(root_der) {
        return Err(TdxError::UntrustedRoot);
    }
    let certs: Vec<Certificate> =
        chain.iter().enumerate().map(|(i, d)| Certificate::from_der(d).map_err(|_| TdxError::BadCert(i))).collect::<Result<_, _>>()?;
    for i in 0..certs.len() - 1 {
        let (child, parent) = (&certs[i], &certs[i + 1]);
        if child.tbs_certificate.issuer != parent.tbs_certificate.subject {
            return Err(TdxError::IssuerMismatch(i));
        }
        if child.signature_algorithm.oid.to_string() != ECDSA_WITH_SHA256 {
            return Err(TdxError::BadCert(i));
        }
        let tbs = child.tbs_certificate.to_der().map_err(|_| TdxError::BadCert(i))?;
        let sig = Signature::from_der(child.signature.raw_bytes()).map_err(|_| TdxError::BadCertSignature(i))?;
        key_of(parent, i + 1)?.verify(&tbs, &sig).map_err(|_| TdxError::BadCertSignature(i))?;
    }

    // 2. QE report signed by the PCK leaf.
    key_of(&certs[0], 0)?.verify(qe_report, &raw_sig(qe_sig)?).map_err(|_| TdxError::BadQeSignature)?;
    // 3. QE report_data[0..32] = sha256(attestation key || QE auth data).
    let mut h = Sha256::new();
    h.update(att_key);
    h.update(auth);
    if qe_report[320..352] != h.finalize()[..] {
        return Err(TdxError::AttestationKeyNotBound);
    }
    // 4. Quote header + TD report signed by the attestation key.
    let mut sec1 = [0u8; 65];
    sec1[0] = 4;
    sec1[1..].copy_from_slice(att_key);
    let key = VerifyingKey::from_sec1_bytes(&sec1).map_err(|_| TdxError::Format("attestation key"))?;
    key.verify(&quote[..SIGNED_LEN], &raw_sig(quote_sig)?).map_err(|_| TdxError::BadQuoteSignature)?;

    let body = &quote[HEADER_LEN..SIGNED_LEN];
    Ok(TdxAttestation {
        mr_td: body[136..184].try_into().unwrap(),
        rtmrs_hash: Sha256::digest(&body[328..520]).into(),
        rtmr3: body[472..520].try_into().unwrap(),
        report_data: body[520..584].try_into().unwrap(),
        tee_tcb_svn: body[..16].try_into().unwrap(),
    })
}

pub fn verify_tdx(quote: &[u8]) -> Result<TdxAttestation, TdxError> {
    verify_tdx_with_root(quote, PINNED_ROOT_DER)
}
