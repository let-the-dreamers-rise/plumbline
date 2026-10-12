//! RISC Zero guest for Tessera sealed-eval scores: verifies the enclave's Intel TDX score quote to
//! the pinned Intel SGX Root CA and checks its report_data commits to the score statement
//! (tessera:score:v1), and replays the dstack event log to RTMR3 for the app compose hash. Commits the fixed-layout journal from tessera-zk-lib.
use risc0_zkvm::guest::env;
use tessera_zk_lib::prove_score;

fn main() {
    let quote: Vec<u8> = env::read();
    let statement: Vec<u8> = env::read();
    let event_log: Vec<u8> = env::read();
    let journal = prove_score(&quote, &statement, &event_log).expect("quote or statement rejected");
    env::commit_slice(&journal.encode());
}
