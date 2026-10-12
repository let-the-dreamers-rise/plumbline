//! Tessera sealed-eval proof: verify the enclave's TDX score quote to the pinned Intel root and
//! check it binds this exact score statement. Runs natively in tests and inside the RISC Zero guest.
//!
//! Binding (sealed-eval/enclave/server.py, v1): quote report_data[0..32] =
//!   sha256(b"tessera:score:v1" || canonical(statement))
//! where canonical = json.dumps(sort_keys=True, separators=(',', ':'), ensure_ascii=False).
//!
//! Which code ran: the dstack event log is replayed into RTMR3 and must equal the quote's RTMR3;
//! the runtime `compose-hash` event (digest recomputed from its payload) gives the hash of the app compose, i.e.
//! the measured docker-compose that embeds enclave/server.py. Same replay as sealed-eval/tdxq.py.
//!
//! Payout (Plumbline): the statement's optional `payout` field (64 lowercase hex chars, the 32 raw
//! bytes of the entrant's Solana pubkey) is copied into the journal. It is part of canonical(statement),
//! so it is covered by the same report_data binding as the score. Absent = 32 zero bytes, which the
//! escrow refuses to pay; malformed = error.
pub mod tdx;

use serde_json::{Map, Value};
use sha2::{Digest, Sha256, Sha384};

/// Journal layout (the Solana program reads it by offset):
/// statement_hash 32 | model_id_hash 32 | suite_commitment 32 | quote_hash 32 | mr_td 48 |
/// rtmrs_hash 32 | tee_tcb_svn 16 | root_sha256 32 | correct u32 LE | total u32 LE |
/// binding_version u8 | bound u8 | compose_hash 32 (zero unless the event log replays to RTMR3) |
/// payout 32 (zero if the statement has no `payout`)
pub const JOURNAL_LEN: usize = 32 * 4 + 48 + 32 + 16 + 32 + 4 + 4 + 1 + 1 + 32 + 32;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Journal {
    pub statement_hash: [u8; 32],
    pub model_id_hash: [u8; 32],
    pub suite_commitment: [u8; 32],
    pub quote_hash: [u8; 32],
    pub mr_td: [u8; 48],
    pub rtmrs_hash: [u8; 32],
    pub tee_tcb_svn: [u8; 16],
    pub root_sha256: [u8; 32],
    pub correct: u32,
    pub total: u32,
    pub binding_version: u8,
    /// The quote's report_data commits to this statement.
    pub bound: bool,
    /// dstack app compose hash from the replayed event log; zero if it did not replay or is absent.
    pub compose_hash: [u8; 32],
    /// Entrant's payout pubkey from the statement; zero if the statement has none.
    pub payout: [u8; 32],
}

