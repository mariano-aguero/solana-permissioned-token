/**
 * — frozen by default, and thawing.
 *
 * Covers and . The point of these tests is not that the extension
 * works — the spike already showed that — but that the allowlist and the frozen
 * default are **two independent gates**, and that a holder needs to clear both.
 *
 * That independence is the design: the allowlist governs transferring, the
 * frozen default governs holding, and it covers the window between an account
 * being created and anyone approving it. Approval is an act, not the absence of
 * a block.
 */
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { Keypair } from "@solana/web3.js";
import { assert } from "chai";

import { PermissionedToken } from "../target/types/permissioned_token";
import {
  balanceOf,
  createHolderAccount,
  expectAnchorError,
  expectFailure,
  isFrozen,
  mintTokens,
  setupEnforcedMint,
  thawHolderAccount,
  transfer,
} from "./helpers";

describe("account lifecycle", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .permissionedToken as Program<PermissionedToken>;

  it("a newly created token account lands Frozen", async () => {
    const holder = Keypair.generate();
    const ctx = await setupEnforcedMint(provider, program, [holder.publicKey]);

    const ata = await createHolderAccount(provider, ctx, holder.publicKey, {
      thaw: false,
    });

    assert.isTrue(
      await isFrozen(provider, ata),
      "DefaultAccountState = Frozen is not taking effect"
    );
  });

  it("an allowlisted but unthawed account still cannot receive", async () => {
    const alice = Keypair.generate();
    const bob = Keypair.generate();
    // Both approved by compliance...
    const ctx = await setupEnforcedMint(provider, program, [
      alice.publicKey,
      bob.publicKey,
    ]);

    const aliceAta = await createHolderAccount(provider, ctx, alice.publicKey);
    // ...but Bob's account was never thawed.
    const bobAta = await createHolderAccount(provider, ctx, bob.publicKey, {
      thaw: false,
    });
    await mintTokens(provider, ctx, aliceAta, 100n);

    // Rejected by Token-2022 itself, before the hook is ever consulted, so this
    // is not an Anchor error from our program.
    await expectFailure(transfer(provider, ctx, aliceAta, bobAta, alice, 10n));

    assert.equal(await balanceOf(provider, aliceAta), 100n);
    assert.equal(await balanceOf(provider, bobAta), 0n);
  });

  it("thawing an allowlisted account enables it to receive", async () => {
    const alice = Keypair.generate();
    const dave = Keypair.generate();
    const ctx = await setupEnforcedMint(provider, program, [
      alice.publicKey,
      dave.publicKey,
    ]);

    const aliceAta = await createHolderAccount(provider, ctx, alice.publicKey);
    const daveAta = await createHolderAccount(provider, ctx, dave.publicKey, {
      thaw: false,
    });
    await mintTokens(provider, ctx, aliceAta, 100n);

    await expectFailure(transfer(provider, ctx, aliceAta, daveAta, alice, 10n));

    // The onboarding step that was missing.
    await thawHolderAccount(provider, ctx, daveAta);
    assert.isFalse(await isFrozen(provider, daveAta));

    await transfer(provider, ctx, aliceAta, daveAta, alice, 10n);

    assert.equal(await balanceOf(provider, daveAta), 10n);
    assert.equal(await balanceOf(provider, aliceAta), 90n);
  });

  it("the two gates are independent: thawed is not the same as approved", async () => {
    const alice = Keypair.generate();
    const carol = Keypair.generate(); // thawed, never allowlisted
    const ctx = await setupEnforcedMint(provider, program, [alice.publicKey]);

    const aliceAta = await createHolderAccount(provider, ctx, alice.publicKey);
    const carolAta = await createHolderAccount(provider, ctx, carol.publicKey);
    await mintTokens(provider, ctx, aliceAta, 100n);

    assert.isFalse(
      await isFrozen(provider, carolAta),
      "Carol's account is thawed — the only thing missing is approval"
    );

    // Clearing the freeze gate does not clear the allowlist gate. The mirror of
    // the test above, where approval did not clear the freeze.
    await expectAnchorError(
      transfer(provider, ctx, aliceAta, carolAta, alice, 10n),
      "RecipientNotAllowed"
    );

    assert.equal(await balanceOf(provider, carolAta), 0n);
  });
});
