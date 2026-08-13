/**
 * Shared setup for the test suite.
 *
 * `createPermissionedMint` encodes the mint construction sequence once, because
 * the extension order is load-bearing and easy to get wrong.
 */
import * as anchor from "@anchor-lang/core";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  AccountState,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeDefaultAccountStateInstruction,
  createInitializeMint2Instruction,
  createInitializePermanentDelegateInstruction,
  createInitializeTransferHookInstruction,
  createMintToInstruction,
  createThawAccountInstruction,
  createTransferCheckedWithTransferHookInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMintLen,
} from "@solana/spl-token";
import { assert } from "chai";

import { PermissionedToken } from "../target/types/permissioned_token";

export const CONFIG_SEED = Buffer.from("config");
export const ALLOWLIST_SEED = Buffer.from("allow");
export const EXTRA_ACCOUNT_METAS_SEED = Buffer.from("extra-account-metas");

export function configPda(mint: PublicKey, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [CONFIG_SEED, mint.toBuffer()],
    programId
  )[0];
}

export function allowlistEntryPda(
  mint: PublicKey,
  wallet: PublicKey,
  programId: PublicKey
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [ALLOWLIST_SEED, mint.toBuffer(), wallet.toBuffer()],
    programId
  )[0];
}

export function extraAccountMetaListPda(
  mint: PublicKey,
  programId: PublicKey
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [EXTRA_ACCOUNT_METAS_SEED, mint.toBuffer()],
    programId
  )[0];
}

export async function fund(
  provider: anchor.AnchorProvider,
  who: PublicKey,
  sol = 2
): Promise<void> {
  const sig = await provider.connection.requestAirdrop(
    who,
    sol * anchor.web3.LAMPORTS_PER_SOL
  );
  const bh = await provider.connection.getLatestBlockhash();
  await provider.connection.confirmTransaction(
    { signature: sig, ...bh },
    "confirmed"
  );
}

export interface PermissionedMint {
  mint: PublicKey;
  /** Mint and freeze authority. */
  issuer: Keypair;
  /** Permanent delegate — the enforcement authority. */
  admin: Keypair;
}

/**
 * Creates a Token-2022 mint with TransferHook, DefaultAccountState=Frozen and
 * PermanentDelegate, in one transaction.
 *
 * The account must be sized for the extensions before the mint is initialized,
 * and `initializeMint2` must come last. Initializing the mint first and adding
 * extensions afterwards silently produces a mint without them.
 */
export async function createPermissionedMint(
  provider: anchor.AnchorProvider,
  hookProgramId: PublicKey,
  decimals = 6
): Promise<PermissionedMint> {
  const issuer = Keypair.generate();
  const admin = Keypair.generate();
  const mintKp = Keypair.generate();

  await fund(provider, issuer.publicKey);
  await fund(provider, admin.publicKey);

  const extensions = [
    ExtensionType.TransferHook,
    ExtensionType.DefaultAccountState,
    ExtensionType.PermanentDelegate,
  ];
  const mintLen = getMintLen(extensions);
  const lamports =
    await provider.connection.getMinimumBalanceForRentExemption(mintLen);

  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: provider.wallet.publicKey,
      newAccountPubkey: mintKp.publicKey,
      space: mintLen,
      lamports,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    // Update authority is the all-zero key, which Token-2022 reads as None.
    //
    // Setting it to the issuer would leave a key able to call
    // `updateTransferHook` and repoint the mint at a no-op program, disabling
    // allowlist enforcement entirely with no trace in this program's state.
    // That would make the README's claim — that none of these controls can be
    // bypassed by crafting a transaction — false. The hook program is fixed at
    // creation and cannot be changed.
    createInitializeTransferHookInstruction(
      mintKp.publicKey,
      PublicKey.default,
      hookProgramId,
      TOKEN_2022_PROGRAM_ID
    ),
    createInitializeDefaultAccountStateInstruction(
      mintKp.publicKey,
      AccountState.Frozen,
      TOKEN_2022_PROGRAM_ID
    ),
    createInitializePermanentDelegateInstruction(
      mintKp.publicKey,
      admin.publicKey,
      TOKEN_2022_PROGRAM_ID
    ),
    createInitializeMint2Instruction(
      mintKp.publicKey,
      decimals,
      issuer.publicKey, // mint authority
      issuer.publicKey, // freeze authority — required for DefaultAccountState to be usable
      TOKEN_2022_PROGRAM_ID
    )
  );

  await provider.sendAndConfirm(tx, [mintKp]);

  return { mint: mintKp.publicKey, issuer, admin };
}

