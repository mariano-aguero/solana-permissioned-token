use anchor_lang::prelude::*;

/// PDA seed for the per-mint [`crate::state::AllowlistConfig`].
#[constant]
pub const CONFIG_SEED: &[u8] = b"config";

/// PDA seed for a per-wallet [`crate::state::AllowlistEntry`].
#[constant]
pub const ALLOWLIST_SEED: &[u8] = b"allow";

/// PDA seed Token-2022 uses to locate the extra account meta list.
///
/// **Fixed by the transfer hook interface — not ours to choose.** Token-2022
/// derives this address itself when it CPIs into the hook, so a different value
/// here means the program is simply never reached, with no error to explain it.
/// The interface's own copy of this seed is private, so it cannot be imported;
/// the unit test below pins the two together via the public address helper.
#[constant]
pub const EXTRA_ACCOUNT_METAS_SEED: &[u8] = b"extra-account-metas";

/// Byte offset of the `owner` field within an SPL token account.
///
/// The hook derives the sender's allowlist entry from the source account's
/// owner, read out of account data, rather than from the transfer authority.
/// Under a permanent-delegate transfer the authority is the delegate, not the
/// holder, so deriving from it would check the wrong subject entirely.
pub const TOKEN_ACCOUNT_OWNER_OFFSET: u8 = 32;

#[cfg(test)]
mod tests {
    use super::*;

    /// The claim this file used to make in a comment, now actually checked.
    ///
    /// A wrong seed here is invisible: the program compiles, deploys, and is
    /// simply never invoked, so every transfer either fails opaquely or — worse
    /// — succeeds unenforced. Compared through the interface's public address
    /// helper, and by bytes rather than by `Pubkey`, because two versions of
    /// `solana-pubkey` coexist in this dependency graph.
    #[test]
    fn extra_account_metas_seed_matches_the_transfer_hook_interface() {
        const MINT: [u8; 32] = [7u8; 32];
        const PROGRAM: [u8; 32] = [9u8; 32];

        let ours = anchor_lang::prelude::Pubkey::find_program_address(
            &[EXTRA_ACCOUNT_METAS_SEED, &MINT],
            &anchor_lang::prelude::Pubkey::new_from_array(PROGRAM),
        )
        .0;

        let theirs = spl_transfer_hook_interface::get_extra_account_metas_address(
            &spl_transfer_hook_interface::solana_pubkey::Pubkey::new_from_array(MINT),
            &spl_transfer_hook_interface::solana_pubkey::Pubkey::new_from_array(PROGRAM),
        );

        assert_eq!(ours.to_bytes(), theirs.to_bytes());
    }
}
