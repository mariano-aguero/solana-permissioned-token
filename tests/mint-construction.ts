/**
 * Mint construction: all three extensions are written and read back, and a
 * freshly created token account lands Frozen.
 */
import * as anchor from "@anchor-lang/core";
import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import {
  AccountState,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeDefaultAccountStateInstruction,
  createInitializeMint2Instruction,
  createInitializePermanentDelegateInstruction,
  createInitializeTransferHookInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getDefaultAccountState,
  getMint,
  getMintLen,
  getPermanentDelegate,
  getTransferHook,
} from "@solana/spl-token";
import { assert } from "chai";

describe("mint construction", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const connection = provider.connection;
  const payer = provider.wallet.publicKey;
  const mintKp = Keypair.generate();
  const mint = mintKp.publicKey;
  const decimals = 6;

  // Only the round-trip matters here: the mint stores the id and returns it.
  const hookProgramId = anchor.workspace.permissionedToken.programId;

  it("creates a mint with TransferHook, DefaultAccountState and PermanentDelegate", async () => {
    const extensions = [
      ExtensionType.TransferHook,
      ExtensionType.DefaultAccountState,
      ExtensionType.PermanentDelegate,
    ];
    const mintLen = getMintLen(extensions);
    const lamports = await connection.getMinimumBalanceForRentExemption(mintLen);

    // Extension order is load-bearing: the account must be sized for the
    // extensions, every extension initialized, and initializeMint2 called LAST.
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer,
        newAccountPubkey: mint,
        space: mintLen,
        lamports,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeTransferHookInstruction(
        mint,
        payer,
        hookProgramId,
        TOKEN_2022_PROGRAM_ID
      ),
      createInitializeDefaultAccountStateInstruction(
        mint,
        AccountState.Frozen,
        TOKEN_2022_PROGRAM_ID
      ),
      createInitializePermanentDelegateInstruction(
        mint,
        payer,
        TOKEN_2022_PROGRAM_ID
      ),
      createInitializeMint2Instruction(
        mint,
        decimals,
        payer,
        payer, // freeze authority — without it nothing could ever be thawed
        TOKEN_2022_PROGRAM_ID
      )
    );

    await provider.sendAndConfirm(tx, [mintKp]);

    const mintInfo = await getMint(
      connection,
      mint,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    const transferHook = getTransferHook(mintInfo);
    const defaultState = getDefaultAccountState(mintInfo);
    const permanentDelegate = getPermanentDelegate(mintInfo);

    assert.isNotNull(transferHook, "TransferHook extension missing");
    assert.equal(
      transferHook!.programId.toBase58(),
      hookProgramId.toBase58(),
      "hook program id did not round-trip"
    );

    assert.isNotNull(defaultState, "DefaultAccountState extension missing");
    assert.equal(
      defaultState!.state,
      AccountState.Frozen,
      "default account state is not Frozen"
    );

    assert.isNotNull(permanentDelegate, "PermanentDelegate extension missing");
    assert.equal(
      permanentDelegate!.delegate.toBase58(),
      payer.toBase58(),
      "permanent delegate did not round-trip"
    );

    assert.isNotNull(mintInfo.freezeAuthority, "freeze authority not set");
  });

  it("creates token accounts in the Frozen state", async () => {
    const holder = Keypair.generate().publicKey;
    const ata = getAssociatedTokenAddressSync(
      mint,
      holder,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    await provider.sendAndConfirm(
      new Transaction().add(
        createAssociatedTokenAccountInstruction(
          payer,
          ata,
          holder,
          mint,
          TOKEN_2022_PROGRAM_ID
        )
      )
    );

    const account = await getAccount(
      connection,
      ata,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    assert.isTrue(
      account.isFrozen,
      "a new token account should land Frozen — DefaultAccountState is not taking effect"
    );
  });
});