/**
 * Mint + config + extra account meta list, with `allowlist` approved.
 *
 * `withConfig: false` skips the config so the hook has nothing to read, which
 * is how checks that a missing config blocks rather than permits.
 */
export async function setupEnforcedMint(
  provider: anchor.AnchorProvider,
  program: anchor.Program<PermissionedToken>,
  allowlist: PublicKey[],
  { withConfig = true }: { withConfig?: boolean } = {}
): Promise<PermissionedMint> {
  const ctx = await createPermissionedMint(provider, program.programId);

  if (withConfig) {
    await program.methods
      .initializeConfig(ctx.issuer.publicKey, ctx.admin.publicKey)
      .accountsPartial({
        mintAuthority: ctx.issuer.publicKey,
        config: configPda(ctx.mint, program.programId),
        mint: ctx.mint,
      })
      .signers([ctx.issuer])
      .rpc();
  }

  // Signed by the issuer: the instruction now requires the mint authority.
  await program.methods
    .initializeExtraAccountMetaList()
    .accountsPartial({
      mintAuthority: ctx.issuer.publicKey,
      extraAccountMetaList: extraAccountMetaListPda(ctx.mint, program.programId),
      mint: ctx.mint,
    })
    .signers([ctx.issuer])
    .rpc();

  for (const wallet of allowlist) {
    await addToAllowlist(provider, program, ctx, wallet);
  }

  return ctx;
}

export async function addToAllowlist(
  _provider: anchor.AnchorProvider,
  program: anchor.Program<PermissionedToken>,
  ctx: PermissionedMint,
  wallet: PublicKey
): Promise<void> {
  await program.methods
    .addToAllowlist(wallet)
    .accountsPartial({
      authority: ctx.issuer.publicKey,
      config: configPda(ctx.mint, program.programId),
      entry: allowlistEntryPda(ctx.mint, wallet, program.programId),
      mint: ctx.mint,
    })
    .signers([ctx.issuer])
    .rpc();
}

export async function revokeFromAllowlist(
  _provider: anchor.AnchorProvider,
  program: anchor.Program<PermissionedToken>,
  ctx: PermissionedMint,
  wallet: PublicKey
): Promise<void> {
  await program.methods
    .revokeFromAllowlist(wallet)
    .accountsPartial({
      authority: ctx.issuer.publicKey,
      config: configPda(ctx.mint, program.programId),
      entry: allowlistEntryPda(ctx.mint, wallet, program.programId),
      mint: ctx.mint,
    })
    .signers([ctx.issuer])
    .rpc();
}

/**
 * Creates a token account for `owner` and thaws it.
 *
 * The mint carries `DefaultAccountState = Frozen`, so a freshly created account
 * cannot receive anything until the freeze authority thaws it. That is a
 * separate gate from the allowlist and is deliberately kept separate: a wallet
 * can be allowlisted but still frozen, or thawed but not allowlisted.
 */
