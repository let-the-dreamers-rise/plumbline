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
#[constant]
pub const LOAN_SEED: &[u8] = b"loan";

pub const LOAN_HISTORY: usize = 13;
/// Currencies whose minor unit is not 1/100 (zero- or three-decimal); `amount_cents` would be
/// misread for them, so loans in these currencies are refused.
pub const NON_CENT_CURRENCIES: [&[u8; 3]; 21] = [
    b"BIF", b"CLP", b"DJF", b"GNF", b"ISK", b"JPY", b"KMF", b"KRW", b"MGA", b"PYG", b"RWF", b"UGX", b"VND", b"VUV", b"XAF", b"XOF",
    b"BHD", b"JOD", b"KWD", b"OMR", b"TND",
];

pub const MAX_ATTESTORS: usize = 8;
pub const BOOK_CAPACITY: usize = 32;
pub const MAX_CLAIM_BYTES: usize = 4096;

pub const SKU_COUNT: u8 = 3; // 0 H100, 1 H200, 2 B200
pub const KIND_PAID: u8 = 0;
pub const KIND_LIST: u8 = 1;
/// Operator-proven rental revenue for a loan. Never stored in a price book directly.
pub const KIND_REVENUE: u8 = 2;
pub const VALUE_MODE_RATE: u8 = 0;
pub const VALUE_MODE_AMOUNT_HOURS: u8 = 1;
