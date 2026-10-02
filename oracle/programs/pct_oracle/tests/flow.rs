//! End-to-end: Reclaim-format claims signed by a test attestor go through buffer -> submit -> crank.
//! Fixtures come from scripts/make-oracle-fixtures.ts (Reclaim's own signing code).

use {
    anchor_lang::{
        prelude::{Clock, Pubkey},
        solana_program::{instruction::Instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    litesvm::LiteSVM,
    pct_oracle::{instructions::ClaimSig, state::{Book, IndexParams}, SourceArgs},
    serde_json::Value,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

const CHUNK: usize = 800;

fn hex(s: &str) -> Vec<u8> {
    let s = s.trim_start_matches("0x");
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

fn keccak(data: &[u8]) -> [u8; 32] {
    solana_keccak_hasher::hashv(&[data]).to_bytes()
}

fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &pct_oracle::id()).0
}

struct Harness {
    svm: LiteSVM,
    payer: Keypair,
}

impl Harness {
    fn send(&mut self, ixs: &[Instruction]) -> Result<u64, String> {
        let blockhash = self.svm.latest_blockhash();
        let msg = Message::new_with_blockhash(ixs, Some(&self.payer.pubkey()), &blockhash);
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[&self.payer]).unwrap();
        let result = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        result.map(|m| m.compute_units_consumed).map_err(|e| format!("{:?}\n{}", e.err, e.meta.logs.join("\n")))
    }

    fn ix<D: InstructionData, A: ToAccountMetas>(data: D, accounts: A) -> Instruction {
        Instruction::new_with_bytes(pct_oracle::id(), &data.data(), accounts.to_account_metas(None))
    }

    fn book(&self, sku: u8, kind: u8) -> Book {
        let account = self.svm.get_account(&pda(&[b"book", &[sku], &[kind]])).unwrap();
        Book::try_deserialize(&mut account.data.as_slice()).unwrap()
    }
}

fn fixtures() -> Value {
    serde_json::from_str(include_str!("fixtures/claims.json")).unwrap()
}

fn setup() -> (Harness, Value) {
    let fx = fixtures();
    let mut svm = LiteSVM::new();
    let bytes = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/pct_oracle.so"));
    svm.add_program(pct_oracle::id(), bytes).unwrap();
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();
    let mut clock: Clock = svm.get_sysvar();
    clock.unix_timestamp = fx["claims"][0]["timestampS"].as_i64().unwrap() + 60;
    svm.set_sysvar(&clock);
    let mut h = Harness { svm, payer };

    let attestor: [u8; 20] = hex(fx["attestor"].as_str().unwrap()).try_into().unwrap();
    let params = IndexParams {
        max_staleness_s: 86_400,
        max_future_skew_s: 300,
        min_providers: 3,
        provider_cap_bps: 2_500,
        mad_k_milli: 3_000,
        mad_floor_bps: 50,
    };
    let payer = h.payer.pubkey();
    let config = pda(&[b"config"]);
    let mut ixs = vec![Harness::ix(
        pct_oracle::instruction::InitializeConfig { attestors: vec![attestor], params },
        pct_oracle::accounts::InitializeConfig { authority: payer, config, system_program: system_program::ID },
    )];
    for kind in [0u8, 1] {
        ixs.push(Harness::ix(
            pct_oracle::instruction::InitBook { sku: 0, kind },
            pct_oracle::accounts::InitBook { payer, book: pda(&[b"book", &[0], &[kind]]), system_program: system_program::ID },
        ));
    }
    h.send(&ixs).unwrap();

    for c in fx["claims"].as_array().unwrap() {
        let source_id = keccak(c["name"].as_str().unwrap().as_bytes());
        let args = SourceArgs {
            source_id,
            params_hash: hex(c["paramsHash"].as_str().unwrap()).try_into().unwrap(),
            provider_id: c["provider"].as_u64().unwrap() as u16,
            sku: 0,
            kind: c["kind"].as_u64().unwrap() as u8,
            gpu_count: c["gpuCount"].as_u64().unwrap() as u16,
            value_mode: c["valueMode"].as_u64().unwrap() as u8,
            requires_nullifier: c["requiresNullifier"].as_bool().unwrap(),
        };
        h.send(&[Harness::ix(
            pct_oracle::instruction::RegisterSource { args },
            pct_oracle::accounts::RegisterSource {
                authority: payer,
                config,
                source: pda(&[b"source", &source_id]),
                system_program: system_program::ID,
            },
        )])
        .unwrap();
    }
    (h, fx)
}

/// Uploads a claim (optionally tampered) and submits it. Returns compute units of the submit tx.
fn submit(h: &mut Harness, c: &Value, context_override: Option<&str>) -> Result<u64, String> {
    let provider = c["claimProvider"].as_str().unwrap().as_bytes();
    let parameters = c["parameters"].as_str().unwrap().as_bytes();
    let context = context_override.unwrap_or(c["context"].as_str().unwrap()).as_bytes();
    let payer = h.payer.pubkey();
    let buffer = pda(&[b"buffer", payer.as_ref()]);
    h.send(&[Harness::ix(
        pct_oracle::instruction::OpenBuffer {
            provider_len: provider.len() as u16,
            parameters_len: parameters.len() as u16,
            context_len: context.len() as u16,
        },
        pct_oracle::accounts::OpenBuffer { authority: payer, buffer, system_program: system_program::ID },
    )])?;
    let data = [provider, parameters, context].concat();
    for (i, chunk) in data.chunks(CHUNK).enumerate() {
        h.send(&[Harness::ix(
            pct_oracle::instruction::WriteBuffer { offset: (i * CHUNK) as u16, bytes: chunk.to_vec() },
            pct_oracle::accounts::WriteBuffer { authority: payer, buffer },
        )])?;
    }

    let source_id = keccak(c["name"].as_str().unwrap().as_bytes());
    let source = pda(&[b"source", &source_id]);
    let timestamp_s = c["timestampS"].as_u64().unwrap() as u32;
    let receipt_key = if c["requiresNullifier"].as_bool().unwrap() {
        keccak(c["extracted"]["account"].as_str().unwrap().as_bytes())
    } else {
        let mut bytes = hex(c["identifier"].as_str().unwrap());
        bytes.extend_from_slice(&timestamp_s.to_le_bytes());
        keccak(&bytes)
    };
    let sig = ClaimSig {
        owner: c["owner"].as_str().unwrap().to_string(),
        timestamp_s,
        epoch: c["epoch"].as_u64().unwrap() as u32,
        signature: hex(c["signature"].as_str().unwrap()).try_into().unwrap(),
    };
    let kind = c["kind"].as_u64().unwrap() as u8;
    let result = h.send(&[Harness::ix(
        pct_oracle::instruction::SubmitObservation { sig, receipt_key },
        pct_oracle::accounts::SubmitObservation {
            submitter: payer,
            config: pda(&[b"config"]),
            source,
            book: pda(&[b"book", &[0], &[kind]]),
            buffer,
            receipt: pda(&[b"receipt", source.as_ref(), &receipt_key]),
            system_program: system_program::ID,
        },
    )]);
    if result.is_err() {
        h.send(&[Harness::ix(
            pct_oracle::instruction::CloseBuffer {},
            pct_oracle::accounts::CloseBuffer { authority: payer, buffer },
        )])
        .unwrap();
    }
    result
}

fn crank(h: &mut Harness, kind: u8) -> u64 {
    h.send(&[Harness::ix(
        pct_oracle::instruction::CrankIndex {},
        pct_oracle::accounts::CrankIndex { config: pda(&[b"config"]), book: pda(&[b"book", &[0], &[kind]]) },
    )])
    .unwrap()
}

#[test]
fn proven_invoices_produce_a_live_paid_index() {
    let (mut h, fx) = setup();
    let mut submit_cu = Vec::new();
    for c in fx["claims"].as_array().unwrap() {
        submit_cu.push(submit(&mut h, c, None).expect("valid claim accepted"));
    }
    let crank_cu = crank(&mut h, 0);
    crank(&mut h, 1);

    let paid = h.book(0, 0);
    assert_eq!(paid.len, 4);
    assert_eq!(paid.status, 1, "paid index live");
    assert_eq!(paid.value_micro, 2_490_000, "matches TS reference");
    let prices: Vec<u64> = paid.slots[..4].iter().map(|s| s.price_micro).collect();
    assert_eq!(prices, vec![2_490_000, 2_690_000, 2_100_000, 2_800_000]);

    let list = h.book(0, 1);
    assert_eq!(list.slots[0].price_micro, 12_290_000, "Azure 8x H100 list price per GPU");
    assert_eq!(list.status, 2, "one list provider is not enough");

    println!("submit CU: {:?}  crank CU (4 obs): {}", submit_cu, crank_cu);
}

#[test]
fn reused_invoice_is_rejected() {
    let (mut h, fx) = setup();
    let c = &fx["claims"][0];
    submit(&mut h, c, None).unwrap();
    assert!(submit(&mut h, c, None).is_err(), "same nullifier twice");
}

#[test]
fn tampered_price_fails_signature() {
    let (mut h, fx) = setup();
    let c = &fx["claims"][1];
    let forged = c["context"].as_str().unwrap().replace("\"rate\":\"2.69\"", "\"rate\":\"0.69\"");
    let err = submit(&mut h, c, Some(&forged)).unwrap_err();
    assert!(err.contains("UnknownAttestor"), "{err}");
}

#[test]
fn stale_claim_is_rejected() {
    let (mut h, fx) = setup();
    let mut clock: Clock = h.svm.get_sysvar();
    clock.unix_timestamp += 200_000;
    h.svm.set_sysvar(&clock);
    let err = submit(&mut h, &fx["claims"][0], None).unwrap_err();
    assert!(err.contains("StaleClaim"), "{err}");
}
