//! Private covenant check: a period's worth of Reclaim revenue claims is verified, deduplicated and
//! summed inside the zkVM; only the coverage ratio and PASS/WATCH leave it. Same claim rules as
//! the onchain `submit_revenue` (oracle/programs/pct_oracle/src/instructions/lending.rs).

use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use tiny_keccak::{Hasher, Keccak};

pub fn keccak(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Keccak::v256();
    for p in parts {
        h.update(p);
    }
    let mut out = [0u8; 32];
    h.finalize(&mut out);
    out
}

/// One Reclaim claim as zkFetch returns it, with every attestor signature it carries.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Claim {
    pub provider: String,
    pub parameters: String,
    pub context: String,
    pub owner: String,
    pub timestamp_s: u32,
    pub epoch: u32,
    /// 65-byte (r, s, v) signatures, one per attestor that signed.
    pub signatures: Vec<Vec<u8>>,
}

/// Loan terms the proof is checked against; their hash is a public output the program compares.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Terms {
    /// keccak(account id), the loan's operator key.
    pub operator_key: [u8; 32],
    pub currency: [u8; 3],
    pub period_s: u32,
    pub debt_service_micro: u64,
    pub min_coverage_bps: u32,
    pub covenant_periods: u8,
    /// Last period of the covenant window.
    pub as_of_period: u32,
}

impl Terms {
    pub fn hash(&self) -> [u8; 32] {
        keccak(&[
            &self.operator_key,
            &self.currency,
            &self.period_s.to_le_bytes(),
            &self.debt_service_micro.to_le_bytes(),
            &self.min_coverage_bps.to_le_bytes(),
            &[self.covenant_periods],
            &self.as_of_period.to_le_bytes(),
        ])
    }
}

/// Who may sign and how many must agree; hashed into the public output.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AttestorSet {
    pub threshold: u8,
    pub attestors: Vec<[u8; 20]>,
}

impl AttestorSet {
    pub fn hash(&self) -> [u8; 32] {
        let flat: Vec<u8> = self.attestors.iter().flatten().copied().collect();
        keccak(&[&[self.threshold], &flat])
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CovenantResult {
    pub revenue_micro: u64,
    pub coverage_bps: u64,
    pub pass: bool,
    pub claims: u32,
}

#[derive(Debug, PartialEq, Eq)]
pub enum RevenueError {
    WrongSource(usize),
    TooFewSignatures(usize),
    BadOwner(usize),
    WrongOperator(usize),
    Currency(usize),
    BadNumber(usize),
    MissingParam(usize),
    Duplicate(usize),
    OutsideWindow(usize),
    BadTerms,
}

fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn recover(digest: &[u8; 32], sig: &[u8]) -> Option<[u8; 20]> {
    if sig.len() != 65 {
        return None;
    }
    let v = match sig[64] {
        27 | 28 => sig[64] - 27,
        0 | 1 => sig[64],
        _ => return None,
    };
    let signature = Signature::from_slice(&sig[..64]).ok()?;
    let key = VerifyingKey::recover_from_prehash(digest, &signature, RecoveryId::from_byte(v)?).ok()?;
    let point = key.to_encoded_point(false);
    let hash = keccak(&[&point.as_bytes()[1..]]);
    hash[12..].try_into().ok()
}

fn json_string(bytes: &[u8], at: usize) -> Option<(&[u8], usize)> {
    if bytes.get(at) != Some(&b'"') {
        return None;
    }
    let mut i = at + 1;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 2,
            b'"' => return Some((&bytes[at + 1..i], i + 1)),
            _ => i += 1,
        }
    }
    None
}

fn expect(bytes: &[u8], at: usize, lit: &[u8]) -> Option<usize> {
    (bytes.len() >= at + lit.len() && &bytes[at..at + lit.len()] == lit).then_some(at + lit.len())
}

