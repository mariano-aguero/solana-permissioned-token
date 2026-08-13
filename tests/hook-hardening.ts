/**
 * Guards that are cheap to delete by accident: the griefing-resistant
 * allocation, the mint-authority requirement, the direct-call rejection, and
 * the fixed transfer-hook program.
 */
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { assert } from "chai";

import { PermissionedToken } from "../target/types/permissioned_token";
import {
  balanceOf,
  configPda,
  createHolderAccount,
  createPermissionedMint,
  expectAnchorError,
  extraAccountMetaListPda,
  fund,
  mintTokens,
  setupEnforcedMint,
  transfer,
} from "./helpers";

describe("hook hardening", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .permissionedToken as Program<PermissionedToken>;

  it("a pre-funded meta list PDA cannot brick the mint", async () => {
    const alice = Keypair.generate();
    const bob = Keypair.generate();
    const ctx = await createPermissionedMint(provider, program.programId);

    const metaListPda = extraAccountMetaListPda(ctx.mint, program.programId);

    // The griefing attack. The address is derived from the mint and the program
    // id, so anyone can compute it the moment the mint exists, and setup
    // creates it in a later transaction. `create_account` refuses any
    // destination that already holds lamports, so a stray deposit into that
    // window used to make this instruction fail permanently — and with no meta
    // list, Token-2022 CPIs `execute` with four accounts instead of eight, so
    // every transfer of the mint dies. Unrecoverable without redeploying the
    // program at a new id.
    //
    // The floor is not one lamport: Solana rejects any transaction that leaves
    // an account below rent exemption, so the cheapest possible deposit is the
    // rent-exempt minimum for a zero-length account. That is still under a
    // thousandth of a SOL, so the economics of the attack are unchanged.
    const dust =
      await provider.connection.getMinimumBalanceForRentExemption(0);
    await provider.sendAndConfirm(
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: provider.wallet.publicKey,
          toPubkey: metaListPda,
          lamports: dust,
        })
      )
    );

    await program.methods
      .initializeConfig(ctx.issuer.publicKey, ctx.admin.publicKey)
      .accountsPartial({
        mintAuthority: ctx.issuer.publicKey,
        config: configPda(ctx.mint, program.programId),
        mint: ctx.mint,
      })
      .signers([ctx.issuer])
      .rpc();

    // transfer + allocate + assign tops the account up instead of refusing it.
    await program.methods
      .initializeExtraAccountMetaList()
      .accountsPartial({
        mintAuthority: ctx.issuer.publicKey,
        extraAccountMetaList: metaListPda,
        mint: ctx.mint,
      })
      .signers([ctx.issuer])
      .rpc();

    // And the mint is fully functional afterwards.
    for (const wallet of [alice.publicKey, bob.publicKey]) {
      await program.methods
        .addToAllowlist(wallet)
        .accountsPartial({
          authority: ctx.issuer.publicKey,
          config: configPda(ctx.mint, program.programId),
          entry: anchor.web3.PublicKey.findProgramAddressSync(
            [Buffer.from("allow"), ctx.mint.toBuffer(), wallet.toBuffer()],
            program.programId
          )[0],
          mint: ctx.mint,
        })
        .signers([ctx.issuer])
        .rpc();
    }

    const aliceAta = await createHolderAccount(provider, ctx, alice.publicKey);
    const bobAta = await createHolderAccount(provider, ctx, bob.publicKey);
    await mintTokens(provider, ctx, aliceAta, 100n);
    await transfer(provider, ctx, aliceAta, bobAta, alice, 40n);

    assert.equal(await balanceOf(provider, bobAta), 40n);
  });

  it("only the mint authority can initialize the meta list", async () => {
    const mallory = Keypair.generate();
    await fund(provider, mallory.publicKey);
    const ctx = await createPermissionedMint(provider, program.programId);

    await expectAnchorError(
      program.methods
        .initializeExtraAccountMetaList()
        .accountsPartial({
          mintAuthority: mallory.publicKey,
          extraAccountMetaList: extraAccountMetaListPda(
            ctx.mint,
            program.programId
          ),
          mint: ctx.mint,
        })
        .signers([mallory])
        .rpc(),
      "UnauthorizedMetaListInitializer"
    );
  });

  it("execute rejects a direct call outside a transfer", async () => {
    const alice = Keypair.generate();
    const bob = Keypair.generate();
    const ctx = await setupEnforcedMint(provider, program, [
      alice.publicKey,
      bob.publicKey,
    ]);

    const aliceAta = await createHolderAccount(provider, ctx, alice.publicKey);
    const bobAta = await createHolderAccount(provider, ctx, bob.publicKey);
    await mintTokens(provider, ctx, aliceAta, 100n);

    const entry = (wallet: PublicKey) =>
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("allow"), ctx.mint.toBuffer(), wallet.toBuffer()],
        program.programId
      )[0];

    // Everything the hook needs, assembled by hand, with both parties
    // allowlisted — so the only thing that can reject this is the transferring
    // check. Token-2022 sets that flag only for the duration of a real
    // transfer.
    //
    // `execute` mutates nothing, so a direct call is inert either way. The
    // check makes it detectable rather than merely harmless — and until this
    // test existed, deleting it changed no result anywhere in the suite.
    await expectAnchorError(
      program.methods
        .execute(new anchor.BN(1))
        .accountsPartial({
          sourceToken: aliceAta,
          mint: ctx.mint,
          destinationToken: bobAta,
          authority: alice.publicKey,
          extraAccountMetaList: extraAccountMetaListPda(
            ctx.mint,
            program.programId
          ),
          config: configPda(ctx.mint, program.programId),
          senderEntry: entry(alice.publicKey),
          recipientEntry: entry(bob.publicKey),
        })
        .rpc(),
      "InvalidHookInvocation"
    );

    assert.equal(await balanceOf(provider, aliceAta), 100n);
  });

  it("the transfer hook program cannot be repointed", async () => {
    const ctx = await createPermissionedMint(provider, program.programId);

    const mintInfo = await provider.connection.getAccountInfo(ctx.mint);
    assert.isNotNull(mintInfo);

    // The mint was created with the hook's update authority set to the all-zero
    // key, which Token-2022 reads as None. A live update authority could
    // repoint the mint at a no-op program and disable enforcement entirely
    // with no trace in this program's state.
    const { getTransferHook, getMint } = await import("@solana/spl-token");
    const mint = await getMint(
      provider.connection,
      ctx.mint,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    const hook = getTransferHook(mint);

    assert.isNotNull(hook);
    assert.equal(
      hook!.programId.toBase58(),
      program.programId.toBase58(),
      "hook should point at this program"
    );
    assert.equal(
      hook!.authority.toBase58(),
      PublicKey.default.toBase58(),
      "hook update authority must be None, or enforcement can be switched off"
    );
  });
});
