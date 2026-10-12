//! Host-side loading of the test fixtures (zk/fixtures): NVIDIA's sample H100 report and the
//! 2-of-n signed Razorpay claims made by scripts/make-zk-fixtures.ts.

use serde_json::Value;

use crate::{
    gpu::pem_chain,
    revenue::{AttestorSet, Claim, Terms},
};

pub const SAMPLE_REPORT_HEX: &str = include_str!("../../fixtures/h100-sample-report.hex");
pub const SAMPLE_CHAIN_PEM: &str = include_str!("../../fixtures/h100-sample-certchain.pem");
pub const REVENUE_JSON: &str = include_str!("../../fixtures/revenue-claims.json");

pub fn hexb(s: &str) -> Vec<u8> {
    hex::decode(s.trim_start_matches("0x")).unwrap()
}

pub fn sample_gpu() -> (Vec<u8>, Vec<Vec<u8>>) {
    (hexb(SAMPLE_REPORT_HEX.trim()), pem_chain(SAMPLE_CHAIN_PEM).unwrap())
}

pub fn claim(c: &Value) -> Claim {
    Claim {
        provider: c["provider"].as_str().unwrap().into(),
        parameters: c["parameters"].as_str().unwrap().into(),
        context: c["context"].as_str().unwrap().into(),
        owner: c["owner"].as_str().unwrap().into(),
        timestamp_s: c["timestamp_s"].as_u64().unwrap() as u32,
        epoch: c["epoch"].as_u64().unwrap() as u32,
        signatures: c["signatures"].as_array().unwrap().iter().map(|s| hexb(s.as_str().unwrap())).collect(),
    }
}

pub fn claims(v: &Value) -> Vec<Claim> {
    v.as_array().unwrap().iter().map(claim).collect()
}

/// (fixture json, attestor set, revenue source params hash, loan terms)
pub fn setup() -> (Value, AttestorSet, [u8; 32], Terms) {
    let fx: Value = serde_json::from_str(REVENUE_JSON).unwrap();
    let a = &fx["attestors"];
    let set = AttestorSet {
        threshold: a["threshold"].as_u64().unwrap() as u8,
        attestors: a["attestors"].as_array().unwrap().iter().map(|x| hexb(x.as_str().unwrap()).try_into().unwrap()).collect(),
    };
    let t = &fx["terms"];
    let terms = Terms {
        operator_key: hexb(t["operator_key"].as_str().unwrap()).try_into().unwrap(),
        currency: t["currency"].as_str().unwrap().as_bytes().try_into().unwrap(),
        period_s: t["period_s"].as_u64().unwrap() as u32,
        debt_service_micro: t["debt_service_micro"].as_u64().unwrap(),
        min_coverage_bps: t["min_coverage_bps"].as_u64().unwrap() as u32,
        covenant_periods: t["covenant_periods"].as_u64().unwrap() as u8,
        as_of_period: t["as_of_period"].as_u64().unwrap() as u32,
    };
    let params: [u8; 32] = hexb(fx["paramsHash"].as_str().unwrap()).try_into().unwrap();
    (fx, set, params, terms)
}
