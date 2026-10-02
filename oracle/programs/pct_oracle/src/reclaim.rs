//! Reclaim claim verification without CPI: recompute the claim identifier, rebuild the
//! attestor's EIP-191 message, and recover the signer with the secp256k1 syscall.

use solana_keccak_hasher::hashv;
use solana_secp256k1_recover::secp256k1_recover;

#[derive(Debug, PartialEq, Eq)]
pub enum ClaimError {
    BadOwner,
    BadSignature,
    MissingParam,
    BadNumber,
}

pub fn keccak(data: &[u8]) -> [u8; 32] {
    hashv(&[data]).to_bytes()
}

/// Reclaim's claim identifier: keccak256(provider \n parameters \n canonicalContext).
pub fn claim_identifier(provider: &[u8], parameters: &[u8], context: &[u8]) -> [u8; 32] {
    hashv(&[provider, b"\n", parameters, b"\n", context]).to_bytes()
}

fn hex_lower(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    bytes.iter().flat_map(|b| [DIGITS[(b >> 4) as usize] as char, DIGITS[(b & 0xf) as usize] as char]).collect()
}

fn is_lower_eth_address(owner: &str) -> bool {
    owner.len() == 42
        && owner.starts_with("0x")
        && owner[2..].bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// The exact string attestors sign: identifier, owner, timestampS, epoch, newline-joined.
pub fn sign_message(identifier: &[u8; 32], owner: &str, timestamp_s: u32, epoch: u32) -> Result<Vec<u8>, ClaimError> {
    if !is_lower_eth_address(owner) {
        return Err(ClaimError::BadOwner);
    }
    Ok(format!("0x{}\n{}\n{}\n{}", hex_lower(identifier), owner, timestamp_s, epoch).into_bytes())
}

/// EIP-191 personal_sign digest.
pub fn eth_message_hash(message: &[u8]) -> [u8; 32] {
    let len = message.len().to_string();
    hashv(&[b"\x19Ethereum Signed Message:\n", len.as_bytes(), message]).to_bytes()
}

/// Recovers the 20-byte Ethereum address that produced a 65-byte (r, s, v) signature.
pub fn recover_eth_signer(digest: &[u8; 32], signature: &[u8; 65]) -> Result<[u8; 20], ClaimError> {
    let recovery_id = match signature[64] {
        27 | 28 => signature[64] - 27,
        0 | 1 => signature[64],
        _ => return Err(ClaimError::BadSignature),
    };
    let pubkey = secp256k1_recover(digest, recovery_id, &signature[..64]).map_err(|_| ClaimError::BadSignature)?;
    let hash = keccak(&pubkey.to_bytes());
    let mut address = [0u8; 20];
    address.copy_from_slice(&hash[12..]);
    Ok(address)
}

/// Reads a JSON string starting at `at` (which must be `"`) and returns (contents, index after
/// the closing quote). Escapes are skipped, not decoded.
fn json_string(bytes: &[u8], at: usize) -> Result<(&[u8], usize), ClaimError> {
    if bytes.get(at) != Some(&b'"') {
        return Err(ClaimError::MissingParam);
    }
    let mut i = at + 1;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 2,
            b'"' => return Ok((&bytes[at + 1..i], i + 1)),
            _ => i += 1,
        }
    }
    Err(ClaimError::MissingParam)
}

fn expect(bytes: &[u8], at: usize, lit: &[u8]) -> Result<usize, ClaimError> {
    if bytes.len() >= at + lit.len() && &bytes[at..at + lit.len()] == lit {
        Ok(at + lit.len())
    } else {
        Err(ClaimError::MissingParam)
    }
}

