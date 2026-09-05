# Personhood Explorer

Reads proof-of-personhood state from the Polkadot Products Devnet and explains
what it means.

**Live on the devnet → https://whoisaperson.dev-dot.li** (published as
`whoisaperson.dot`)

```bash
npm install
npm run build && npm run preview      # http://localhost:4174
```

## Why

Personhood on the devnet is real, on-chain, and almost entirely undocumented.
Two people independently lost hours to the same confusion — a `NoPersonhood`
revert with nothing to tell you *why*. The cause is usually that personhood is
bound to a different account than the one being checked, or that no contextual
alias has been issued yet.

This shows you which, in plain English.

## The thing it found

While building this, one query answered the whole question:

```
AliasAccounts.AliasFee  on the devnet Asset Hub  →  unset
```

`set_alias_account` reads that on its second line and aborts with
`AliasFeeUnset` before doing anything else. There is no unpaid path — no
`call_index(0)`, no alternative extrinsic.

**So no account on the devnet can bind a contextual alias at all.** Every
personhood check on Asset Hub therefore returns `status 0`, and
`Publisher.publish` always reverts `NoPersonhood` — for everyone, regardless of
what they do in the app. It needs one governance call to `set_alias_fee`.

The explorer says so when it applies, because the symptom otherwise looks exactly
like the user's own mistake.

## What it does

Give it **any one of a person's four identifiers** — an SS58 address, an EVM
address, a `.01` username, or a `.dot` name — and it shows all of them together,
anchored on the identity account: the one that owns the username and carries the
personhood record, never a per-app product account.

It then reports the personhood tier (None / Lite / Full), the contextual alias,
and a diagnosis:

- **No record** — and where personhood actually binds (the account that owns the
  username, resolved via `Resources.UsernameOwnerOf`, not the product or session
  account)