export async function createHolderAccount(
  provider: anchor.AnchorProvider,
  ctx: PermissionedMint,
  owner: PublicKey,
  { thaw = true }: { thaw?: boolean } = {}
): Promise<PublicKey> {
  const ata = getAssociatedTokenAddressSync(
    ctx.mint,
    owner,
    false,
    TOKEN_2022_PROGRAM_ID
  );

  const tx = new Transaction().add(
    createAssociatedTokenAccountInstruction(
      provider.wallet.publicKey,
      ata,
      owner,
      ctx.mint,
      TOKEN_2022_PROGRAM_ID
    )
  );

  if (thaw) {
    tx.add(
      createThawAccountInstruction(
        ata,
        ctx.mint,
        ctx.issuer.publicKey,
        [],
        TOKEN_2022_PROGRAM_ID
      )
    );
  }

  await provider.sendAndConfirm(tx, thaw ? [ctx.issuer] : []);
  return ata;
}

export async function thawHolderAccount(
  provider: anchor.AnchorProvider,
  ctx: PermissionedMint,
  account: PublicKey
): Promise<void> {
  await provider.sendAndConfirm(
    new Transaction().add(
      createThawAccountInstruction(
        account,
        ctx.mint,
        ctx.issuer.publicKey,
        [],
        TOKEN_2022_PROGRAM_ID
      )
    ),
    [ctx.issuer]
  );
}

export async function isFrozen(
  provider: anchor.AnchorProvider,
  account: PublicKey
): Promise<boolean> {
  const info = await getAccount(
    provider.connection,
    account,
    undefined,
    TOKEN_2022_PROGRAM_ID
  );
  return info.isFrozen;
}

/** Asserts a call fails, without pinning the error to a specific variant. */
export async function expectFailure(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch {
    return;
  }
  assert.fail("expected the call to fail, but it succeeded");
}

export async function mintTokens(
  provider: anchor.AnchorProvider,
  ctx: PermissionedMint,
  destination: PublicKey,
  amount: bigint
): Promise<void> {
  await provider.sendAndConfirm(
    new Transaction().add(
      createMintToInstruction(
        ctx.mint,
        destination,
        ctx.issuer.publicKey,
        amount,
        [],
        TOKEN_2022_PROGRAM_ID
      )
    ),
    [ctx.issuer]
  );
}

export async function balanceOf(
  provider: anchor.AnchorProvider,
  account: PublicKey
): Promise<bigint> {
  const info = await getAccount(
    provider.connection,
    account,
    undefined,
    TOKEN_2022_PROGRAM_ID
  );
  return info.amount;
}

/**
 * Builds a transfer using the standard SPL helper, which reads
 * `ExtraAccountMetaList` from chain and appends the resolved accounts itself.
 *
 * Assembling the account list by hand here would defeat , whose point is
 * that an unmodified client works against this mint.
 */
export async function transfer(
  provider: anchor.AnchorProvider,
  ctx: PermissionedMint,
  source: PublicKey,
  destination: PublicKey,
  owner: Keypair,
  amount: bigint,
  decimals = 6
): Promise<string> {
  const ix = await createTransferCheckedWithTransferHookInstruction(
    provider.connection,
    source,
    ctx.mint,
    destination,
    owner.publicKey,
    amount,
    decimals,
    [],
    "confirmed",
    TOKEN_2022_PROGRAM_ID
  );
  return provider.sendAndConfirm(new Transaction().add(ix), [owner]);
}

/**
 * Asserts a transaction fails with a specific Anchor error variant.
 *
 * Deliberately strict about *which* error. A test that only asserts "it threw"
 * passes when the call fails for an unrelated reason — a wrong PDA, an
 * unfunded payer — and would go green against a program with no checks at all.
 */
export async function expectAnchorError(
  promise: Promise<unknown>,
  expectedCode: string
): Promise<void> {
  try {
    await promise;
  } catch (err) {
    const text = JSON.stringify(
      err,
      Object.getOwnPropertyNames(err as object)
    );
    assert.include(
      text,
      expectedCode,
      `expected error ${expectedCode}, got: ${text.slice(0, 600)}`
    );
    return;
  }
  assert.fail(`expected the call to fail with ${expectedCode}, but it succeeded`);
}
