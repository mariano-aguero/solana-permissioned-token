# Permissioned Token (Solana, Token-2022)

A permissioned SPL Token-2022 mint for a regulated asset. Transfers are rejected
unless both parties are on an on-chain allowlist, token accounts are frozen when
created, and the issuer can recover tokens from any holder without their
signature — including from a holder it has just sanctioned.

> **Unaudited. Not deployed to any public cluster, by design.** This is a
> reference implementation written to be read, not production software.

**29 integration tests passing**, plus one Rust unit test pinning the hook's PDA
seed to the interface's own address helper.

## What is enforced on-chain

| Control | Mechanism |
|---------|-----------|
| Only approved wallets may send or receive | Transfer Hook checking one allowlist PDA per wallet |
| Holding requires explicit approval | `DefaultAccountState = Frozen` — new accounts land frozen |
| The issuer can seize tokens | `PermanentDelegate` — moves tokens with no holder signature |
| Seizure still works after sanctioning | The hook recognises an enforcement authority and skips the *sender* check |
| The seizure path is not a backdoor | That authority is bound to the mint's real `PermanentDelegate`, and the recipient check still applies |

None of these can be bypassed by hand-crafting a transaction. A rule that could
only be enforced by the client is not treated as a rule here.

The mint is created with the transfer hook's **update authority set to `None`**,
so the hook program cannot be swapped for a permissive one later. Without that,
every guarantee above would be conditional on a single live key.

## Known limitations

Stated rather than hidden, because they bound what the guarantees above mean.

- **The allowlist authority cannot be rotated.** There is no update instruction,
  so a lost or compromised allowlist key cannot be replaced; an attacker holding
  it could approve wallets indefinitely, and the issuer's only remaining lever
  would be freezing accounts individually.
- **The config requires a live mint authority to create.** An issuer who follows
  the common fixed-supply practice of setting `mint_authority` to `None` before
  creating the config can never create it — and since `execute` requires the
  config, the mint would be permanently untransferable. Create the config before
  relinquishing the mint authority.
- **Freezing is all-or-nothing.** Token-2022 freezes whole accounts; ERC-3643's
  partial balance freeze has no equivalent and is not emulated.

## Four things that are easy to get wrong

**The transfer authority is not the token owner.** `Execute` receives the signer
at account index 3. Under a permanent-delegate transfer that signer is the
delegate, not the holder, so deriving the sender's allowlist entry from it checks
the wrong subject during exactly the operation that most needs to be right. The
sender is read from the source token account's owner field instead, at offset 32.

**The hook runs on delegate transfers too.** So a naive sender check blocks the
issuer from seizing assets from a holder it has just revoked — sanctioning a
wallet would make it unseizable. The hook recognises an enforcement authority and
returns early. That assumption was measured, not assumed: a test has the most
privileged caller in the system attempt a transfer to an unapproved recipient,
and requires it to be rejected.

**Config creation was permissionless.** The config PDA is derived from the mint
alone and created with `init`, so exactly one caller can ever succeed — the
first. Mint creation and config creation are separate transactions, and an
attacker landing in that window would have owned the allowlist and the seizure
bypass permanently. The mint authority now signs, and the enforcement authority
is read from mint state rather than taken as an argument.

**`create_account` refuses a pre-funded destination.** The extra-account-meta
PDA is derivable from the mint the moment it exists, and setup creates it in a
later transaction. A deposit into that window made allocation fail forever — and
with no meta list, Token-2022 calls the hook with four accounts instead of
eight, killing every transfer of that mint permanently. Allocation now uses
`transfer` + `allocate` + `assign`, which tops the account up instead. This is
the same race as the config one above; it was analysed there, fixed there, and
missed here until the final review.

## Deliberately not included

`ConfidentialTransfer` and `TransferFee` are documented as considered and
rejected, with reasons, in the spec. Partial balance freezing has no Token-2022
equivalent and is not faked. No public deployment: unaudited code implementing a
regulated-asset pattern should not exist at a public address.

## EVM background

[`docs/evm-mapping.md`](docs/evm-mapping.md) maps ERC-3643 and ERC-1404 onto
Token-2022 — the direct equivalences first, then the seven places the models
genuinely diverge. The short version: on EVM, compliance is *inheritance*; on
Solana it is *interposition*, and the hook gets a veto and nothing else.

## Running it

```bash
pnpm install
anchor keys sync              # each clone generates its own program keypair
anchor test --validator legacy
```

Anchor 1.x defaults to [Surfpool](https://github.com/txtx/surfpool);
`--validator legacy` uses `solana-test-validator`, which ships with the Solana
CLI, so no extra tooling is needed.

The program keypair lives under `target/` and is not committed — a private key
does not belong in a public repository, even a throwaway one.

**If port 8899 is busy**, the validator silently fails to start and
`.anchor/test-ledger/test-ledger-log.txt` shows an HTTP error from whatever else
owns it. Run your own validator elsewhere and point Anchor at it:

```bash
solana-test-validator --rpc-port 8999 --reset
anchor test --skip-local-validator --provider.cluster http://127.0.0.1:8999
```

## Stack

Rust 1.89 · Anchor 1.1.2 · SPL Token-2022 · `spl-transfer-hook-interface` 2.1.0 ·
`spl-tlv-account-resolution` 0.11.1 · `spl-discriminator` 0.5.2 · TypeScript 5.9
with `@solana/spl-token` 0.4.15

All five Rust versions are pinned by the committed `Cargo.lock`. The Solana CLI
is whatever Anchor 1.1.2 installs (3.1.10) — installing Anchor replaces it, and
upgrading it independently reintroduces exactly the version-mismatch class of
failure this project spent its first day retiring.

## License

MIT
