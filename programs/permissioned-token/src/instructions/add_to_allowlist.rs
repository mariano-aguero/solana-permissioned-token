use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;

use crate::{
    constants::{ALLOWLIST_SEED, CONFIG_SEED},
    error::PermissionedTokenError,
    state::{AllowlistConfig, AllowlistEntry},
};

#[derive(Accounts)]
#[instruction(wallet: Pubkey)]
pub struct AddToAllowlist<'info> {
    /// Checked against `config.allowlist_authority` in the handler.
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(seeds = [CONFIG_SEED, mint.key().as_ref()], bump = config.bump)]
    pub config: Account<'info, AllowlistConfig>,

    /// `init`, never `init_if_needed` — adding an existing member must fail
    /// deterministically rather than silently no-op.
    #[account(
        init,
        payer = authority,
        space = 8 + AllowlistEntry::INIT_SPACE,
        seeds = [ALLOWLIST_SEED, mint.key().as_ref(), wallet.as_ref()],
        bump
    )]
    pub entry: Account<'info, AllowlistEntry>,

    pub mint: InterfaceAccount<'info, Mint>,

    pub system_program: Program<'info, System>,
}

pub fn handle_add_to_allowlist(ctx: Context<AddToAllowlist>, wallet: Pubkey) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.authority.key(),
        ctx.accounts.config.allowlist_authority,
        PermissionedTokenError::UnauthorizedAllowlistAuthority
    );

    // Anchor runs `init` before this handler, so a rejected call has already
    // created the entry by the time we error. That is safe — the whole
    // transaction reverts — but it is why the tests assert the entry is absent
    // afterwards rather than trusting the error alone.
    let entry = &mut ctx.accounts.entry;
    entry.mint = ctx.accounts.mint.key();
    entry.wallet = wallet;
    entry.bump = ctx.bumps.entry;

    Ok(())
}
