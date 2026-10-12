//! Plumbline registry (from the Tessera sealed-eval registry).
//!
//! Replaces the `tessera:score:v1:<statement_hash>:<correct>/<n>` memo with real accounts:
//! - `ScoreRecord` PDA ["score", statement_hash]: one per attested statement, write-once.
//! - `Suite` PDA ["suite", suite_commitment]: a test set's author and price, so a test-set
//!   marketplace can hang off it later.
//!
//! Field derivations (see bundle_to_args.py, which reads a bundle written by tessera_eval.py):
//!   statement_hash   = sha256(canonical(statement))            (bundle.statement_sha256)
//!   model_id_hash    = sha256(b"tessera:model:v1" + canonical({model_id, model_revision, weights_sha256}))
//!   suite_commitment = statement.suite_commitment              (sha256(canonical(suite.json)))
//!   quote_hash       = sha256(score TDX quote bytes)
//!   mr_td            = TD measurement from the quote (48 bytes)
//!
//! `record_score` does not verify the quote: such a record says "this statement hash was published
//! at this slot by this key". `record_verified_score` takes a RISC Zero Groth16 proof that the
//! sealed-eval guest (sealed-eval-zk) verified the TDX score quote to the pinned Intel root, that
//! its report_data commits to the statement, and that the dstack event log replays to the quote's
//! RTMR3 with the approved app compose hash (so the score came from the approved enclave code, not
//! from any TDX VM); it writes a separate `VerifiedScore` PDA
//! ["verified", statement_hash], so an unverified record can never block a verified one.
//!
//! Plumbline: the guest journal ends with the entrant's payout pubkey (330 bytes), taken from the
//! statement's `payout` field under the same quote binding. `VerifiedScore.payout` stores it; it is
//! all zero for a statement without `payout`, which the escrow refuses to pay.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::bpf_loader_upgradeable;

pub mod risc0_groth16;
pub mod risc0_vk;

declare_id!("Eicw3HXxXN7kckn5XB4WDGQG2c61BLf7X7QpGehLTgAW");

pub const SCORE_SEED: &[u8] = b"score";
pub const SUITE_SEED: &[u8] = b"suite";
pub const VERIFIED_SEED: &[u8] = b"verified";
pub const CONFIG_SEED: &[u8] = b"config";

/// plumbline/zk journal layout (tessera-zk-lib JOURNAL_LEN):
/// statement_hash 32 | model_id_hash 32 | suite_commitment 32 | quote_hash 32 | mr_td 48 |
/// rtmrs_hash 32 | tee_tcb_svn 16 | root_sha256 32 | correct u32 LE | total u32 LE |
/// binding_version u8 | bound u8 | compose_hash 32 | payout 32
pub const JOURNAL_LEN: usize = 330;

/// Intel SGX Root CA, sha256 of its DER. The production guest pins this root.
pub const INTEL_SGX_ROOT_SHA256: [u8; 32] = [
    0x44, 0xa0, 0x19, 0x6b, 0x2b, 0x99, 0xf8, 0x89, 0xb8, 0xe1, 0x49, 0xe9, 0x5b, 0x80, 0x7a, 0x35, 0x0e, 0x74, 0x24, 0x96,
    0x43, 0x99, 0xe8, 0x85, 0xa7, 0xcb, 0xb8, 0xcc, 0xfa, 0xb6, 0x74, 0xd3,
];

struct ParsedJournal<'a> {
    statement_hash: [u8; 32],
    model_id_hash: [u8; 32],
    suite_commitment: [u8; 32],
    quote_hash: [u8; 32],
    mr_td: [u8; 48],
    rtmrs_hash: [u8; 32],
    tee_tcb_svn: [u8; 16],
    root_sha256: &'a [u8],
    correct: u32,
    total: u32,
    binding_version: u8,
    bound: u8,
    compose_hash: [u8; 32],
    payout: [u8; 32],
}

