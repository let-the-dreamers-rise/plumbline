pub mod constants;
pub mod error;
pub mod groth16;
pub mod instructions;
pub mod math;
pub mod reclaim;
pub mod sp1_vk;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("2jvEsAiBYWPeiSzb54qMgBbtbQivQkK5ZiTkp2bgZ6kz");

/// Paid Compute Tape oracle: verifies Reclaim zkTLS claims of GPU prices onchain and
/// publishes a manipulation-resistant paid-price index per (sku, kind).
#[program]
pub mod pct_oracle {
    use super::*;

    pub fn initialize_config(ctx: Context<InitializeConfig>, attestors: Vec<[u8; 20]>, params: IndexParams) -> Result<()> {
        instructions::admin::handle_initialize_config(ctx, attestors, params)
    }

    pub fn update_config(ctx: Context<UpdateConfig>, attestors: Vec<[u8; 20]>, params: IndexParams) -> Result<()> {
        instructions::admin::handle_update_config(ctx, attestors, params)
    }

    pub fn register_source(ctx: Context<RegisterSource>, args: SourceArgs) -> Result<()> {
        instructions::admin::handle_register_source(ctx, args)
    }

    pub fn set_source_active(ctx: Context<SetSourceActive>, active: bool) -> Result<()> {
        instructions::admin::handle_set_source_active(ctx, active)
    }

    pub fn init_book(ctx: Context<InitBook>, sku: u8, kind: u8) -> Result<()> {
        instructions::admin::handle_init_book(ctx, sku, kind)
    }

    pub fn open_buffer(ctx: Context<OpenBuffer>, provider_len: u16, parameters_len: u16, context_len: u16) -> Result<()> {
        instructions::buffer::handle_open_buffer(ctx, provider_len, parameters_len, context_len)
    }

    pub fn write_buffer(ctx: Context<WriteBuffer>, offset: u16, bytes: Vec<u8>) -> Result<()> {
        instructions::buffer::handle_write_buffer(ctx, offset, bytes)
    }

    pub fn close_buffer(ctx: Context<CloseBuffer>) -> Result<()> {
        instructions::buffer::handle_close_buffer(ctx)
    }

    pub fn submit_observation(ctx: Context<SubmitObservation>, sig: ClaimSig, receipt_key: [u8; 32]) -> Result<()> {
        instructions::submit::handle_submit_observation(ctx, sig, receipt_key)
    }

    pub fn crank_index(ctx: Context<CrankIndex>) -> Result<()> {
        instructions::crank::handle_crank_index(ctx)
    }

    pub fn open_loan(ctx: Context<OpenLoan>, terms: LoanTerms) -> Result<()> {
        instructions::lending::handle_open_loan(ctx, terms)
    }

    pub fn fund_loan(ctx: Context<FundLoan>, lamports: u64) -> Result<()> {
        instructions::lending::handle_fund_loan(ctx, lamports)
    }

    pub fn submit_revenue(ctx: Context<SubmitRevenue>, sig: ClaimSig, receipt_key: [u8; 32]) -> Result<()> {
        instructions::lending::handle_submit_revenue(ctx, sig, receipt_key)
    }

    pub fn draw(ctx: Context<Draw>, lamports: u64) -> Result<()> {
        instructions::lending::handle_draw(ctx, lamports)
    }

    pub fn withdraw(ctx: Context<Withdraw>, lamports: u64) -> Result<()> {
        instructions::lending::handle_withdraw(ctx, lamports)
    }

    pub fn set_zk_config(ctx: Context<SetZkConfig>, program_vkey: [u8; 32], attestor_threshold: u8) -> Result<()> {
        instructions::zk::handle_set_zk_config(ctx, program_vkey, attestor_threshold)
    }

    pub fn issue_gpu_challenge(ctx: Context<IssueGpuChallenge>, challenge: [u8; 32]) -> Result<()> {
        instructions::zk::handle_issue_gpu_challenge(ctx, challenge)
    }

    pub fn prove_covenant(ctx: Context<ProveCovenant>, proof: Vec<u8>, public_values: Vec<u8>, as_of_period: u32) -> Result<()> {
        instructions::zk::handle_prove_covenant(ctx, proof, public_values, as_of_period)
    }

    pub fn draw_private(ctx: Context<DrawPrivate>, lamports: u64) -> Result<()> {
        instructions::zk::handle_draw_private(ctx, lamports)
    }
}
