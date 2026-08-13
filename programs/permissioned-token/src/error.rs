use anchor_lang::prelude::*;

#[error_code]
pub enum PermissionedTokenError {
    /// Only the mint's authority may create the config. Without this,
    /// `initialize_config` is permissionless and the config PDA uses `init`, so
    /// an attacker who lands the instruction before the issuer owns the
    /// allowlist and the enforcement bypass for that mint permanently.
    #[msg("Signer is not the mint authority")]
    UnauthorizedConfigInitializer,

    /// The `enforcement_authority` argument must equal the mint's
    /// `PermanentDelegate` extension. The bypass exists to let the real
    /// delegate seize assets; binding it to on-chain mint state means the
    /// caller cannot nominate an arbitrary key as the enforcement authority.
    #[msg("Enforcement authority does not match the mint's permanent delegate")]
    EnforcementAuthorityMismatch,

    /// Allowlist mutation is restricted to the configured authority.
    #[msg("Signer is not the allowlist authority for this mint")]
    UnauthorizedAllowlistAuthority,

    /// The owner of the source token account has no allowlist entry, and the
    /// transfer was not authorised by the enforcement authority.
    #[msg("Source account owner is not on the allowlist")]
    SenderNotAllowed,

    /// The owner of the destination token account has no allowlist entry.
    ///
    /// Unconditional — the enforcement bypass does **not** cover this check.
    /// Seizure moves assets to the issuer's treasury, which is itself an
    /// approved holder; there is no case where the issuer needs to move tokens
    /// to an unverified destination.
    #[msg("Destination account owner is not on the allowlist")]
    RecipientNotAllowed,

    /// The hook was invoked outside a Token-2022 transfer. Enforced by checking
    /// the `TransferHookAccount.transferring` flag on the source and
    /// destination accounts, which Token-2022 sets only for the duration of a
    /// transfer.
    #[msg("Transfer hook must be invoked by the token program during a transfer")]
    InvalidHookInvocation,

    /// Only the mint authority may create the extra account meta list. Same
    /// race as `UnauthorizedConfigInitializer`, different instruction — see
    /// `initialize_extra_account_meta_list`.
    ///
    /// Appended rather than grouped with the other authority errors on purpose:
    /// Anchor assigns codes positionally from 6000, so inserting here would
    /// renumber `InvalidHookInvocation` and silently break any client pinning
    /// numeric codes.
    #[msg("Signer is not the mint authority")]
    UnauthorizedMetaListInitializer,
}