fn parse_journal(j: &[u8]) -> Result<ParsedJournal<'_>> {
    require!(j.len() == JOURNAL_LEN, RegistryError::BadJournal);
    let a32 = |at: usize| -> [u8; 32] { j[at..at + 32].try_into().unwrap() };
    Ok(ParsedJournal {
        statement_hash: a32(0),
        model_id_hash: a32(32),
        suite_commitment: a32(64),
        quote_hash: a32(96),
        mr_td: j[128..176].try_into().unwrap(),
        rtmrs_hash: a32(176),
        tee_tcb_svn: j[208..224].try_into().unwrap(),
        root_sha256: &j[224..256],
        correct: u32::from_le_bytes(j[256..260].try_into().unwrap()),
        total: u32::from_le_bytes(j[260..264].try_into().unwrap()),
        binding_version: j[264],
        bound: j[265],
        compose_hash: a32(266),
        payout: a32(298),
    })
}

#[program]
pub mod plumbline_registry {
    use super::*;

    /// Register a test suite by its commitment. The signer becomes its author.
    /// `price_mint == None` means the price is in lamports; otherwise it is in that SPL mint
    /// (e.g. USDC), in the mint's base units.
    pub fn register_suite(
        ctx: Context<RegisterSuite>,
        suite_commitment: [u8; 32],
        price: u64,
        price_mint: Option<Pubkey>,
    ) -> Result<()> {
        require!(suite_commitment != [0u8; 32], RegistryError::ZeroHash);
        let clock = Clock::get()?;
        let suite = &mut ctx.accounts.suite;
        suite.author = ctx.accounts.author.key();
        suite.suite_commitment = suite_commitment;
        suite.price = price;
        suite.price_mint = price_mint;
        suite.score_count = 0;
        suite.created_slot = clock.slot;
        suite.bump = ctx.bumps.suite;
        emit!(SuiteRegistered {
            suite: suite.key(),
            author: suite.author,
            suite_commitment,
            price,
            price_mint,
            slot: clock.slot,
        });
        Ok(())
    }

    /// Author-only price change.
    pub fn set_suite_price(
        ctx: Context<SetSuitePrice>,
        price: u64,
        price_mint: Option<Pubkey>,
    ) -> Result<()> {
        let suite = &mut ctx.accounts.suite;
        suite.price = price;
        suite.price_mint = price_mint;
        emit!(SuitePriceSet {
            suite: suite.key(),
            price,
            price_mint,
        });
        Ok(())
    }

    /// One-time setup by the program's upgrade authority: which guest image is trusted, which root
    /// it must have pinned (INTEL_SGX_ROOT_SHA256 in production), which enclave app compose hash a
    /// score must come from, and optionally which TD image (mr_td; all zero = any).
    pub fn init_config(
        ctx: Context<InitConfig>,
        image_id: [u8; 32],
        root_sha256: [u8; 32],
        compose_hash: [u8; 32],
        mr_td: [u8; 48],
    ) -> Result<()> {
        require!(compose_hash != [0u8; 32], RegistryError::ZeroHash);
        let c = &mut ctx.accounts.config;
        c.admin = ctx.accounts.admin.key();
        c.bump = ctx.bumps.config;
        c.apply(image_id, root_sha256, compose_hash, mr_td);
        Ok(())
    }

    /// Admin-only: rotate the trusted guest image, root, enclave compose hash or TD image.
    pub fn set_config(
        ctx: Context<SetConfig>,
        image_id: [u8; 32],
        root_sha256: [u8; 32],
        compose_hash: [u8; 32],
        mr_td: [u8; 48],
    ) -> Result<()> {
        require!(compose_hash != [0u8; 32], RegistryError::ZeroHash);
        ctx.accounts.config.apply(image_id, root_sha256, compose_hash, mr_td);
        Ok(())
    }

