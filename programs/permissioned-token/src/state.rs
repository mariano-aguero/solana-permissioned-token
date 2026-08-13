use anchor_lang::prelude::*;

/// Per-mint configuration. Exactly one exists per mint, at
/// `[CONFIG_SEED, mint]`.
///
/// Two authorities, deliberately separate. `allowlist_authority` is
/// day-to-day compliance operations. `enforcement_authority` is the seizure
/// path and is checked by the transfer hook, not by the admin instructions.
/// Collapsing them into one key would mean any operator who can approve a
/// holder can also bypass the allowlist.
#[account]
#[derive(InitSpace)]
pub struct AllowlistConfig {
    /// The mint this config governs. Redundant with the PDA seed; kept so the
    /// account is self-describing to off-chain indexers.
    pub mint: Pubkey,
    /// May add and revoke allowlist entries.
    pub allowlist_authority: Pubkey,
    /// The mint's permanent delegate. Transfers this key authorises skip the
    /// **sender** allowlist check, so that seizure still works against a holder
    /// who was just revoked. The recipient check still applies. See /8c.
    ///
    /// `initialize_config` asserts this equals the mint's `PermanentDelegate`
    /// extension rather than trusting the argument. Left unbound, any caller
    /// could nominate themselves and the bypass becomes a general backdoor.
    pub enforcement_authority: Pubkey,
    /// Canonical bump, stored on init and reused. Never accepted from a caller.
    pub bump: u8,
}

/// Membership record for one wallet on one mint, at
/// `[ALLOWLIST_SEED, mint, wallet]`.
///
/// **Its existence is the membership signal.** The hook checks that this
/// account exists and is owned by this program; it does not read a flag. The
/// payload below is for auditability and for the canonical bump, and revocation
/// closes the account rather than clearing a field — so that "not allowed" has
/// exactly one representation.
#[account]
#[derive(InitSpace)]
pub struct AllowlistEntry {
    /// Redundant with the PDA seed; kept for off-chain indexing.
    pub mint: Pubkey,
    /// The approved wallet.
    pub wallet: Pubkey,
    /// Canonical bump, stored on init and reused.
    pub bump: u8,
}
