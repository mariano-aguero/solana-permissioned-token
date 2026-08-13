/**
 * — allowlist administration.
 *
 * These tests assert the behaviour the contracts specify, not the behaviour the
 * program currently has. Every one of them is expected to FAIL until * implements the handlers. That is the point: if any test here passes right
 * now, it is not testing what it claims to.
 *
 * is done when all six are green — no earlier.
 */
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { Keypair } from "@solana/web3.js";
import { assert } from "chai";

import { PermissionedToken } from "../target/types/permissioned_token";
import {
  allowlistEntryPda,
  configPda,
  createPermissionedMint,
  expectAnchorError,
  fund,
  PermissionedMint,
} from "./helpers";

describe("allowlist administration", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .permissionedToken as Program<PermissionedToken>;

  let ctx: PermissionedMint;
  let mallory: Keypair;

  beforeEach(async () => {
    ctx = await createPermissionedMint(provider, program.programId);
    mallory = Keypair.generate();
    await fund(provider, mallory.publicKey);
  });

  /** Creates the config the way the issuer legitimately would. */
  async function initConfigAsIssuer() {
    return program.methods
      .initializeConfig(ctx.issuer.publicKey, ctx.admin.publicKey)
      .accountsPartial({
        mintAuthority: ctx.issuer.publicKey,
        config: configPda(ctx.mint, program.programId),
        mint: ctx.mint,
      })
      .signers([ctx.issuer])
      .rpc();
  }

  // ---------------------------------------------------------------- config

  it("populates the config on initialization", async () => {
    await initConfigAsIssuer();

    const config = await program.account.allowlistConfig.fetch(
      configPda(ctx.mint, program.programId)
    );

    assert.equal(config.mint.toBase58(), ctx.mint.toBase58());
    assert.equal(
      config.allowlistAuthority.toBase58(),
      ctx.issuer.publicKey.toBase58()
    );
    assert.equal(
      config.enforcementAuthority.toBase58(),
      ctx.admin.publicKey.toBase58()
    );
    assert.notEqual(config.bump, 0, "canonical bump was never stored");
  });

  it("rejects a config created by anyone but the mint authority", async () => {
    // The attack this closes: mint creation and config creation are separate
    // transactions. Landing in that window with both authorities set to
    // yourself wins the allowlist and the enforcement bypass permanently,
    // because the config PDA is created with `init` and the issuer's own call
    // then fails.
    await expectAnchorError(
      program.methods
        .initializeConfig(mallory.publicKey, mallory.publicKey)
        .accountsPartial({
          mintAuthority: mallory.publicKey,
          config: configPda(ctx.mint, program.programId),
          mint: ctx.mint,
        })
        .signers([mallory])
        .rpc(),
      "UnauthorizedConfigInitializer"
    );

    const account = await provider.connection.getAccountInfo(
      configPda(ctx.mint, program.programId)
    );
    assert.isNull(account, "no config should exist after a rejected call");
  });

  it("rejects an enforcement authority that is not the permanent delegate", async () => {
    await expectAnchorError(
      program.methods
        .initializeConfig(ctx.issuer.publicKey, mallory.publicKey)
        .accountsPartial({
          mintAuthority: ctx.issuer.publicKey,
          config: configPda(ctx.mint, program.programId),
          mint: ctx.mint,
        })
        .signers([ctx.issuer])
        .rpc(),
      "EnforcementAuthorityMismatch"
    );
  });

  // ------------------------------------------------------------- allowlist

  it("rejects an allowlist addition signed by anyone but the authority", async () => {
    await initConfigAsIssuer();

    const target = Keypair.generate().publicKey;

    await expectAnchorError(
      program.methods
        .addToAllowlist(target)
        .accountsPartial({
          authority: mallory.publicKey,
          config: configPda(ctx.mint, program.programId),
          entry: allowlistEntryPda(ctx.mint, target, program.programId),
          mint: ctx.mint,
        })
        .signers([mallory])
        .rpc(),
      "UnauthorizedAllowlistAuthority"
    );

    const entry = await provider.connection.getAccountInfo(
      allowlistEntryPda(ctx.mint, target, program.programId)
    );
    assert.isNull(entry, "no entry should exist after a rejected addition");
  });

  it("rejects adding a wallet that is already allowlisted", async () => {
    await initConfigAsIssuer();

    const holder = Keypair.generate().publicKey;
    const add = () =>
      program.methods
        .addToAllowlist(holder)
        .accountsPartial({
          authority: ctx.issuer.publicKey,
          config: configPda(ctx.mint, program.programId),
          entry: allowlistEntryPda(ctx.mint, holder, program.programId),
          mint: ctx.mint,
        })
        .signers([ctx.issuer])
        .rpc();

    await add();

    // `init`, not `init_if_needed` — a silent no-op would hide a caller bug.
    let failed = false;
    try {
      await add();
    } catch {
      failed = true;
    }
    assert.isTrue(failed, "adding an existing member must fail, not no-op");

    const entry = await program.account.allowlistEntry.fetch(
      allowlistEntryPda(ctx.mint, holder, program.programId)
    );
    assert.equal(
      entry.wallet.toBase58(),
      holder.toBase58(),
      "the original entry must survive the rejected second add"
    );
    // `entry.mint` exists for off-chain indexing and is written by the handler.
    // Until this assertion, deleting that write turned no test red.
    assert.equal(entry.mint.toBase58(), ctx.mint.toBase58());
    assert.notEqual(entry.bump, 0, "canonical bump was never stored");
  });

  it("rejects a revocation signed by anyone but the authority", async () => {
    await initConfigAsIssuer();

    const holder = Keypair.generate().publicKey;
    const entryPda = allowlistEntryPda(ctx.mint, holder, program.programId);

    await program.methods
      .addToAllowlist(holder)
      .accountsPartial({
        authority: ctx.issuer.publicKey,
        config: configPda(ctx.mint, program.programId),
        entry: entryPda,
        mint: ctx.mint,
      })
      .signers([ctx.issuer])
      .rpc();

    // The mirror of the addition test above. Without it, deleting the authority
    // check from `revoke_from_allowlist` leaves the whole suite green — while
    // any signer could close every entry on a mint, de-allowlisting all holders
    // and collecting the rent.
    await expectAnchorError(
      program.methods
        .revokeFromAllowlist(holder)
        .accountsPartial({
          authority: mallory.publicKey,
          config: configPda(ctx.mint, program.programId),
          entry: entryPda,
          mint: ctx.mint,
        })
        .signers([mallory])
        .rpc(),
      "UnauthorizedAllowlistAuthority"
    );

    assert.isNotNull(
      await provider.connection.getAccountInfo(entryPda),
      "the entry must survive a rejected revocation"
    );
  });

  it("revocation closes the entry", async () => {
    await initConfigAsIssuer();

    const holder = Keypair.generate().publicKey;
    const entryPda = allowlistEntryPda(ctx.mint, holder, program.programId);

    await program.methods
      .addToAllowlist(holder)
      .accountsPartial({
        authority: ctx.issuer.publicKey,
        config: configPda(ctx.mint, program.programId),
        entry: entryPda,
        mint: ctx.mint,
      })
      .signers([ctx.issuer])
      .rpc();

    assert.isNotNull(
      await provider.connection.getAccountInfo(entryPda),
      "entry should exist before revocation"
    );

    await program.methods
      .revokeFromAllowlist(holder)
      .accountsPartial({
        authority: ctx.issuer.publicKey,
        config: configPda(ctx.mint, program.programId),
        entry: entryPda,
        mint: ctx.mint,
      })
      .signers([ctx.issuer])
      .rpc();

    // Closed, not flagged — absence is the single representation of
    // "not allowed", so the hook only has to check existence.
    assert.isNull(
      await provider.connection.getAccountInfo(entryPda),
      "entry should be closed after revocation"
    );
  });
});