    /// Record a score backed by a Groth16 proof of the sealed-eval guest. Permissionless and
    /// write-once per statement; every stored field comes from the proven journal.
    pub fn record_verified_score(
        ctx: Context<RecordVerifiedScore>,
        statement_hash: [u8; 32],
        seal: Vec<u8>,
        journal: Vec<u8>,
    ) -> Result<()> {
        let j = parse_journal(&journal)?;
        let config = &ctx.accounts.config;
        require!(j.statement_hash == statement_hash, RegistryError::JournalMismatch);
        require!(j.bound == 1, RegistryError::QuoteNotBound);
        require!(j.binding_version == 1, RegistryError::BadBindingVersion);
        require!(j.root_sha256 == config.root_sha256, RegistryError::WrongRoot);
        require!(j.compose_hash == config.compose_hash, RegistryError::WrongEnclave);
        require!(config.mr_td == [0u8; 48] || j.mr_td == config.mr_td, RegistryError::WrongEnclave);
        require!(j.total > 0 && j.correct <= j.total, RegistryError::BadScore);
        risc0_groth16::verify(&seal, &config.image_id, &journal).map_err(|_| error!(RegistryError::BadProof))?;

        let suite_registered = match ctx.accounts.suite.as_mut() {
            Some(suite) => {
                require!(suite.suite_commitment == j.suite_commitment, RegistryError::SuiteMismatch);
                suite.score_count = suite.score_count.checked_add(1).unwrap();
                true
            }
            None => false,
        };

        let clock = Clock::get()?;
        let rec = &mut ctx.accounts.score;
        rec.statement_hash = j.statement_hash;
        rec.model_id_hash = j.model_id_hash;
        rec.suite_commitment = j.suite_commitment;
        rec.quote_hash = j.quote_hash;
        rec.mr_td = j.mr_td;
        rec.rtmrs_hash = j.rtmrs_hash;
        rec.tee_tcb_svn = j.tee_tcb_svn;
        rec.compose_hash = j.compose_hash;
        rec.correct = j.correct;
        rec.total = j.total;
        rec.binding_version = j.binding_version;
        rec.image_id = config.image_id;
        rec.suite_registered = suite_registered;
        rec.submitter = ctx.accounts.submitter.key();
        rec.slot = clock.slot;
        rec.unix_timestamp = clock.unix_timestamp;
        rec.payout = Pubkey::new_from_array(j.payout);
        rec.bump = ctx.bumps.score;

        emit!(VerifiedScoreRecorded {
            score: rec.key(),
            statement_hash: j.statement_hash,
            model_id_hash: j.model_id_hash,
            suite_commitment: j.suite_commitment,
            mr_td: j.mr_td,
            correct: j.correct,
            total: j.total,
            image_id: config.image_id,
            submitter: rec.submitter,
            payout: rec.payout,
            slot: clock.slot,
        });
        Ok(())
    }

    /// Record an attested score. Permissionless; fails if this statement hash is already recorded.
    /// Pass the suite's PDA as `suite` when the suite is registered: its commitment must match and
    /// its score count goes up. Omit it for unregistered suites.
    pub fn record_score(
        ctx: Context<RecordScore>,
        statement_hash: [u8; 32],
        model_id_hash: [u8; 32],
        suite_commitment: [u8; 32],
        quote_hash: [u8; 32],
        mr_td: [u8; 48],
        correct: u32,
        total: u32,
        binding_version: u8,
    ) -> Result<()> {
        require!(statement_hash != [0u8; 32], RegistryError::ZeroHash);
        require!(model_id_hash != [0u8; 32], RegistryError::ZeroHash);
        require!(suite_commitment != [0u8; 32], RegistryError::ZeroHash);
        require!(quote_hash != [0u8; 32], RegistryError::ZeroHash);
        require!(mr_td != [0u8; 48], RegistryError::ZeroHash);
        require!(total > 0 && correct <= total, RegistryError::BadScore);
        require!(
            binding_version == 1 || binding_version == 2,
            RegistryError::BadBindingVersion
        );

        let clock = Clock::get()?;
        let suite_registered = match ctx.accounts.suite.as_mut() {
            Some(suite) => {
                // seeds already pin the PDA to suite_commitment; keep the explicit check anyway
                require!(
                    suite.suite_commitment == suite_commitment,
                    RegistryError::SuiteMismatch
                );
                suite.score_count = suite.score_count.checked_add(1).unwrap();
                true
            }
            None => false,
        };

        let rec = &mut ctx.accounts.score;
        rec.statement_hash = statement_hash;
        rec.model_id_hash = model_id_hash;
        rec.suite_commitment = suite_commitment;
        rec.quote_hash = quote_hash;
        rec.mr_td = mr_td;
        rec.correct = correct;
        rec.total = total;
        rec.binding_version = binding_version;
        rec.suite_registered = suite_registered;
        rec.submitter = ctx.accounts.submitter.key();
        rec.slot = clock.slot;
        rec.unix_timestamp = clock.unix_timestamp;
        rec.bump = ctx.bumps.score;

        emit!(ScoreRecorded {
            score: rec.key(),
            statement_hash,
            model_id_hash,
            suite_commitment,
            quote_hash,
            mr_td,
            correct,
            total,
            binding_version,
            submitter: rec.submitter,
            slot: clock.slot,
        });
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(suite_commitment: [u8; 32])]
pub struct RegisterSuite<'info> {
    #[account(
        init,
        payer = author,
        space = 8 + Suite::INIT_SPACE,
        seeds = [SUITE_SEED, suite_commitment.as_ref()],
        bump,
    )]
    pub suite: Account<'info, Suite>,
    #[account(mut)]
    pub author: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetSuitePrice<'info> {
    #[account(
        mut,
        seeds = [SUITE_SEED, suite.suite_commitment.as_ref()],
        bump = suite.bump,
        has_one = author @ RegistryError::NotAuthor,
    )]
    pub suite: Account<'info, Suite>,
    pub author: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(statement_hash: [u8; 32], model_id_hash: [u8; 32], suite_commitment: [u8; 32])]