/// Same structural walk as the program's `extract_param`; escaped values are refused.
pub fn extract_param<'a>(context: &'a [u8], name: &str) -> Option<&'a [u8]> {
    let i = expect(context, 0, br#"{"contextAddress":"#)?;
    let (_, i) = json_string(context, i)?;
    let i = expect(context, i, br#","contextMessage":"#)?;
    let (_, i) = json_string(context, i)?;
    let mut i = expect(context, i, br#","extractedParameters":{"#)?;
    loop {
        let (key, next) = json_string(context, i)?;
        let next = expect(context, next, b":")?;
        let (value, next) = json_string(context, next)?;
        if key == name.as_bytes() {
            return (!value.contains(&b'\\')).then_some(value);
        }
        match context.get(next) {
            Some(b',') => i = next + 1,
            _ => return None,
        }
    }
}

/// Strict decimal (up to 6 places) to millionths.
pub fn parse_micro(raw: &[u8]) -> Option<u64> {
    let mut parts = raw.splitn(2, |b| *b == b'.');
    let whole = parts.next().unwrap_or_default();
    let frac = parts.next().unwrap_or_default();
    let digits = |s: &[u8]| s.iter().all(u8::is_ascii_digit);
    if whole.is_empty() || whole.len() > 12 || frac.len() > 6 || !digits(whole) || !digits(frac) {
        return None;
    }
    if raw.contains(&b'.') && frac.is_empty() {
        return None;
    }
    let n = |s: &[u8]| s.iter().fold(0u64, |a, d| a * 10 + (d - b'0') as u64);
    Some(n(whole) * 1_000_000 + n(frac) * 10u64.pow(6 - frac.len() as u32))
}

/// Verifies every claim and runs the covenant over the window ending at `terms.as_of_period`.
/// `params_hash` pins the one revenue source (keccak of the zkFetch parameters) all claims use.
pub fn check_covenant(
    claims: &[Claim],
    attestors: &AttestorSet,
    params_hash: &[u8; 32],
    terms: &Terms,
) -> Result<CovenantResult, RevenueError> {
    let window = terms.covenant_periods.clamp(1, 13) as u32;
    if terms.period_s == 0 || terms.debt_service_micro == 0 || attestors.threshold == 0 {
        return Err(RevenueError::BadTerms);
    }
    let first = terms.as_of_period.saturating_sub(window - 1);
    let mut seen: Vec<[u8; 32]> = Vec::with_capacity(claims.len());
    let mut revenue: u128 = 0;

    for (i, c) in claims.iter().enumerate() {
        if keccak(&[c.parameters.as_bytes()]) != *params_hash {
            return Err(RevenueError::WrongSource(i));
        }
        let owner_ok = c.owner.len() == 42
            && c.owner.starts_with("0x")
            && c.owner[2..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        if !owner_ok {
            return Err(RevenueError::BadOwner(i));
        }
        let identifier = keccak(&[c.provider.as_bytes(), b"\n", c.parameters.as_bytes(), b"\n", c.context.as_bytes()]);
        let message = format!("0x{}\n{}\n{}\n{}", hex_lower(&identifier), c.owner, c.timestamp_s, c.epoch);
        let digest = keccak(&[b"\x19Ethereum Signed Message:\n", message.len().to_string().as_bytes(), message.as_bytes()]);
        let mut signers: Vec<[u8; 20]> = Vec::new();
        for sig in &c.signatures {
            if let Some(addr) = recover(&digest, sig) {
                if attestors.attestors.contains(&addr) && !signers.contains(&addr) {
                    signers.push(addr);
                }
            }
        }
        if signers.len() < attestors.threshold as usize {
            return Err(RevenueError::TooFewSignatures(i));
        }

        let ctx = c.context.as_bytes();
        let account = extract_param(ctx, "account").map(|a| a.to_vec()).unwrap_or_else(|| c.owner.as_bytes().to_vec());
        if keccak(&[&account]) != terms.operator_key {
            return Err(RevenueError::WrongOperator(i));
        }
        let amount_micro = match extract_param(ctx, "amount_cents") {
            Some(raw) => {
                let cur = extract_param(ctx, "currency").ok_or(RevenueError::Currency(i))?;
                if !cur.eq_ignore_ascii_case(&terms.currency) {
                    return Err(RevenueError::Currency(i));
                }
                parse_micro(raw).ok_or(RevenueError::BadNumber(i))? / 100
            }
            None => {
                let cur = extract_param(ctx, "currency").unwrap_or(b"USD");
                if !cur.eq_ignore_ascii_case(&terms.currency) {
                    return Err(RevenueError::Currency(i));
                }
                parse_micro(extract_param(ctx, "amount").ok_or(RevenueError::MissingParam(i))?).ok_or(RevenueError::BadNumber(i))?
            }
        };
        let earned_at = match extract_param(ctx, "at") {
            Some(raw) => {
                let at = parse_micro(raw).ok_or(RevenueError::BadNumber(i))? / 1_000_000;
                if at > c.timestamp_s as u64 {
                    return Err(RevenueError::OutsideWindow(i));
                }
                at
            }
            None => c.timestamp_s as u64,
        };
        let period = (earned_at / terms.period_s as u64) as u32;
        if period < first || period > terms.as_of_period {
            return Err(RevenueError::OutsideWindow(i));
        }
        // One payment id counts once; sources without ids count once per period.
        let key = match extract_param(ctx, "item") {
            Some(item) => keccak(&[b"item", item]),
            None => keccak(&[b"period", &period.to_le_bytes()]),
        };
        if seen.contains(&key) {
            return Err(RevenueError::Duplicate(i));
        }
        seen.push(key);
        revenue += amount_micro as u128;
    }

    let required = window as u128 * terms.debt_service_micro as u128;
    let coverage_bps = (revenue * 10_000 / required) as u64;
    Ok(CovenantResult {
        revenue_micro: revenue.min(u64::MAX as u128) as u64,
        coverage_bps,
        pass: coverage_bps >= terms.min_coverage_bps as u64,
        claims: claims.len() as u32,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::fixtures::{claim, claims, setup};

    #[test]
    fn a_strong_month_passes() {
        let (fx, set, params, terms) = setup();
        let r = check_covenant(&claims(&fx["strong"]), &set, &params, &terms).unwrap();
        assert_eq!(r.revenue_micro, 650_000_000_000);
        assert_eq!(r.coverage_bps, 13_541);
        assert!(r.pass);
    }

    #[test]
    fn a_weak_month_is_watch() {
        let (fx, set, params, terms) = setup();
        let r = check_covenant(&claims(&fx["weak"]), &set, &params, &terms).unwrap();
        assert_eq!(r.coverage_bps, 9_270);
        assert!(!r.pass);
    }

    #[test]
    fn one_signature_is_not_enough_and_outsiders_do_not_count() {
        let (fx, set, params, terms) = setup();
        assert_eq!(check_covenant(&[claim(&fx["oneSigner"])], &set, &params, &terms), Err(RevenueError::TooFewSignatures(0)));
        assert_eq!(check_covenant(&[claim(&fx["outsiderSigned"])], &set, &params, &terms), Err(RevenueError::TooFewSignatures(0)));
        let mut twice = claim(&fx["oneSigner"]);
        twice.signatures.push(twice.signatures[0].clone());
        assert_eq!(check_covenant(&[twice], &set, &params, &terms), Err(RevenueError::TooFewSignatures(0)));
    }

    #[test]
    fn the_same_payment_counts_once() {
        let (fx, set, params, terms) = setup();
        let mut cs = claims(&fx["strong"]);
        cs.push(cs[0].clone());
        assert_eq!(check_covenant(&cs, &set, &params, &terms), Err(RevenueError::Duplicate(4)));
    }

    #[test]
    fn tampered_amount_breaks_the_signatures() {
        let (fx, set, params, terms) = setup();
        let mut cs = claims(&fx["strong"]);
        cs[0].context = cs[0].context.replace("16000000", "96000000");
        assert_eq!(check_covenant(&cs, &set, &params, &terms), Err(RevenueError::TooFewSignatures(0)));
    }

    #[test]
    fn terms_bind_operator_currency_and_window() {
        let (fx, set, params, mut terms) = setup();
        let cs = claims(&fx["strong"]);
        let mut other = terms.clone();
        other.operator_key[0] ^= 1;
        assert_eq!(check_covenant(&cs, &set, &params, &other), Err(RevenueError::WrongOperator(0)));
        let mut usd = terms.clone();
        usd.currency = *b"USD";
        assert_eq!(check_covenant(&cs, &set, &params, &usd), Err(RevenueError::Currency(0)));
        terms.as_of_period += 1;
        assert_eq!(check_covenant(&cs, &set, &params, &terms), Err(RevenueError::OutsideWindow(0)));
        let mut wrong = params;
        wrong[0] ^= 1;
        let (_, set2, _, terms2) = setup();
        assert_eq!(check_covenant(&cs, &set2, &wrong, &terms2), Err(RevenueError::WrongSource(0)));
        let _ = set;
    }
}
