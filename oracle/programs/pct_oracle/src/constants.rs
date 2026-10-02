use anchor_lang::prelude::*;

#[constant]
pub const CONFIG_SEED: &[u8] = b"config";
#[constant]
pub const SOURCE_SEED: &[u8] = b"source";
#[constant]
pub const BOOK_SEED: &[u8] = b"book";
#[constant]
pub const BUFFER_SEED: &[u8] = b"buffer";
#[constant]
pub const RECEIPT_SEED: &[u8] = b"receipt";

pub const MAX_ATTESTORS: usize = 8;
pub const BOOK_CAPACITY: usize = 32;
pub const MAX_CLAIM_BYTES: usize = 4096;

pub const SKU_COUNT: u8 = 3; // 0 H100, 1 H200, 2 B200
pub const KIND_PAID: u8 = 0;
pub const KIND_LIST: u8 = 1;
pub const VALUE_MODE_RATE: u8 = 0;
pub const VALUE_MODE_AMOUNT_HOURS: u8 = 1;
