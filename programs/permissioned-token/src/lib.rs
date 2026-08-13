//! Permissioned SPL Token-2022 mint.
//!
//! Transfers are gated by an on-chain allowlist enforced through the Token-2022
//! Transfer Hook interface.

pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;
use spl_discriminator::SplDiscriminate;
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

pub use constants::*;
pub use error::*;
pub use instructions::*;
pub use state::*;

declare_id!("8TRoqPLZP6yqBj6qUzqjaotogH7o25tRmhcKGXDPc87d");

#[program]
pub mod permissioned_token {
    use super::*;

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        allowlist_authority: Pubkey,
        enforcement_authority: Pubkey,
    ) -> Result<()> {
        instructions::initialize_config::handle_initialize_config(
            ctx,
            allowlist_authority,
            enforcement_authority,
        )
    }

    pub fn add_to_allowlist(ctx: Context<AddToAllowlist>, wallet: Pubkey) -> Result<()> {
        instructions::add_to_allowlist::handle_add_to_allowlist(ctx, wallet)
    }

    pub fn revoke_from_allowlist(ctx: Context<RevokeFromAllowlist>, wallet: Pubkey) -> Result<()> {
        instructions::revoke_from_allowlist::handle_revoke_from_allowlist(ctx, wallet)
    }

    pub fn initialize_extra_account_meta_list(
        ctx: Context<InitializeExtraAccountMetaList>,
    ) -> Result<()> {
        instructions::initialize_extra_account_meta_list::handle_initialize_extra_account_meta_list(
            ctx,
        )
    }

    /// Invoked by Token-2022 via CPI on every transfer, never called directly.
    ///
    /// The discriminator override is load-bearing. Anchor would otherwise
    /// derive one from `global:execute`, while Token-2022 dispatches on the
    /// hash of `spl-transfer-hook-interface:execute`. Without this line the
    /// program still compiles, deploys, and passes any test that calls
    /// `execute` directly — while never being reached during an actual
    /// transfer. A permissioned token that permits everything, with a green
    /// suite. Anchor 1.x replaced the old `#[interface(...)]` attribute, which
    /// every published example still uses, with this general form.
    #[instruction(discriminator = ExecuteInstruction::SPL_DISCRIMINATOR_SLICE)]
    pub fn execute(ctx: Context<Execute>, amount: u64) -> Result<()> {
        instructions::execute::handle_execute(ctx, amount)
    }
}
