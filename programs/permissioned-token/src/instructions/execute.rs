use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::{
    extension::{
        transfer_hook::TransferHookAccount, BaseStateWithExtensions, StateWithExtensions,
    },
    state::Account as SplTokenAccount,
};
use anchor_spl::token_interface::{Mint, TokenAccount};

use crate::{
    constants::{ALLOWLIST_SEED, CONFIG_SEED, EXTRA_ACCOUNT_METAS_SEED},
    error::PermissionedTokenError,
    state::AllowlistConfig,
};

/// Accounts for the Transfer Hook interface's `Execute`.
///
/// The first five are fixed by the interface and always arrive in this order.
/// The rest are resolved by Token-2022 from `ExtraAccountMetaList`.
///
/// **The resolved accounts are untrusted caller input.** `ExtraAccountMetaList`
/// tells a *client* which accounts to attach; nothing forces the client to
/// comply. Every PDA below is therefore re-derived here by Anchor from the token
/// accounts this program reads itself. Without that, a caller could attach any
/// existing `AllowlistEntry` and pass the check for a wallet that is not a party
/// to the transfer.
#[derive(Accounts)]
pub struct Execute<'info> {
    /// Bound to `mint`. Anchor does not check that a token account belongs to a
    /// given mint, so without this a caller could present accounts of one mint
    /// while having membership evaluated against another's allowlist. Token-2022
    /// supplies these itself during a real transfer, so this is defence in
    /// depth — but it means the layout is sound on its own terms rather than
    /// only because `assert_transferring` makes the instruction unreachable.
    #[account(constraint = source_token.mint == mint.key())]
    pub source_token: InterfaceAccount<'info, TokenAccount>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(constraint = destination_token.mint == mint.key())]
    pub destination_token: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: the account that authorised the transfer, compared against
    /// `config.enforcement_authority` in the handler and otherwise only an
    /// identity.
    ///
    /// **This account is NOT a signer.** `spl-transfer-hook-interface` builds
    /// the `Execute` CPI with `is_signer: false` for it, so the seizure bypass
    /// keyed to it is meaningful *only* because `assert_transferring` makes
    /// this instruction unreachable outside a genuine Token-2022 transfer,
    /// where Token-2022 chooses the authority. Delete that guard as
    /// "redundant" and the bypass becomes forgeable by any caller.
    ///
    /// Note also this is the *signer*, which under a permanent-delegate
    /// transfer is the delegate and not the holder; the sender's allowlist
    /// entry is derived from `source_token.owner` below for that reason.
    pub authority: UncheckedAccount<'info>,

    /// CHECK: TLV buffer, not an Anchor account. Constrained by seeds.
    #[account(
        seeds = [EXTRA_ACCOUNT_METAS_SEED, mint.key().as_ref()],
        bump
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,

    #[account(seeds = [CONFIG_SEED, mint.key().as_ref()], bump = config.bump)]
    pub config: Account<'info, AllowlistConfig>,

    /// CHECK: may legitimately not exist — a non-member's entry was never
    /// created, or was closed by revocation. Typing this as
    /// `Account<AllowlistEntry>` would make Anchor fail deserialization before
    /// the handler runs, producing a generic error instead of
    /// `SenderNotAllowed`. `is_allowlisted` checks ownership and data length.
    ///
    /// `source_token.owner` is the SPL token account's owner field, not the
    /// account's program owner.
    #[account(
        seeds = [ALLOWLIST_SEED, mint.key().as_ref(), source_token.owner.as_ref()],
        bump
    )]
    pub sender_entry: UncheckedAccount<'info>,

    /// CHECK: same reasoning as `sender_entry`, for `RecipientNotAllowed`.
    #[account(
        seeds = [ALLOWLIST_SEED, mint.key().as_ref(), destination_token.owner.as_ref()],
        bump
    )]
    pub recipient_entry: UncheckedAccount<'info>,
}

/// Membership is the existence of the PDA, not a flag inside it. An absent
/// entry arrives as a system-owned, zero-length account.
fn is_allowlisted(entry: &UncheckedAccount, program_id: &Pubkey) -> bool {
    entry.owner == program_id && !entry.data_is_empty()
}

/// Token-2022 sets `transferring` on both token accounts only for the duration
/// of a transfer, so this is what distinguishes a genuine hook invocation from
/// someone calling `execute` directly.
fn assert_transferring(info: &AccountInfo) -> Result<()> {
    let data = info.try_borrow_data()?;
    let state = StateWithExtensions::<SplTokenAccount>::unpack(&data)?;
    let extension = state
        .get_extension::<TransferHookAccount>()
        .map_err(|_| error!(PermissionedTokenError::InvalidHookInvocation))?;

    require!(
        bool::from(extension.transferring),
        PermissionedTokenError::InvalidHookInvocation
    );
    Ok(())
}

pub fn handle_execute(ctx: Context<Execute>, _amount: u64) -> Result<()> {
    // Both accounts, though in practice they cannot disagree: Token-2022 sets
    // the flag on both for the duration of one transfer, so neither call can
    // fail independently of the other. Kept per-account rather than collapsed
    // to one, because the invariant being asserted is about each account, and
    // the cost is a few hundred compute units on a guard the whole seizure
    // bypass depends on. See the `authority` field's note above.
    assert_transferring(&ctx.accounts.source_token.to_account_info())?;
    assert_transferring(&ctx.accounts.destination_token.to_account_info())?;

    // 1. Recipient, unconditionally. The seizure bypass below does not cover
    //    this: an issuer seizing assets sends them to its own treasury, which
    //    is an approved holder, so the power to send to an unverified
    //    destination satisfies no requirement.
    require!(
        is_allowlisted(&ctx.accounts.recipient_entry, ctx.program_id),
        PermissionedTokenError::RecipientNotAllowed
    );

    // 2. Seizure path. The hook runs on permanent-delegate transfers too, so
    //    without this a revoked holder becomes unseizable — the allowlist would
    //    protect exactly the wallet the issuer just sanctioned.
    //    Keyed to on-chain config, which `initialize_config` binds to the
    //    mint's real PermanentDelegate, so it is not nominable.
    if ctx.accounts.authority.key() == ctx.accounts.config.enforcement_authority {
        return Ok(());
    }

    // 3. Sender.
    require!(
        is_allowlisted(&ctx.accounts.sender_entry, ctx.program_id),
        PermissionedTokenError::SenderNotAllowed
    );

    Ok(())
}
