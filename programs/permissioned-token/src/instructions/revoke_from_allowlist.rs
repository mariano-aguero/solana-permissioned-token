use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;

use crate::{
    constants::{ALLOWLIST_SEED, CONFIG_SEED},
    error::PermissionedTokenError,
    state::{AllowlistConfig, AllowlistEntry},
};

#[derive(Accounts)]
#[instruction(wallet: Pubkey)]
pub struct RevokeFromAllowlist<'info> {
    /// Checked against `config.allowlist_authority` in the handler. Without it
    /// any signer could close an entry and collect its rent.
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(seeds = [CONFIG_SEED, mint.key().as_ref()], bump = config.bump)]
    pub config: Account<'info, AllowlistConfig>,

    /// Closed rather than flagged, so that "not allowed" has exactly one
    /// representation on chain and the hook only has to check existence.
    #[account(
        mut,
        close = authority,
        seeds = [ALLOWLIST_SEED, mint.key().as_ref(), wallet.as_ref()],
        bump = entry.bump
    )]
    pub entry: Account<'info, AllowlistEntry>,

    pub mint: InterfaceAccount<'info, Mint>,
}

pub fn handle_revoke_from_allowlist(
    ctx: Context<RevokeFromAllowlist>,
    _wallet: Pubkey,
) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.authority.key(),
        ctx.accounts.config.allowlist_authority,
        PermissionedTokenError::UnauthorizedAllowlistAuthority
    );

    // The close itself is the `close = authority` constraint above. Revocation
    // deliberately does not touch the holder's balance or freeze their account:
    // revoking, freezing and seizing stay three independent mechanisms.
    Ok(())
}