- **Personhood but no alias** — the exact state behind
  [`NoPersonhood`](https://github.com/Polkadot-Community-Foundation/polkadot-app-docs/issues/3)
- **Verified with an alias** — what that permits in this context

Plus a name checker: which personhood tier a label requires, and whether its base
name is reserved.

## How it works

Everything is a read-only `eth_call` over public HTTPS. No wallet, no signing, no
host container.

| | |
|---|---|
| `IPersonhood` precompile | `0x000000000000000000000000000000000a010000` |
| `PopRules` | `0x2181a14081fF2D4477BAA8FB1aEB4C9c44F5F2b0` |
| RPC | `https://eth-rpc-testnet.polkadot.io`, with failover |

Personhood is proved by **ring-VRF membership**. The alias is *unique per person
per context*, so activity in one app cannot be linked to another. Ring roots
reach Asset Hub from the People chain over **XCM pub/sub**, which is why
verification works here without touching the People chain.

`keccak256(publicKey)[12:]` maps SS58 → EVM — verified against `dotns pop info`.
That does not invert, so the other direction uses the `ReviveApi_account_id`
runtime API over plain `state_call`.

**One trap there, worth knowing if you build on it.** `account_id` does not fail
for an address that was never mapped — it *fabricates* an account, returning
`<the 20 address bytes> ‖ 0xEE × 12` as a public key. Rendering that would invent
a person who does not exist, so every result is checked for that shape and shown
as "not mapped" instead.

Listing the `.dot` names an account owns is not possible: the registrar answers
`supportsInterface(0x80ac58cd)` — it is ERC-721 — but returns 0 for
`0x780e9d63` and reverts on `tokenOfOwnerByIndex`. So `balanceOf` gives a count,
individual names can be confirmed one at a time, and the app says plainly that
the rest cannot be listed rather than implying the list is complete.

## What a result establishes

A personhood result is routinely read as stronger than it is. This is what each
state actually proves, read off the pallet source rather than the tier name.

Evidence tags: **[T]** tested against the live chain · **[S]** read from source ·
**[?]** unverified.

### "Registered" on the People chain

`PeopleLite.LitePeople` has two entry paths, and they are not equivalent **[S]**:

| Method | What the chain checked |
|---|---|
| `UniqueDevice(attester)` | An attester holding an allowance granted by `AttestationAllowanceManager` vouched for the candidate. The chain verified two signatures — the candidate consents, and the candidate owns the ring-VRF key — and that the key is not already in the collection |
| `Fee` | `register_with_fee`: the candidate paid `RegistrationFee` and proved key ownership. **No attestation and no uniqueness check of any kind** |

So in neither case does the chain establish *a human*. Under `UniqueDevice`, one
person per record is the **attester's** claim; the chain checked signatures, not
people. Under `Fee` it is not claimed by anyone — nothing stops one person
registering repeatedly with fresh accounts and fresh keys, paying each time.

The app shows which method was used, because "registered" alone does not say.

**On this devnet, all 275 lite people were registered by `UniqueDevice`; none by
`Fee` [T]** (scanned 2026-09-05). The fee path is live code with no instances
here, so the app's handling of it is verified against the pallet and synthetic
data, not against a real record.

### The tier — None / Lite / Full

The tier does **not** come from registration. The precompile calls
`personhood_info(account, context)`, which returns nothing unless the account has
an **alias** in that context; the tier is then derived from which ring collection
that alias belongs to — `PEOPLE_LITE_IDENTIFIER` → Lite, `PEOPLE_IDENTIFIER` →
Full **[S]**.

`alias-accounts` documents `AliasFee` as *"`None` fails every registration with
`AliasFeeUnset`"*, and `set_paid_alias_account` reads it on entry **[S]**. It is
unset on this devnet **[T]**.

**So no alias can be bound, and every account reads `None` — Lite and Full are
both unreachable here, not just Full.** A `None` result on this devnet says
nothing whatsoever about the account.

### An alias

Per the pallet docs an alias is the same person across sessions **within one
context**, and a different context yields a different alias that cannot be linked
to it **[S]**. That is the privacy property the design is built on.

**This app has never observed one**, because none can exist here — treat the
behaviour as `[S]`, not `[T]`.

One caveat that is structural rather than cryptographic: `AccountToAlias` is a
public map holding **one alias per account** **[S]**. The unlinkability is between
*aliases in different contexts*, not between an account and its alias. An account
that binds an alias is publicly tied to it, so using one account across two
contexts defeats the property the alias exists to provide.

### "No record"

This account has no personhood. It does **not** establish that the person behind
it has none — personhood binds to the account that owns the username, which is
usually not the product or session account an app shows you **[T]**.

### "Couldn't read"

Exactly what it says, and deliberately distinct from every state above. See
[the rule this app is built around](#a-rule-this-app-is-built-around).

## Context

The `context` field scopes the alias. `dotns` is what DotNS uses. Change it and
the same person yields a *different, unlinkable* alias — that's the privacy
property, and you can watch it happen.

## Caveats

Devnet only. Tokens have no value, state may be reset. The underlying protocol is
an unaudited prototype and so is this.

One hazard worth repeating: `personhoodInfoByProof` is replayable. It verifies a
proof but does not bind it to the caller or to a nonce, so a contract that trusts
it must handle replay itself.

## A rule this app is built around

**An unreachable endpoint is never rendered as a negative.**

This is not hypothetical. An earlier version read the People chain through a host
that began answering CORS preflights without `Access-Control-*` headers. The
request never left the browser, the failure was swallowed into a null, and a
registered person was displayed as **"no record"** — the one wrong answer this
app must never give. It did that in public for five days.

So every field carries three states, not two: a value, a definite "no" from the
chain, and *unknown*. Unknown says so, in its own colour. Absence of evidence is
displayed as absence of evidence.

Public RPC endpoints also rot quietly in ways a shell test will not catch — an
expired certificate and a missing preflight header both pass `curl` and both are
fatal in a browser. Hence the failover lists.
