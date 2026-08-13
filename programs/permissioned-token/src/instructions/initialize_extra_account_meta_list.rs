use anchor_lang::prelude::*;
use anchor_lang::system_program::{allocate, assign, transfer, Allocate, Assign, Transfer};
use anchor_spl::token_interface::Mint;
use spl_tlv_account_resolution::{
    account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList,
};
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

use crate::{
    constants::{ALLOWLIST_SEED, CONFIG_SEED, EXTRA_ACCOUNT_METAS_SEED, TOKEN_ACCOUNT_OWNER_OFFSET},
    error::PermissionedTokenError,
};

#[derive(Accounts)]
pub struct InitializeExtraAccountMetaList<'info> {
    /// Must be the mint's own authority — asserted in the handler, the same way
    /// `initialize_config` does it. Left open, anyone could race the issuer to
    /// this instruction.
    ///
    /// Named for the authorisation it carries, not the fee it pays. It happens
    /// to fund the account too, but `payer` would describe the lesser of its
    /// two roles and hide the one that matters.
    #[account(mut)]
    pub mint_authority: Signer<'info>,

    /// CHECK: written by `spl_tlv_account_resolution` in TLV format rather than
    /// as an Anchor account, so it cannot be a typed account. Safety comes from
    /// the seed constraint: Token-2022 derives this same address itself when it
    /// CPIs into the hook, so a wrong address is unreachable, not exploitable.
    #[account(
        mut,
        seeds = [EXTRA_ACCOUNT_METAS_SEED, mint.key().as_ref()],
        bump
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,

    pub mint: InterfaceAccount<'info, Mint>,

    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_extra_account_meta_list(
    ctx: Context<InitializeExtraAccountMetaList>,
) -> Result<()> {
    let expected: Option<Pubkey> = ctx.accounts.mint.mint_authority.into();
    require!(
        expected == Some(ctx.accounts.mint_authority.key()),
        PermissionedTokenError::UnauthorizedMetaListInitializer
    );

    // Declares which accounts Token-2022 must resolve and append to `Execute`,
    // and how to derive each from accounts already present in the transfer.
    //
    // Interface-fixed indices: 0 source token, 1 mint, 2 destination token,
    // 3 authority, 4 this list. Ours land at 5, 6, 7 in this order.
    let account_metas = vec![
        // 5 — AllowlistConfig, from the mint.
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal {
                    bytes: CONFIG_SEED.to_vec(),
                },
                Seed::AccountKey { index: 1 },
            ],
            false,
            false,
        )?,
        // 6 — sender's entry, derived from the SOURCE ACCOUNT'S OWNER FIELD
        // (index 0, offset 32) and deliberately not from the authority at
        // index 3. Under a permanent-delegate transfer the authority is the
        // delegate, so index 3 would resolve the delegate's membership instead
        // of the holder's — checking the wrong subject during a seizure.
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal {
                    bytes: ALLOWLIST_SEED.to_vec(),
                },
                Seed::AccountKey { index: 1 },
                Seed::AccountData {
                    account_index: 0,
                    data_index: TOKEN_ACCOUNT_OWNER_OFFSET,
                    length: 32,
                },
            ],
            false,
            false,
        )?,
        // 7 — recipient's entry, same derivation from the destination account.
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal {
                    bytes: ALLOWLIST_SEED.to_vec(),
                },
                Seed::AccountKey { index: 1 },
                Seed::AccountData {
                    account_index: 2,
                    data_index: TOKEN_ACCOUNT_OWNER_OFFSET,
                    length: 32,
                },
            ],
            false,
            false,
        )?,
    ];

    let account_size = ExtraAccountMetaList::size_of(account_metas.len())?;
    let lamports = Rent::get()?.minimum_balance(account_size);

    let mint_key = ctx.accounts.mint.key();
    let bump = ctx.bumps.extra_account_meta_list;
    let signer_seeds: &[&[&[u8]]] = &[&[EXTRA_ACCOUNT_METAS_SEED, mint_key.as_ref(), &[bump]]];

    // Deliberately NOT `create_account`, which fails with `AccountAlreadyInUse`
    // whenever the destination already holds lamports. The address is a PDA
    // derived from the mint and the program id, so anyone can compute it as
    // soon as the mint exists, and mint setup creates this account in a later
    // transaction. A deposit into that window would make `create_account` fail
    // permanently — and with no meta list, `invoke_execute` CPIs `execute` with
    // only four accounts, so every transfer of that mint dies with
    // `NotEnoughAccountKeys`, unrecoverable without redeploying the program at
    // a new id.
    //
    // The cheapest such deposit is the rent-exempt minimum for a zero-length
    // account, not one lamport: Solana rejects any transaction that leaves an
    // account below rent exemption. Still under a thousandth of a SOL.
    //
    // transfer + allocate + assign has no such precondition: a pre-funded
    // account is simply topped up to rent exemption and then claimed.
    let meta_list = ctx.accounts.extra_account_meta_list.to_account_info();
    let current_lamports = meta_list.lamports();

    if current_lamports < lamports {
        let shortfall = lamports
            .checked_sub(current_lamports)
            .ok_or(ProgramError::ArithmeticOverflow)?;
        transfer(
            CpiContext::new(
                anchor_lang::system_program::ID,
                Transfer {
                    from: ctx.accounts.mint_authority.to_account_info(),
                    to: meta_list.clone(),
                },
            ),
            shortfall,
        )?;
    }

    allocate(
        CpiContext::new(
            anchor_lang::system_program::ID,
            Allocate {
                account_to_allocate: meta_list.clone(),
            },
        )
        .with_signer(signer_seeds),
        account_size as u64,
    )?;

    assign(
        CpiContext::new(
            anchor_lang::system_program::ID,
            Assign {
                account_to_assign: meta_list,
            },
        )
        .with_signer(signer_seeds),
        ctx.program_id,
    )?;

    let mut data = ctx.accounts.extra_account_meta_list.try_borrow_mut_data()?;
    ExtraAccountMetaList::init::<ExecuteInstruction>(&mut data, &account_metas)?;

    Ok(())
}
