use anchor_lang::prelude::*;

#[error_code]
pub enum OracleError {
    #[msg("Only the config authority can do this")]
    Unauthorized,
    #[msg("Too many attestors")]
    TooManyAttestors,
    #[msg("Index parameters are out of range")]
    BadParams,
    #[msg("Unknown sku, kind or value mode")]
    BadSourceShape,
    #[msg("Source is not active")]
    SourceInactive,
    #[msg("Book does not match the source's sku and kind")]
    BookMismatch,
    #[msg("Claim buffer layout is invalid")]
    BadBuffer,
    #[msg("Claim parameters do not match the registered source")]
    ParamsMismatch,
    #[msg("Claim owner must be a lowercase 0x address")]
    BadOwner,
    #[msg("Signature is malformed or unrecoverable")]
    BadSignature,
    #[msg("Claim is not signed by an allowed attestor")]
    UnknownAttestor,
    #[msg("Claim timestamp is too far in the future")]
    FutureClaim,
    #[msg("Claim is too old")]
    StaleClaim,
    #[msg("Receipt key does not match the claim's nullifier")]
    ReceiptMismatch,
    #[msg("Claim is missing an extracted value")]
    MissingParam,
    #[msg("Extracted value is not a valid decimal")]
    BadNumber,
    #[msg("Loan terms are out of range")]
    BadLoanTerms,
    #[msg("Proof is for a different operator than this loan")]
    OperatorMismatch,
    #[msg("No proven revenue for the current or previous period")]
    NoRecentRevenue,
    #[msg("Proven revenue does not cover debt service at the required ratio")]
    CovenantBreached,
    #[msg("Not enough funds in the loan")]
    InsufficientFunds,
    #[msg("Only the loan's borrower can draw")]
    NotBorrower,
    #[msg("Revenue is dated before the loan's revenue history window")]
    RevenueTooOld,
    #[msg("Proof's currency differs from the loan's")]
    CurrencyMismatch,
}

impl From<crate::reclaim::ClaimError> for OracleError {
    fn from(e: crate::reclaim::ClaimError) -> Self {
        use crate::reclaim::ClaimError::*;
        match e {
            BadOwner => OracleError::BadOwner,
            BadSignature => OracleError::BadSignature,
            MissingParam => OracleError::MissingParam,
            BadNumber => OracleError::BadNumber,
        }
    }
}
