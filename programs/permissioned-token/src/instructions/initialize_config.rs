use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::{
    extension::{permanent_delegate::get_permanent_delegate, StateWithExtensions},
    state::Mint as SplMint,
};
use anchor_spl::token_interface::Mint;

use crate::{constants::CONFIG_SEED, error::PermissionedTokenError, state::AllowlistConfig};

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    /// Must be the mint's own authority — see the handler. Checking this in the
    /// handler rather than as a constraint keeps the `COption` comparison and
    /// its error in one readable place.
    #[account(mut)]
    pub mint_authority: Signer<'info>,

    #[account(
        init,
        payer = mint_authority,
        space = 8 + AllowlistConfig::INIT_SPACE,
        seeds = [CONFIG_SEED, mint.key().as_ref()],
        bump
    )]
    pub config: Account<'info, AllowlistConfig>,

    pub mint: InterfaceAccount<'info, Mint>,

    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_config(
    ctx: Context<InitializeConfig>,
    allowlist_authority: Pubkey,
    enforcement_authority: Pubkey,
) -> Result<()> {
    // The config PDA is derived from the mint alone and created with `init`, so
    // exactly one caller can ever succeed. Without this check that caller is
    // whoever gets there first, and mint setup leaves a window between creating
    // the mint and creating the config. Winning that race would hand over the
    // allowlist and the enforcement bypass permanently.
    let mint_authority: Option<Pubkey> = ctx.accounts.mint.mint_authority.into();
    require!(
        mint_authority == Some(ctx.accounts.mint_authority.key()),
        PermissionedTokenError::UnauthorizedConfigInitializer
    );

    // The bypass in `execute` is keyed to `enforcement_authority`, so taking it
    // from the argument would let even a legitimate issuer nominate a key that
    // is not actually the delegate. Read it from mint state instead.
    {
        let mint_info = ctx.accounts.mint.to_account_info();
        let mint_data = mint_info.try_borrow_data()?;
        let mint_state = StateWithExtensions::<SplMint>::unpack(&mint_data)?;
        require!(
            get_permanent_delegate(&mint_state) == Some(enforcement_authority),
            PermissionedTokenError::EnforcementAuthorityMismatch
        );
    }

    let config = &mut ctx.accounts.config;
    config.mint = ctx.accounts.mint.key();
    config.allowlist_authority = allowlist_authority;
    config.enforcement_authority = enforcement_authority;
    config.bump = ctx.bumps.config;

    Ok(())
}
