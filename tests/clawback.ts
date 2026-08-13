/**
 * Seizure via the permanent delegate, and the limits of its bypass.
 *
 * The first test is a probe, and the whole design of the bypass rides on its
 * answer. The design assumes the transfer hook also runs on permanent-delegate
 * transfers. If it does not, the `enforcement_authority` bypass is unreachable
 * code and the field comes out.
 */
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { Keypair } from "@solana/web3.js";
import { assert } from "chai";

import { PermissionedToken } from "../target/types/permissioned_token";
import {
  addToAllowlist,
  balanceOf,
  createHolderAccount,
  expectAnchorError,
  mintTokens,
  revokeFromAllowlist,
  setupEnforcedMint,
  transfer,
} from "./helpers";

describe("seizure via permanent delegate", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .permissionedToken as Program<PermissionedToken>;

  it("probe: the hook fires on delegate transfers, and the bypass stops at the sender", async () => {
    const alice = Keypair.generate();
    const carol = Keypair.generate(); // never allowlisted
    const ctx = await setupEnforcedMint(provider, program, [alice.publicKey]);

    const aliceAta = await createHolderAccount(provider, ctx, alice.publicKey);
    const carolAta = await createHolderAccount(provider, ctx, carol.publicKey);
    await mintTokens(provider, ctx, aliceAta, 100n);

    // ctx.admin is both the mint's permanent delegate and the config's
    // enforcement authority, so this is the most privileged caller that exists
    // — and it is sending to an unverified destination.
    //
    // Rejection here proves two things at once: Token-2022 does invoke the hook
    // on delegate transfers, and the bypass covers the sender only.
    //
    // Success here would mean the hook is skipped entirely for delegate
    // transfers, and the bypass would have to be deleted as dead code.
    await expectAnchorError(
      transfer(provider, ctx, aliceAta, carolAta, ctx.admin, 10n),
      "RecipientNotAllowed"
    );

    assert.equal(await balanceOf(provider, aliceAta), 100n);
    assert.equal(await balanceOf(provider, carolAta), 0n);
  });

  it("the issuer can seize tokens without the holder's signature", async () => {
    const bob = Keypair.generate();
    const treasury = Keypair.generate();
    const ctx = await setupEnforcedMint(provider, program, [
      bob.publicKey,
      treasury.publicKey,
    ]);

    const bobAta = await createHolderAccount(provider, ctx, bob.publicKey);
    const treasuryAta = await createHolderAccount(
      provider,
      ctx,
      treasury.publicKey
    );
    await mintTokens(provider, ctx, bobAta, 40n);

    // Only `ctx.admin` signs. Bob's key is never used, which is the whole
    // point: seizure cannot depend on the cooperation of the party being
    // seized from.
    await transfer(provider, ctx, bobAta, treasuryAta, ctx.admin, 40n);

    assert.equal(await balanceOf(provider, bobAta), 0n);
    assert.equal(await balanceOf(provider, treasuryAta), 40n);
  });

  it("seizure still works against a holder who has been revoked", async () => {
    const bob = Keypair.generate();
    const treasury = Keypair.generate();
    const ctx = await setupEnforcedMint(provider, program, [
      bob.publicKey,
      treasury.publicKey,
    ]);

    const bobAta = await createHolderAccount(provider, ctx, bob.publicKey);
    const treasuryAta = await createHolderAccount(
      provider,
      ctx,
      treasury.publicKey
    );
    await mintTokens(provider, ctx, bobAta, 40n);

    // Sanction Bob first. This is the case the bypass exists for: without it
    // the sender check would reject the issuer, and revoking a holder would
    // make them permanently unseizable — protection for exactly the wallet the
    // issuer just sanctioned.
    await revokeFromAllowlist(provider, program, ctx, bob.publicKey);

    await transfer(provider, ctx, bobAta, treasuryAta, ctx.admin, 40n);

    assert.equal(await balanceOf(provider, bobAta), 0n);
    assert.equal(await balanceOf(provider, treasuryAta), 40n);
  });

  it("the bypass is not available to anyone but the enforcement authority", async () => {
    const alice = Keypair.generate();
    const mallory = Keypair.generate(); // not allowlisted, not the delegate
    const ctx = await setupEnforcedMint(provider, program, [alice.publicKey]);

    const malloryAta = await createHolderAccount(
      provider,
      ctx,
      mallory.publicKey
    );
    const aliceAta = await createHolderAccount(provider, ctx, alice.publicKey);
    await mintTokens(provider, ctx, malloryAta, 50n);

    // Mallory is a legitimate authority over her own account, so Token-2022
    // lets the transfer through to the hook. The hook compares her against
    // `config.enforcement_authority` — which `initialize_config` bound to the
    // mint's real permanent delegate — and she is not it.
    await expectAnchorError(
      transfer(provider, ctx, malloryAta, aliceAta, mallory, 10n),
      "SenderNotAllowed"
    );

    assert.equal(await balanceOf(provider, malloryAta), 50n);
    assert.equal(await balanceOf(provider, aliceAta), 0n);
  });

  it("control: a revoked holder cannot move their own tokens", async () => {
    const bob = Keypair.generate();
    const treasury = Keypair.generate();
    const ctx = await setupEnforcedMint(provider, program, [
      bob.publicKey,
      treasury.publicKey,
    ]);

    const bobAta = await createHolderAccount(provider, ctx, bob.publicKey);
    const treasuryAta = await createHolderAccount(
      provider,
      ctx,
      treasury.publicKey
    );
    await mintTokens(provider, ctx, bobAta, 40n);
    await revokeFromAllowlist(provider, program, ctx, bob.publicKey);

    // Same revoked state as the test above, different signer. Without this, that
    // test passing is also consistent with the hook not running on that mint.
    await expectAnchorError(
      transfer(provider, ctx, bobAta, treasuryAta, bob, 40n),
      "SenderNotAllowed"
    );
    assert.equal(await balanceOf(provider, bobAta), 40n);

    // And re-approving restores the ability, so revocation is the cause.
    await addToAllowlist(provider, program, ctx, bob.publicKey);
    await transfer(provider, ctx, bobAta, treasuryAta, bob, 40n);
    assert.equal(await balanceOf(provider, treasuryAta), 40n);
  });
});
