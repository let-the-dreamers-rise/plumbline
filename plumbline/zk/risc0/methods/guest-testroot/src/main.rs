//! TEST ONLY: the sealed_score guest built with tessera-zk-lib's `test-root` feature, so it pins
//! fixtures/test-root.der instead of Intel's root. Same code as guest/src/main.rs; its image id
//! differs, and the registry config decides which image (and which root) it trusts.
use risc0_zkvm::guest::env;
use tessera_zk_lib::prove_score;

fn main() {
    let quote: Vec<u8> = env::read();
    let statement: Vec<u8> = env::read();
    let event_log: Vec<u8> = env::read();
    let journal = prove_score(&quote, &statement, &event_log).expect("quote or statement rejected");
    env::commit_slice(&journal.encode());
}
