/**
 * — transfer enforcement through the hook.
 *
 * Expected to FAIL until implements `initialize_extra_account_meta_list`
 * and `execute`. Right now the meta list account is never allocated, so
 * Token-2022 cannot resolve the hook's accounts at all.
 */
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  createTransferCheckedWithTransferHookInstruction,
} from "@solana/spl-token";
import { assert } from "chai";

import { PermissionedToken } from "../target/types/permissioned_token";
import {
  allowlistEntryPda,
  balanceOf,
  configPda,
  createHolderAccount,
  expectAnchorError,
  extraAccountMetaListPda,
  mintTokens,
  PermissionedMint,
  setupEnforcedMint,
  transfer,
} from "./helpers";

describe("transfer enforcement", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .permissionedToken as Program<PermissionedToken>;

  /** Shared with the other suites — this file used to carry a private copy. */
  const setupMint = (
    allowlist: PublicKey[],
    opts: { withConfig?: boolean } = {}
  ): Promise<PermissionedMint> =>
    setupEnforcedMint(provider, program, allowlist, opts);

  it("transfer between two allowlisted wallets succeeds", async () => {
    const alice = Keypair.generate();
    const bob = Keypair.generate();
    const ctx = await setupMint([alice.publicKey, bob.publicKey]);

    const aliceAta = await createHolderAccount(provider, ctx, alice.publicKey);
    const bobAta = await createHolderAccount(provider, ctx, bob.publicKey);
    await mintTokens(provider, ctx, aliceAta, 100n);

    await transfer(provider, ctx, aliceAta, bobAta, alice, 40n);

    assert.equal(await balanceOf(provider, aliceAta), 60n);
    assert.equal(await balanceOf(provider, bobAta), 40n);
  });

  it("transfer to a non-allowlisted recipient is rejected", async () => {
    const alice = Keypair.generate();
    const carol = Keypair.generate(); // never allowlisted
    const ctx = await setupMint([alice.publicKey]);

    const aliceAta = await createHolderAccount(provider, ctx, alice.publicKey);
    const carolAta = await createHolderAccount(provider, ctx, carol.publicKey);
    await mintTokens(provider, ctx, aliceAta, 100n);

    await expectAnchorError(
      transfer(provider, ctx, aliceAta, carolAta, alice, 10n),
      "RecipientNotAllowed"
    );

    // Balances, not just the error — a test that only asserts "it threw" cannot
    // tell a rejected transfer from a partially applied one.
    assert.equal(await balanceOf(provider, aliceAta), 100n);
    assert.equal(await balanceOf(provider, carolAta), 0n);
  });

  it("transfer from a non-allowlisted sender is rejected", async () => {
    const alice = Keypair.generate();
    const carol = Keypair.generate(); // holds tokens but is not allowlisted
    const ctx = await setupMint([alice.publicKey]);

    const aliceAta = await createHolderAccount(provider, ctx, alice.publicKey);
    const carolAta = await createHolderAccount(provider, ctx, carol.publicKey);

    // Minting is not a transfer, so the hook does not run — this is how a
    // non-allowlisted wallet can hold a balance at all.
    await mintTokens(provider, ctx, carolAta, 50n);

    await expectAnchorError(
      transfer(provider, ctx, carolAta, aliceAta, carol, 10n),
      "SenderNotAllowed"
    );

    assert.equal(await balanceOf(provider, carolAta), 50n);
    assert.equal(await balanceOf(provider, aliceAta), 0n);
  });

  it("check order: with both parties unapproved, the recipient error wins", async () => {
    const carol = Keypair.generate(); // neither party is allowlisted
    const dan = Keypair.generate();
    const ctx = await setupMint([]);

    const carolAta = await createHolderAccount(provider, ctx, carol.publicKey);
    const danAta = await createHolderAccount(provider, ctx, dan.publicKey);
    await mintTokens(provider, ctx, carolAta, 100n);

    // `contracts/instructions.md` states the check order — recipient, then the
    // seizure bypass, then sender — as part of the contract. Every other test
    // has exactly one party failing, so all of them pass under either ordering.
    // This is the only case that distinguishes them, and therefore the only
    // thing pinning a clause the contract calls binding.
    await expectAnchorError(
      transfer(provider, ctx, carolAta, danAta, carol, 10n),
      "RecipientNotAllowed"
    );

    assert.equal(await balanceOf(provider, carolAta), 100n);
  });

  it("an unmodified client resolves the hook's accounts unaided", async () => {
    const alice = Keypair.generate();
    const bob = Keypair.generate();
    const ctx = await setupMint([alice.publicKey, bob.publicKey]);

    const aliceAta = await createHolderAccount(provider, ctx, alice.publicKey);
    const bobAta = await createHolderAccount(provider, ctx, bob.publicKey);
    await mintTokens(provider, ctx, aliceAta, 100n);

    // The stock SPL helper, given no knowledge of this program beyond what the
    // mint tells it. Every other test in the suite relies on this working, but
    // relying on something is not the same as asserting it.
    const ix = await createTransferCheckedWithTransferHookInstruction(
      provider.connection,
      aliceAta,
      ctx.mint,
      bobAta,
      alice.publicKey,
      10n,
      6,
      [],
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );

    const keys = ix.keys.map((k) => k.pubkey.toBase58());

    assert.include(
      keys,
      program.programId.toBase58(),
      "the hook program was not resolved from the mint"
    );
    assert.include(
      keys,
      extraAccountMetaListPda(ctx.mint, program.programId).toBase58(),
      "the extra account meta list was not attached"
    );
    assert.include(
      keys,
      allowlistEntryPda(ctx.mint, alice.publicKey, program.programId).toBase58(),
      "the sender's allowlist entry was not derived"
    );
    assert.include(
      keys,
      allowlistEntryPda(ctx.mint, bob.publicKey, program.programId).toBase58(),
      "the recipient's allowlist entry was not derived"
    );
    assert.include(
      keys,
      configPda(ctx.mint, program.programId).toBase58(),
      "the config was not derived"
    );
  });

  it("revocation blocks a sender who could transfer a moment ago", async () => {
    const alice = Keypair.generate();
    const bob = Keypair.generate();
    const ctx = await setupMint([alice.publicKey, bob.publicKey]);

    const aliceAta = await createHolderAccount(provider, ctx, alice.publicKey);
    const bobAta = await createHolderAccount(provider, ctx, bob.publicKey);
    await mintTokens(provider, ctx, aliceAta, 100n);

    // Bob is a legitimate holder first. Without establishing that, the
    // rejection below is indistinguishable from 's never-allowlisted case,
    // and this test would prove nothing new.
    await transfer(provider, ctx, aliceAta, bobAta, alice, 40n);
    assert.equal(await balanceOf(provider, bobAta), 40n);

    await program.methods
      .revokeFromAllowlist(bob.publicKey)
      .accountsPartial({
        authority: ctx.issuer.publicKey,
        config: configPda(ctx.mint, program.programId),
        entry: allowlistEntryPda(ctx.mint, bob.publicKey, program.programId),
        mint: ctx.mint,
      })
      .signers([ctx.issuer])
      .rpc();

    // Revocation does not touch the balance — revoking, freezing and seizing
    // are three independent mechanisms.
    assert.equal(await balanceOf(provider, bobAta), 40n);

    await expectAnchorError(
      transfer(provider, ctx, bobAta, aliceAta, bob, 10n),
      "SenderNotAllowed"
    );
    assert.equal(await balanceOf(provider, bobAta), 40n);

    // Revocation cuts both directions: Bob can no longer receive either.
    await expectAnchorError(
      transfer(provider, ctx, aliceAta, bobAta, alice, 10n),
      "RecipientNotAllowed"
    );
    assert.equal(await balanceOf(provider, bobAta), 40n);
  });

  it("an uninitialized config never defaults to permitting", async () => {
    const alice = Keypair.generate();
    const bob = Keypair.generate();

    // Control first. Without proving a correctly configured mint *can* move
    // tokens, the assertion below is vacuous — a hook that rejects everything,
    // or one that is never reached, would pass it just as well.
    const configured = await setupMint([alice.publicKey, bob.publicKey]);
    const okFrom = await createHolderAccount(
      provider,
      configured,
      alice.publicKey
    );
    const okTo = await createHolderAccount(provider, configured, bob.publicKey);
    await mintTokens(provider, configured, okFrom, 10n);
    await transfer(provider, configured, okFrom, okTo, alice, 5n);
    assert.equal(
      await balanceOf(provider, okTo),
      5n,
      "control transfer must succeed or this test proves nothing"
    );

    // Same setup, no config account.
    const bare = await setupMint([], { withConfig: false });
    const from = await createHolderAccount(provider, bare, alice.publicKey);
    const to = await createHolderAccount(provider, bare, bob.publicKey);
    await mintTokens(provider, bare, from, 10n);

    let permitted = true;
    try {
      await transfer(provider, bare, from, to, alice, 5n);
    } catch {
      permitted = false;
    }
    assert.isFalse(
      permitted,
      "a missing config must block transfers, never default to allowing them"
    );
    assert.equal(await balanceOf(provider, to), 0n);
  });
});
