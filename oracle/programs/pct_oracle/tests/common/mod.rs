//! Shared LiteSVM harness for the flow tests.
#![allow(dead_code)]

use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{instruction::Instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    litesvm::LiteSVM,
    pct_oracle::state::{Book, IndexParams},
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

pub const CHUNK: usize = 800;

pub fn hex(s: &str) -> Vec<u8> {
    let s = s.trim_start_matches("0x");
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

pub fn keccak(data: &[u8]) -> [u8; 32] {
    solana_keccak_hasher::hashv(&[data]).to_bytes()
}

pub fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &pct_oracle::id()).0
}

pub struct Harness {
    pub svm: LiteSVM,
    pub payer: Keypair,
}

impl Harness {
    pub fn send(&mut self, ixs: &[Instruction]) -> Result<u64, String> {
        let blockhash = self.svm.latest_blockhash();
        let msg = Message::new_with_blockhash(ixs, Some(&self.payer.pubkey()), &blockhash);
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[&self.payer]).unwrap();
        let result = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        result.map(|m| m.compute_units_consumed).map_err(|e| format!("{:?}\n{}", e.err, e.meta.logs.join("\n")))
    }

    /// Like `send`, with `signer` as the only signer and fee payer.
    pub fn send_as(&mut self, ixs: &[Instruction], signer: &Keypair) -> Result<u64, String> {
        let blockhash = self.svm.latest_blockhash();
        let msg = Message::new_with_blockhash(ixs, Some(&signer.pubkey()), &blockhash);
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[signer]).unwrap();
        let result = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        result.map(|m| m.compute_units_consumed).map_err(|e| format!("{:?}\n{}", e.err, e.meta.logs.join("\n")))
    }

    pub fn ix<D: InstructionData, A: ToAccountMetas>(data: D, accounts: A) -> Instruction {
        Instruction::new_with_bytes(pct_oracle::id(), &data.data(), accounts.to_account_metas(None))
    }

    pub fn book(&self, sku: u8, kind: u8) -> Book {
        let account = self.svm.get_account(&pda(&[b"book", &[sku], &[kind]])).unwrap();
        Book::try_deserialize(&mut account.data.as_slice()).unwrap()
    }
}


pub fn default_params() -> IndexParams {
    IndexParams {
        max_staleness_s: 86_400,
        max_future_skew_s: 300,
        min_providers: 3,
        provider_cap_bps: 2_500,
        mad_k_milli: 3_000,
        mad_floor_bps: 50,
    }
}

/// Fresh SVM with the built program, a funded payer, config with one attestor and H100 books.
pub fn boot(attestor: [u8; 20], params: IndexParams, now: i64) -> Harness {
    boot_with(vec![attestor], params, now)
}

/// Same as `boot` with any attestor list.
pub fn boot_with(attestors: Vec<[u8; 20]>, params: IndexParams, now: i64) -> Harness {
    let mut svm = LiteSVM::new();
    let bytes = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/pct_oracle.so"));
    svm.add_program(pct_oracle::id(), bytes).unwrap();
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();
    let mut h = Harness { svm, payer };
    h.set_time(now);
    let payer = h.payer.pubkey();
    let config = pda(&[b"config"]);
    let mut ixs = vec![Harness::ix(
        pct_oracle::instruction::InitializeConfig { attestors, params },
        pct_oracle::accounts::InitializeConfig { authority: payer, config, system_program: system_program::ID },
    )];
    for kind in [0u8, 1] {
        ixs.push(Harness::ix(
            pct_oracle::instruction::InitBook { sku: 0, kind },
            pct_oracle::accounts::InitBook { payer, book: pda(&[b"book", &[0], &[kind]]), system_program: system_program::ID },
        ));
    }
    h.send(&ixs).unwrap();
    h
}

impl Harness {
    pub fn set_time(&mut self, unix: i64) {
        let mut clock: anchor_lang::prelude::Clock = self.svm.get_sysvar();
        clock.unix_timestamp = unix;
        self.svm.set_sysvar(&clock);
    }

    /// Opens this payer's claim buffer and writes provider | parameters | context into it.
    pub fn upload(&mut self, provider: &[u8], parameters: &[u8], context: &[u8]) -> Result<Pubkey, String> {
        let payer = self.payer.pubkey();
        let buffer = pda(&[b"buffer", payer.as_ref()]);
        self.send(&[Harness::ix(
            pct_oracle::instruction::OpenBuffer {
                provider_len: provider.len() as u16,
                parameters_len: parameters.len() as u16,
                context_len: context.len() as u16,
            },
            pct_oracle::accounts::OpenBuffer { authority: payer, buffer, system_program: system_program::ID },
        )])?;
        let data = [provider, parameters, context].concat();
        for (i, chunk) in data.chunks(CHUNK).enumerate() {
            self.send(&[Harness::ix(
                pct_oracle::instruction::WriteBuffer { offset: (i * CHUNK) as u16, bytes: chunk.to_vec() },
                pct_oracle::accounts::WriteBuffer { authority: payer, buffer },
            )])?;
        }
        Ok(buffer)
    }

    pub fn close_buffer(&mut self) {
        let payer = self.payer.pubkey();
        let buffer = pda(&[b"buffer", payer.as_ref()]);
        if self.svm.get_account(&buffer).is_some_and(|a| a.lamports > 0) {
            self.send(&[Harness::ix(
                pct_oracle::instruction::CloseBuffer {},
                pct_oracle::accounts::CloseBuffer { authority: payer, buffer },
            )])
            .unwrap();
        }
    }

    pub fn account<T: AccountDeserialize>(&self, address: &Pubkey) -> T {
        let account = self.svm.get_account(address).unwrap();
        T::try_deserialize(&mut account.data.as_slice()).unwrap()
    }
}
