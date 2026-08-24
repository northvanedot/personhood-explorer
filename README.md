# Personhood Explorer

Reads proof-of-personhood state from the Polkadot Products Devnet and explains
what it means.

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

Paste an **SS58 or EVM address**. It reports the personhood tier
(None / Lite / Full), the contextual alias, and a diagnosis:

- **No record** — and where personhood actually binds (the Pocket account, not
  the product or session account)
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
| RPC | `https://paseo-assethub-rpc.laissez-faire.trade` |

Personhood is proved by **ring-VRF membership**. The alias is *unique per person
per context*, so activity in one app cannot be linked to another. Ring roots
reach Asset Hub from the People chain over **XCM pub/sub**, which is why
verification works here without touching the People chain.

`keccak256(publicKey)[12:]` maps SS58 → EVM — verified against `dotns pop info`.

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