/// Reads an attestor-extracted value from a canonical (sorted-key) Reclaim context:
/// `{"contextAddress":"…","contextMessage":"…","extractedParameters":{"k":"v",…},…}`.
/// The structure is walked from the start, so prover-chosen text (contextMessage, or an extra
/// object that sorts first) can never be mistaken for the real extractedParameters, and only
/// that object's own keys are searched. Values containing escapes are refused.
pub fn extract_param<'a>(context: &'a [u8], name: &str) -> Result<&'a [u8], ClaimError> {
    let i = expect(context, 0, br#"{"contextAddress":"#)?;
    let (_, i) = json_string(context, i)?;
    let i = expect(context, i, br#","contextMessage":"#)?;
    let (_, i) = json_string(context, i)?;
    let mut i = expect(context, i, br#","extractedParameters":{"#)?;
    if context.get(i) == Some(&b'}') {
        return Err(ClaimError::MissingParam);
    }
    loop {
        let (key, next) = json_string(context, i)?;
        let next = expect(context, next, b":")?;
        let (value, next) = json_string(context, next)?;
        if key == name.as_bytes() {
            if value.contains(&b'\\') {
                return Err(ClaimError::BadNumber);
            }
            return Ok(value);
        }
        match context.get(next) {
            Some(b',') => i = next + 1,
            _ => return Err(ClaimError::MissingParam),
        }
    }
}

/// Strict decimal (up to 6 places) to integer millionths: "2.49" -> 2_490_000.
pub fn parse_micro(raw: &[u8]) -> Result<u64, ClaimError> {
    let mut parts = raw.splitn(2, |b| *b == b'.');
    let whole = parts.next().unwrap_or_default();
    let frac = parts.next().unwrap_or_default();
    let digits_ok = |s: &[u8]| s.iter().all(u8::is_ascii_digit);
    if whole.is_empty() || whole.len() > 12 || frac.len() > 6 || !digits_ok(whole) || !digits_ok(frac) {
        return Err(ClaimError::BadNumber);
    }
    if raw.contains(&b'.') && frac.is_empty() {
        return Err(ClaimError::BadNumber);
    }
    let to_u64 = |s: &[u8]| s.iter().fold(0u64, |acc, d| acc * 10 + (d - b'0') as u64);
    let frac_scaled = to_u64(frac) * 10u64.pow(6 - frac.len() as u32);
    Ok(to_u64(whole) * 1_000_000 + frac_scaled)
}

/// Rounds half up, like Math.round in the TS reference.
pub fn div_round(numerator: u128, denominator: u128) -> u64 {
    ((numerator * 2 + denominator) / (denominator * 2)) as u64
}

/// Micro-USD per GPU-hour from either a per-unit `rate` or an `amount` over `hours`.
pub fn price_per_gpu_hour(context: &[u8], amount_mode: bool, gpu_count: u16) -> Result<u64, ClaimError> {
    let gpus = gpu_count.max(1) as u128;
    if amount_mode {
        let amount = parse_micro(extract_param(context, "amount")?)? as u128;
        let hours = parse_micro(extract_param(context, "hours")?)? as u128;
        if hours == 0 {
            return Err(ClaimError::BadNumber);
        }
        Ok(div_round(amount * 1_000_000, hours * gpus))
    } else {
        let rate = parse_micro(extract_param(context, "rate")?)? as u128;
        Ok(div_round(rate, gpus))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_decimals() {
        assert_eq!(parse_micro(b"2.49"), Ok(2_490_000));
        assert_eq!(parse_micro(b"98"), Ok(98_000_000));
        assert_eq!(parse_micro(b"0.000001"), Ok(1));
        for bad in [&b""[..], b"1.", b".5", b"1.2.3", b"-1", b"1e5", b"1.1234567"] {
            assert_eq!(parse_micro(bad), Err(ClaimError::BadNumber), "{:?}", core::str::from_utf8(bad));
        }
    }

    #[test]
    fn extracts_only_from_extracted_parameters() {
        let ctx = br#"{"contextAddress":"0x0","contextMessage":"note \"rate\":\"0.01\" \\","extractedParameters":{"amount_cents":"5","rate":"98.32"},"providerHash":"0x00"}"#;
        assert_eq!(extract_param(ctx, "rate").unwrap(), b"98.32");
        assert_eq!(extract_param(ctx, "amount"), Err(ClaimError::MissingParam), "prefix of amount_cents");
        assert_eq!(extract_param(b"{}", "rate"), Err(ClaimError::MissingParam));
    }

    #[test]
    fn refuses_spoofed_structures() {
        // An extra object that sorts before the real one.
        let sorted_first = br#"{"a":{"extractedParameters":{"rate":"0.01"}},"contextAddress":"0x0","contextMessage":"","extractedParameters":{"rate":"98.32"}}"#;
        assert_eq!(extract_param(sorted_first, "rate"), Err(ClaimError::MissingParam));
        // contextMessage as an object instead of a string.
        let object_message = br#"{"contextAddress":"0x0","contextMessage":{"extractedParameters":{"rate":"0.01"}},"extractedParameters":{"rate":"98.32"}}"#;
        assert_eq!(extract_param(object_message, "rate"), Err(ClaimError::MissingParam));
        // A key that only appears after the object closes.
        let outside = br#"{"contextAddress":"0x0","contextMessage":"","extractedParameters":{"x":"1"},"rate":"0.01"}"#;
        assert_eq!(extract_param(outside, "rate"), Err(ClaimError::MissingParam));
        // Escaped value.
        let escaped = br#"{"contextAddress":"0x0","contextMessage":"","extractedParameters":{"rate":"9\"8"}}"#;
        assert_eq!(extract_param(escaped, "rate"), Err(ClaimError::BadNumber));
    }

    #[test]
    fn prices_rate_and_amount_modes() {
        let rate = br#"{"contextAddress":"0x0","contextMessage":"","extractedParameters":{"rate":"98.32"}}"#;
        assert_eq!(price_per_gpu_hour(rate, false, 8), Ok(12_290_000));
        let amount = br#"{"contextAddress":"0x0","contextMessage":"","extractedParameters":{"amount":"4.98","hours":"2"}}"#;
        assert_eq!(price_per_gpu_hour(amount, true, 1), Ok(2_490_000));
        let zero = br#"{"contextAddress":"0x0","contextMessage":"","extractedParameters":{"amount":"4.98","hours":"0"}}"#;
        assert_eq!(price_per_gpu_hour(zero, true, 1), Err(ClaimError::BadNumber));
    }

    #[test]
    fn rejects_non_canonical_owner() {
        let id = [0u8; 32];
        assert_eq!(sign_message(&id, "0xABab", 1, 1), Err(ClaimError::BadOwner));
        let upper = format!("0x{}", "AB".repeat(20));
        assert_eq!(sign_message(&id, &upper, 1, 1), Err(ClaimError::BadOwner));
        let ok = format!("0x{}", "ab".repeat(20));
        let msg = sign_message(&id, &ok, 7, 1).unwrap();
        assert!(String::from_utf8(msg).unwrap().ends_with("\n7\n1"));
    }

    #[test]
    fn rejects_bad_recovery_byte() {
        let mut sig = [1u8; 65];
        sig[64] = 5;
        assert_eq!(recover_eth_signer(&[0u8; 32], &sig), Err(ClaimError::BadSignature));
    }
}