pub struct RecordScore<'info> {
    #[account(
        init,
        payer = submitter,
        space = 8 + ScoreRecord::INIT_SPACE,
        seeds = [SCORE_SEED, statement_hash.as_ref()],
        bump,
    )]
    pub score: Account<'info, ScoreRecord>,
    #[account(
        mut,
        seeds = [SUITE_SEED, suite_commitment.as_ref()],
        bump = suite.bump,
    )]
    pub suite: Option<Account<'info, Suite>>,
    #[account(mut)]
    pub submitter: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        seeds = [crate::ID.as_ref()],
        bump,
        seeds::program = bpf_loader_upgradeable::ID,
        constraint = program_data.upgrade_authority_address == Some(admin.key()) @ RegistryError::NotUpgradeAuthority,
    )]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetConfig<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ RegistryError::NotAuthor)]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(statement_hash: [u8; 32])]
pub struct RecordVerifiedScore<'info> {
    #[account(
        init,
        payer = submitter,
        space = 8 + VerifiedScore::INIT_SPACE,
        seeds = [VERIFIED_SEED, statement_hash.as_ref()],
        bump,
    )]
    pub score: Account<'info, VerifiedScore>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// Owner + discriminator checked by Account; commitment checked in the handler (suite PDAs are
    /// only ever created at ["suite", commitment]).
    #[account(mut)]
    pub suite: Option<Account<'info, Suite>>,
    #[account(mut)]
    pub submitter: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    /// RISC Zero image id of the trusted sealed-eval guest build.
    pub image_id: [u8; 32],
    /// sha256 of the root certificate the guest must have pinned.
    pub root_sha256: [u8; 32],
    /// dstack app compose hash of the approved enclave (the measured docker-compose).
    pub compose_hash: [u8; 32],
    /// Approved TD image measurement; all zero = not checked.
    pub mr_td: [u8; 48],
    pub bump: u8,
}

impl Config {
    fn apply(&mut self, image_id: [u8; 32], root_sha256: [u8; 32], compose_hash: [u8; 32], mr_td: [u8; 48]) {
        self.image_id = image_id;
        self.root_sha256 = root_sha256;
        self.compose_hash = compose_hash;
        self.mr_td = mr_td;
        emit!(ConfigSet { admin: self.admin, image_id, root_sha256, compose_hash, mr_td });
    }
}

