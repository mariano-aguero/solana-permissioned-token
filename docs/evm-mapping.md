# Permissioned Tokens: EVM → Solana

Regulated-asset tokens are a solved problem on Ethereum. ERC-3643 (T-REX) and
ERC-1404 encode roughly the same requirements this project implements: only
verified holders, an issuer who can seize, an issuer who can freeze.

This document maps those standards onto Token-2022, and then — the part that
matters — describes where the mapping breaks down, because that is where the
design decisions actually live.

## Direct mapping

| ERC-3643 / ERC-1404 | This implementation |
|---|---|
| `IdentityRegistry.isVerified(address)` | `AllowlistEntry` PDA exists at `[b"allow", mint, wallet]` |
| `Compliance.canTransfer(from, to, amount)` | The `execute` transfer hook |
| ERC-1404 `detectTransferRestriction` return code | Typed program error (`SenderNotAllowed`, `RecipientNotAllowed`) |
| `AgentRole` / `onlyAgent` modifier | `config.allowlist_authority` |
| `forcedTransfer(from, to, amount)` | `PermanentDelegate` extension |
| Wallet recovery for a lost key | `PermanentDelegate` (same mechanism) |
| `setAddressFrozen(address, bool)` | Freeze authority + `DefaultAccountState = Frozen` |
| Deploy-time holder gating | `DefaultAccountState = Frozen` — no EVM equivalent |

## Where the models genuinely diverge

### 1. You cannot override `transfer`

ERC-3643 works by inheriting ERC-20 and overriding `transfer` to consult the
compliance module first. The rules live *inside* the token.

On Solana the token program is a single shared program that every mint uses. It
is immutable, audited, and not yours to subclass. Token-2022 instead offers a
designated extension point: the mint stores a hook program id, and the token
program CPIs into it on every transfer.

The consequence is a real constraint, not a detail. Your compliance logic is a
**separate program that can only observe and reject**. It cannot rewrite the
amount, redirect the recipient, or mutate balances — during the hook, the token
accounts are in a transferring state and cannot be touched at all. Anything that
ERC-3643 accomplishes by modifying state inside `transfer` has to be redesigned
as a precondition or a separate instruction.

### 2. Every account must be declared before the transaction runs

In Solidity, `transfer` reads whatever storage it likes. Solana requires a
transaction to declare every account it will touch, in advance, so the runtime
can schedule non-overlapping transactions in parallel.

That is the entire reason `ExtraAccountMetaList` exists: an on-chain TLV record
telling callers which additional accounts to attach, and how to derive them from
the accounts already in the transfer.

The practical consequence: **adding a compliance check that reads a new account
is a client-visible change.** In ERC-3643 you upgrade the compliance module and
every caller keeps working. Here, the meta list must be updated, and any client
holding a cached account list breaks. Compliance rules become part of the
interface, not an implementation detail behind it.

### 3. There is no `msg.sender`

In Solidity, `msg.sender` inside `transfer` is the holder, and inside
`transferFrom` it is the spender. The distinction is carried by which function
was called.

Solana passes an explicit authority account, and it is not necessarily the
owner of the source account. Under a `PermanentDelegate` transfer the authority
is the issuer while the owner is the holder being seized from.

A permissioned token that derives "who is sending" from the authority therefore
checks the wrong subject during exactly the operation it most needs to get right.
The sender's identity must be read from the source token account's owner field.

### 4. Enforcement and seizure conflict

This one has no ERC-3643 analogue, because ERC-3643 implements `forcedTransfer`
as a separate function that skips the compliance check by construction.

On Solana there is only one transfer path, and the hook runs on all of it —
including permanent-delegate transfers. So a sender allowlist check will block
the issuer from seizing assets from a holder whose allowlist entry was just
revoked. Sanctioning a holder makes them unseizable.

The fix is to recognise an enforcement authority inside the hook and return early
before the allowlist checks. That is a deliberate privilege path and it deserves
a negative test proving it is not available to anyone else.

### 5. Restriction checks are not callable off-chain

ERC-1404's whole contribution is `detectTransferRestriction` — a `view` function
a UI calls to explain *why* a transfer would fail before submitting it.

Solana programs have no view functions. The idiomatic equivalent is to simulate
the transaction and read the returned program error. This works, but it is a
different affordance: it requires a fully-formed transaction, an RPC round trip,
and error decoding on the client, rather than a cheap read.

### 6. Freezing is all-or-nothing

ERC-3643 can freeze a *portion* of a holder's balance with
`freezePartialTokens`, leaving the rest liquid.

Token-2022 freezes an entire token account. Expressing a partial freeze means
splitting the holder's position across two accounts and freezing one, which
changes what "a holder's balance" means for every other part of the system.
Not implemented here, and not a small addition.

### 7. Onboarding costs the issuer rent

An EVM allowlist is a `mapping(address => bool)` — one storage slot, written
once, paid by whoever sends the transaction.

Solana accounts must be rent-exempt, so every allowlist entry is a funded
account (~73 bytes here). The issuer typically pays. This is what makes
revocation via `close` attractive: it returns the rent, so the cost of an
approved holder is refundable rather than sunk.

## What the comparison is worth

The mechanisms translate almost one-to-one. The architecture does not.

On EVM, compliance is *inheritance* — you extend the token and its rules become
part of it. On Solana, compliance is *interposition* — you register a program at
a fixed extension point, and it gets a veto and nothing else.

Most of the design work in this project came from that difference, not from
learning Rust.