impl Journal {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(JOURNAL_LEN);
        out.extend_from_slice(&self.statement_hash);
        out.extend_from_slice(&self.model_id_hash);
        out.extend_from_slice(&self.suite_commitment);
        out.extend_from_slice(&self.quote_hash);
        out.extend_from_slice(&self.mr_td);
        out.extend_from_slice(&self.rtmrs_hash);
        out.extend_from_slice(&self.tee_tcb_svn);
        out.extend_from_slice(&self.root_sha256);
        out.extend_from_slice(&self.correct.to_le_bytes());
        out.extend_from_slice(&self.total.to_le_bytes());
        out.push(self.binding_version);
        out.push(self.bound as u8);
        out.extend_from_slice(&self.compose_hash);
        out.extend_from_slice(&self.payout);
        out
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    Tdx(tdx::TdxError),
    /// Not valid JSON, or not in canonical form (sorted keys, no whitespace).
    NotCanonical,
    Field(&'static str),
    UnsupportedVersion,
    EventLog(&'static str),
}

fn hex_field(e: &Value, k: &'static str) -> Result<Vec<u8>, Error> {
    match e.get(k) {
        None => Ok(Vec::new()),
        Some(v) => v.as_str().and_then(|s| hex::decode(s).ok()).ok_or(Error::EventLog(k)),
    }
}

/// dstack's event type for runtime (RTMR3) events (cc-eventlog `DSTACK_RUNTIME_EVENT_TYPE`).
pub const DSTACK_RUNTIME_EVENT_TYPE: u32 = 0x0800_0001;

/// dstack's runtime event digest: sha384(event_type.to_ne_bytes() || ':' || event || ':' || payload)
/// (cc-eventlog/src/runtime_events.rs; to_ne_bytes is little-endian on every TDX host).
pub fn runtime_event_digest(event_type: u32, name: &str, payload: &[u8]) -> [u8; 48] {
    let mut h = Sha384::new();
    h.update(event_type.to_le_bytes());
    h.update(b":");
    h.update(name.as_bytes());
    h.update(b":");
    h.update(payload);
    h.finalize().into()
}

/// Replays dstack's RTMR3 from its JSON event log (the `event_log` string of GetQuote). Returns
/// (rtmr3, compose_hash).
///
/// Runtime events (event_type 0x08000001) are replayed with the digest recomputed from their name and
/// payload. Newer dstack strips that digest from GetQuote's log (empty or missing); when one is present
/// it must equal the recomputed value, otherwise the whole log is rejected. compose_hash is the payload
/// of a runtime `compose-hash` event, so it is bound to RTMR3 by construction. Other RTMR3 events keep
/// their provided 48-byte digest.
pub fn replay_rtmr3(event_log: &[u8]) -> Result<([u8; 48], Option<[u8; 32]>), Error> {
    let events: Value = serde_json::from_slice(event_log).map_err(|_| Error::EventLog("json"))?;
    let events = events.as_array().ok_or(Error::EventLog("not a list"))?;
    let mut rtmr = [0u8; 48];
    let mut compose = None;
    for e in events {
        if e.get("imr").and_then(Value::as_u64) != Some(3) {
            continue;
        }
        let given = hex_field(e, "digest")?;
        let ty = e.get("event_type").and_then(Value::as_u64).ok_or(Error::EventLog("event_type"))?;
        let digest: [u8; 48] = if ty == DSTACK_RUNTIME_EVENT_TYPE as u64 {
            let name = e.get("event").and_then(Value::as_str).ok_or(Error::EventLog("event"))?;
            let payload = hex_field(e, "event_payload")?;
            let d = runtime_event_digest(DSTACK_RUNTIME_EVENT_TYPE, name, &payload);
            if !given.is_empty() && given[..] != d[..] {
                return Err(Error::EventLog("digest mismatch"));
            }
            if name == "compose-hash" {
                compose = Some(payload.try_into().map_err(|_| Error::EventLog("compose-hash length"))?);
            }
            d
        } else {
            given.try_into().map_err(|_| Error::EventLog("digest"))?
        };
        let mut h = Sha384::new();
        h.update(rtmr);
        h.update(digest);
        rtmr = h.finalize().into();
    }
    Ok((rtmr, compose))
}

fn str_field<'a>(m: &'a Map<String, Value>, k: &'static str) -> Result<&'a str, Error> {
    m.get(k).and_then(Value::as_str).ok_or(Error::Field(k))
}

fn u32_field(m: &Map<String, Value>, k: &'static str) -> Result<u32, Error> {
    m.get(k).and_then(Value::as_u64).and_then(|v| u32::try_from(v).ok()).ok_or(Error::Field(k))
}

/// Optional `payout`: exactly 64 lowercase hex chars (32 bytes). Absent = zero (unpayable).
fn payout_field(m: &Map<String, Value>) -> Result<[u8; 32], Error> {
    let Some(v) = m.get("payout") else { return Ok([0u8; 32]) };
    let s = v.as_str().ok_or(Error::Field("payout"))?;
    if s.len() != 64 || !s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) {
        return Err(Error::Field("payout"));
    }
    let mut out = [0u8; 32];
    hex::decode_to_slice(s, &mut out).map_err(|_| Error::Field("payout"))?;
    Ok(out)
}

/// sha256(b"tessera:model:v1" || canonical({model_id, model_revision, weights_sha256})),
/// same as sealed-eval-registry/scripts/bundle_to_args.py.
pub fn model_id_hash(model_id: &str, model_revision: &str, weights_sha256: &str) -> [u8; 32] {
    let mut m = Map::new();
    m.insert("model_id".into(), Value::String(model_id.into()));
    m.insert("model_revision".into(), Value::String(model_revision.into()));
    m.insert("weights_sha256".into(), Value::String(weights_sha256.into()));
    let mut h = Sha256::new();
    h.update(b"tessera:model:v1");
    h.update(serde_json::to_vec(&Value::Object(m)).unwrap());
    h.finalize().into()
}

/// `statement` is canonical(statement) exactly as the enclave hashed it; `event_log` is the dstack
/// event log JSON returned with the quote.
pub fn prove_score(quote: &[u8], statement: &[u8], event_log: &[u8]) -> Result<Journal, Error> {
    let parsed: Value = serde_json::from_slice(statement).map_err(|_| Error::NotCanonical)?;
    // serde_json's default Map is a BTreeMap, so re-serializing sorts keys like Python's sort_keys.
    if serde_json::to_vec(&parsed).map_err(|_| Error::NotCanonical)? != statement {
        return Err(Error::NotCanonical);
    }
    let m = parsed.as_object().ok_or(Error::NotCanonical)?;
    if str_field(m, "v")? != "tessera-score-1" {
        // v2 (TDX + GPU report) also needs the NVIDIA report check; not in this guest yet.
        return Err(Error::UnsupportedVersion);
    }
    let suite_commitment: [u8; 32] = hex::decode(str_field(m, "suite_commitment")?)
        .ok()
        .and_then(|v| v.try_into().ok())
        .ok_or(Error::Field("suite_commitment"))?;
    let correct = u32_field(m, "correct")?;
    let total = u32_field(m, "n")?;
    let payout = payout_field(m)?;

    let vm = tdx::verify_tdx(quote).map_err(Error::Tdx)?;
    let mut h = Sha256::new();
    h.update(b"tessera:score:v1");
    h.update(statement);
    let expected: [u8; 32] = h.finalize().into();
    let (rtmr3, compose) = replay_rtmr3(event_log)?;
    let compose_hash = if rtmr3 == vm.rtmr3 { compose.unwrap_or([0u8; 32]) } else { [0u8; 32] };

    Ok(Journal {
        statement_hash: Sha256::digest(statement).into(),
        model_id_hash: model_id_hash(str_field(m, "model_id")?, str_field(m, "model_revision")?, str_field(m, "weights_sha256")?),
        suite_commitment,
        quote_hash: Sha256::digest(quote).into(),
        mr_td: vm.mr_td,
        rtmrs_hash: vm.rtmrs_hash,
        tee_tcb_svn: vm.tee_tcb_svn,
        root_sha256: Sha256::digest(tdx::PINNED_ROOT_DER).into(),
        correct,
        total,
        binding_version: 1,
        bound: vm.report_data[..32] == expected,
        compose_hash,
        payout,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const REAL_QUOTE: &[u8] = include_bytes!("../../fixtures/intel-real-quote.bin");
    const STATEMENT: &[u8] = include_bytes!("../../fixtures/statement-v1.json");

    #[test]
    fn real_intel_quote_verifies_with_the_intel_root() {
        let a = tdx::verify_tdx_with_root(REAL_QUOTE, tdx::INTEL_SGX_ROOT_DER).unwrap();
        assert_eq!(&a.report_data[..], include_bytes!("../../fixtures/intel-real-report_data.bin"));
        assert_eq!(hex::encode(Sha256::digest(tdx::INTEL_SGX_ROOT_DER)), "44a0196b2b99f889b8e149e95b807a350e7424964399e885a7cbb8ccfab674d3");
    }

    #[test]
    fn real_intel_quote_rejects_flips() {
        let mut q = REAL_QUOTE.to_vec();
        q[600] ^= 1; // report_data
        assert_eq!(tdx::verify_tdx_with_root(&q, tdx::INTEL_SGX_ROOT_DER), Err(tdx::TdxError::BadQuoteSignature));
        let mut q = REAL_QUOTE.to_vec();
        q[636 + 134 + 10] ^= 1; // QE report
        assert_eq!(tdx::verify_tdx_with_root(&q, tdx::INTEL_SGX_ROOT_DER), Err(tdx::TdxError::BadQeSignature));
    }

    #[cfg(not(feature = "test-root"))]
    #[test]
    fn real_quote_is_not_bound_to_our_statement() {
        let j = prove_score(REAL_QUOTE, STATEMENT, b"[]").unwrap();
        assert!(!j.bound);
        assert_eq!(j.compose_hash, [0u8; 32]); // not a dstack VM: no event log replays to its RTMR3
        assert_eq!(j.encode().len(), JOURNAL_LEN);
        assert_eq!(JOURNAL_LEN, 330);
        assert_eq!(&j.encode()[298..], &[0u8; 32]); // no payout in statement-v1
    }

    #[test]
    fn absent_payout_is_zero() {
        // statement-v1 has no payout field (works under both builds; the quote is not involved)
        let m: Value = serde_json::from_slice(STATEMENT).unwrap();
        assert_eq!(payout_field(m.as_object().unwrap()), Ok([0u8; 32]));
    }

    #[test]
    fn bad_payout_hex_is_rejected() {
        let base = String::from_utf8(STATEMENT.to_vec()).unwrap();
        let good = "e0".repeat(32);
        for bad in [
            "E0".repeat(32),                  // uppercase
            "e0".repeat(31),                  // too short
            format!("{good}00"),              // too long
            format!("{}zz", "e0".repeat(31)), // not hex
            String::new(),
        ] {
            // keep the statement canonical: payout sorts between "n" and "suite_commitment"
            let s = base.replace("\"n\":6,", &format!("\"n\":6,\"payout\":\"{bad}\","));
            assert_eq!(prove_score(REAL_QUOTE, s.as_bytes(), b"[]").err(), Some(Error::Field("payout")), "{bad}");
        }
        let s = base.replace("\"n\":6,", "\"n\":6,\"payout\":7,");
        assert_eq!(prove_score(REAL_QUOTE, s.as_bytes(), b"[]").err(), Some(Error::Field("payout")));
        // a well-formed payout gets past parsing (and then fails or passes on the quote, per build)
        let s = base.replace("\"n\":6,", &format!("\"n\":6,\"payout\":\"{good}\","));
        assert_ne!(prove_score(REAL_QUOTE, s.as_bytes(), b"[]").err(), Some(Error::Field("payout")));
    }

    #[test]
    fn statement_fields_and_model_hash_match_bundle_to_args() {
        let args: Value = serde_json::from_slice(include_bytes!("../../fixtures/statement-v1.args.json")).unwrap();
        let m: Value = serde_json::from_slice(STATEMENT).unwrap();
        let h = model_id_hash(m["model_id"].as_str().unwrap(), m["model_revision"].as_str().unwrap(), m["weights_sha256"].as_str().unwrap());
        assert_eq!(hex::encode(h), args["model_id_hash"].as_str().unwrap());
        assert_eq!(hex::encode(Sha256::digest(STATEMENT)), args["statement_hash"].as_str().unwrap());
    }

    #[test]
    fn non_canonical_statement_is_rejected() {
        let pretty = serde_json::to_vec_pretty(&serde_json::from_slice::<Value>(STATEMENT).unwrap()).unwrap();
        assert_eq!(prove_score(REAL_QUOTE, &pretty, b"[]").err(), Some(Error::NotCanonical));
    }

    #[cfg(feature = "test-root")]
    mod synthetic {
        use super::*;
        const QUOTE: &[u8] = include_bytes!("../../fixtures/synthetic-quote.bin");
        const LOG: &[u8] = include_bytes!("../../fixtures/synthetic-event-log.json");
        const COMPOSE: &str = include_str!("../../fixtures/synthetic-compose-hash.txt");
        const QUOTE_PAYOUT: &[u8] = include_bytes!("../../fixtures/synthetic-quote-payout.bin");
        const STATEMENT_PAYOUT: &[u8] = include_bytes!("../../fixtures/statement-v1-payout.json");
        const LOG_STRIPPED: &[u8] = include_bytes!("../../fixtures/synthetic-event-log-stripped.json");
        const PAYOUT_HEX: &str = "e0b081b2a6a81934175244323046153979e7a56fa70247c72f80bad1e6316dd7";

        #[test]
        fn synthetic_quote_binds_the_statement() {
            let j = prove_score(QUOTE, STATEMENT, LOG).unwrap();
            assert!(j.bound);
            assert_eq!(hex::encode(j.compose_hash), COMPOSE.trim());
            assert_eq!((j.correct, j.total, j.binding_version), (4, 6, 1));
            assert_eq!(j.root_sha256, <[u8; 32]>::from(Sha256::digest(tdx::PINNED_ROOT_DER)));
            assert_eq!(j.payout, [0u8; 32]); // statement-v1 has no payout: proves as zeros
            assert_eq!(&j.encode()[298..], &[0u8; 32]);
        }

        #[test]
        fn payout_is_bound_and_in_the_journal() {
            let j = prove_score(QUOTE_PAYOUT, STATEMENT_PAYOUT, LOG).unwrap();
            assert!(j.bound);
            assert_eq!(hex::encode(j.compose_hash), COMPOSE.trim());
            assert_eq!(hex::encode(j.payout), PAYOUT_HEX);
            let enc = j.encode();
            assert_eq!(enc.len(), JOURNAL_LEN);
            assert_eq!(hex::encode(&enc[298..330]), PAYOUT_HEX);
            // the statement-v1 quote does not bind the payout statement
            assert!(!prove_score(QUOTE, STATEMENT_PAYOUT, LOG).unwrap().bound);
        }

        #[test]
        fn edited_payout_is_not_bound() {
            let s = String::from_utf8(STATEMENT_PAYOUT.to_vec()).unwrap().replace(PAYOUT_HEX, &"ab".repeat(32));
            let j = prove_score(QUOTE_PAYOUT, s.as_bytes(), LOG).unwrap();
            assert!(!j.bound);
            assert_eq!(j.payout, [0xab; 32]); // the journal says what was asked, but bound = 0
            // dropping the payout is an edit too
            let s = String::from_utf8(STATEMENT_PAYOUT.to_vec()).unwrap().replace(&format!("\"payout\":\"{PAYOUT_HEX}\","), "");
            assert_eq!(s.as_bytes(), STATEMENT);
            assert!(!prove_score(QUOTE_PAYOUT, s.as_bytes(), LOG).unwrap().bound);
        }

        #[test]
        fn stripped_fixture_log_proves_the_same_journal() {
            let full = prove_score(QUOTE_PAYOUT, STATEMENT_PAYOUT, LOG).unwrap();
            let stripped = prove_score(QUOTE_PAYOUT, STATEMENT_PAYOUT, LOG_STRIPPED).unwrap();
            assert_eq!(stripped, full);
        }

        #[test]
        fn edited_score_is_not_bound() {
            let s = String::from_utf8(STATEMENT.to_vec()).unwrap().replace("\"correct\":4", "\"correct\":6");
            assert!(!prove_score(QUOTE, s.as_bytes(), LOG).unwrap().bound);
        }

        fn strip_digests(log: &[u8], missing: bool) -> Vec<u8> {
            let mut v: Value = serde_json::from_slice(log).unwrap();
            for e in v.as_array_mut().unwrap() {
                let o = e.as_object_mut().unwrap();
                if missing {
                    o.remove("digest");
                } else {
                    o.insert("digest".into(), Value::String(String::new()));
                }
            }
            serde_json::to_vec(&v).unwrap()
        }

        #[test]
        fn fixture_digests_match_dstack_formula() {
            let v: Value = serde_json::from_slice(LOG).unwrap();
            for e in v.as_array().unwrap() {
                let d = runtime_event_digest(e["event_type"].as_u64().unwrap() as u32, e["event"].as_str().unwrap(),
                    &hex::decode(e["event_payload"].as_str().unwrap()).unwrap());
                assert_eq!(hex::encode(d), e["digest"].as_str().unwrap());
            }
        }

        #[test]
        fn stripped_digest_log_gives_same_rtmr3_and_compose_hash() {
            let full = replay_rtmr3(LOG).unwrap();
            assert_eq!(hex::encode(full.1.unwrap()), COMPOSE.trim());
            for missing in [false, true] {
                let stripped = strip_digests(LOG, missing);
                assert_eq!(replay_rtmr3(&stripped).unwrap(), full);
                let j = prove_score(QUOTE, STATEMENT, &stripped).unwrap();
                assert_eq!(hex::encode(j.compose_hash), COMPOSE.trim());
                assert_eq!(j, prove_score(QUOTE, STATEMENT, LOG).unwrap());
            }
        }

        #[test]
        fn wrong_provided_digest_is_rejected() {
            // forged compose payload with the original digest kept
            let log = String::from_utf8(LOG.to_vec()).unwrap();
            let forged = log.replace(COMPOSE.trim(), &"ab".repeat(32));
            assert_eq!(prove_score(QUOTE, STATEMENT, forged.as_bytes()).err(), Some(Error::EventLog("digest mismatch")));
            // a flipped digest on an event whose payload is untouched
            let mut v: Value = serde_json::from_slice(LOG).unwrap();
            let d = v[0]["digest"].as_str().unwrap().to_string();
            let flipped = format!("{}{}", if &d[..1] == "0" { "1" } else { "0" }, &d[1..]);
            v[0]["digest"] = Value::String(flipped);
            assert_eq!(replay_rtmr3(&serde_json::to_vec(&v).unwrap()).err(), Some(Error::EventLog("digest mismatch")));
        }

        #[test]
        fn log_not_replaying_to_rtmr3_gives_zero_compose_hash() {
            // forged compose payload with digests stripped: self-consistent, but RTMR3 differs from the quote's
            let log = String::from_utf8(strip_digests(LOG, false)).unwrap();
            let forged = log.replace(COMPOSE.trim(), &"ab".repeat(32));
            let (rtmr, compose) = replay_rtmr3(forged.as_bytes()).unwrap();
            assert_eq!(hex::encode(compose.unwrap()), "ab".repeat(32));
            assert_ne!(rtmr, replay_rtmr3(LOG).unwrap().0);
            let j = prove_score(QUOTE, STATEMENT, forged.as_bytes()).unwrap();
            assert_eq!(j.compose_hash, [0u8; 32]);
            assert!(j.bound);
            // a dropped event, and no log at all
            let mut v: Value = serde_json::from_slice(LOG).unwrap();
            v.as_array_mut().unwrap().pop();
            assert_eq!(prove_score(QUOTE, STATEMENT, &serde_json::to_vec(&v).unwrap()).unwrap().compose_hash, [0u8; 32]);
            assert_eq!(prove_score(QUOTE, STATEMENT, b"[]").unwrap().compose_hash, [0u8; 32]);
        }

        #[test]
        fn real_intel_quote_fails_the_test_root() {
            assert_eq!(prove_score(REAL_QUOTE, STATEMENT, b"[]").err(), Some(Error::Tdx(tdx::TdxError::UntrustedRoot)));
        }
    }
}