/// A score whose TDX quote was verified (to `root_sha256` of the config at the time) in a proven
/// guest run, and whose quote report_data commits to the statement.
#[account]
#[derive(InitSpace)]
pub struct VerifiedScore {
    pub statement_hash: [u8; 32],
    pub model_id_hash: [u8; 32],
    pub suite_commitment: [u8; 32],
    pub quote_hash: [u8; 32],
    pub mr_td: [u8; 48],
    /// sha256(rtmr0..3): runtime measurements (for dstack, RTMR3 covers the compose hash).
    pub rtmrs_hash: [u8; 32],
    pub tee_tcb_svn: [u8; 16],
    /// dstack app compose hash of the enclave that produced the score (equals the config's).
    pub compose_hash: [u8; 32],
    pub correct: u32,
    pub total: u32,
    pub binding_version: u8,
    /// Guest image that produced the proof.
    pub image_id: [u8; 32],
    pub suite_registered: bool,
    pub submitter: Pubkey,
    pub slot: u64,
    pub unix_timestamp: i64,
    /// Entrant's payout address, proven inside the statement; all zero if the statement had none.
    pub payout: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Suite {
    pub author: Pubkey,
    pub suite_commitment: [u8; 32],
    /// Price to buy access to / run against this suite. Unit set by `price_mint`.
    pub price: u64,
    /// None = lamports, Some(mint) = SPL token (e.g. USDC) base units.
    pub price_mint: Option<Pubkey>,
    pub score_count: u64,
    pub created_slot: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct ScoreRecord {
    pub statement_hash: [u8; 32],
    pub model_id_hash: [u8; 32],
    pub suite_commitment: [u8; 32],
    pub quote_hash: [u8; 32],
    pub mr_td: [u8; 48],
    pub correct: u32,
    pub total: u32,
    /// 1 = tessera:score:v1 (CPU TDX), 2 = tessera:score:v2 (TDX + NVIDIA GPU report)
    pub binding_version: u8,
    pub suite_registered: bool,
    pub submitter: Pubkey,
    pub slot: u64,
    pub unix_timestamp: i64,
    pub bump: u8,
}

#[event]
pub struct SuiteRegistered {
    pub suite: Pubkey,
    pub author: Pubkey,
    pub suite_commitment: [u8; 32],
    pub price: u64,
    pub price_mint: Option<Pubkey>,
    pub slot: u64,
}

#[event]
pub struct ConfigSet {
    pub admin: Pubkey,
    pub image_id: [u8; 32],
    pub root_sha256: [u8; 32],
    pub compose_hash: [u8; 32],
    pub mr_td: [u8; 48],
}

#[event]
pub struct VerifiedScoreRecorded {
    pub score: Pubkey,
    pub statement_hash: [u8; 32],
    pub model_id_hash: [u8; 32],
    pub suite_commitment: [u8; 32],
    pub mr_td: [u8; 48],
    pub correct: u32,
    pub total: u32,
    pub image_id: [u8; 32],
    pub submitter: Pubkey,
    pub payout: Pubkey,
    pub slot: u64,
}

#[event]
pub struct SuitePriceSet {
    pub suite: Pubkey,
    pub price: u64,
    pub price_mint: Option<Pubkey>,
}

#[event]
pub struct ScoreRecorded {
    pub score: Pubkey,
    pub statement_hash: [u8; 32],
    pub model_id_hash: [u8; 32],
    pub suite_commitment: [u8; 32],
    pub quote_hash: [u8; 32],
    pub mr_td: [u8; 48],
    pub correct: u32,
    pub total: u32,
    pub binding_version: u8,
    pub submitter: Pubkey,
    pub slot: u64,
}

#[error_code]
pub enum RegistryError {
    #[msg("hash fields must not be all zero")]
    ZeroHash,
    #[msg("score must have total > 0 and correct <= total")]
    BadScore,
    #[msg("binding_version must be 1 or 2")]
    BadBindingVersion,
    #[msg("suite account does not match suite_commitment")]
    SuiteMismatch,
    #[msg("only the suite author / config admin can do this")]
    NotAuthor,
    #[msg("only the program's upgrade authority can initialise the config")]
    NotUpgradeAuthority,
    #[msg("journal has the wrong length")]
    BadJournal,
    #[msg("statement_hash argument does not match the journal")]
    JournalMismatch,
    #[msg("the TDX quote's report_data does not commit to this statement")]
    QuoteNotBound,
    #[msg("the guest pinned a different root certificate than the config requires")]
    WrongRoot,
    #[msg("the score did not come from the approved enclave (compose hash or mr_td)")]
    WrongEnclave,
    #[msg("Groth16 proof does not verify for the configured guest image and this journal")]
    BadProof,
}
