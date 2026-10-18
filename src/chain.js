// Read-only queries against the Polkadot Products Devnet.
//
// Everything here goes through plain Ethereum JSON-RPC `eth_call` — no host,
// no wallet, no signing. The personhood constants were verified 2026-08-07 against the
// IPersonhood interface in Polkadot-Community-Foundation/individuality-community; the
// DotNS addresses below come from polkadot-app-deploy's devnet environment.

import { keccak_256 } from "@noble/hashes/sha3.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { base58 } from "@scure/base";

// A single hard-coded endpoint took the whole app down on 2026-08-31, when this
// host's Let's Encrypt certificate expired: browsers hard-fail an expired cert,
// so every EVM-side lookup threw with nothing to fall back on. Ordered list,
// first one that answers wins. Both were confirmed to be the same chain —
// identical eth_chainId, identical classifyName() result, and a block height
// matching the Substrate RPC.
export const RPCS = [
  "https://eth-rpc-testnet.polkadot.io",
  "https://services.polkadothub-rpc.com/testnet",
  "https://paseo-assethub-rpc.laissez-faire.trade",
];
export const RPC = RPCS[0];
export const PERSONHOOD_PRECOMPILE = "0x000000000000000000000000000000000a010000";

// DotNS contracts — the v3 set, from the devnet environment shipped in
// polkadot-app-deploy 0.16.6+ and the docs' Addresses page. Devnet has moved DotNS
// twice, and each time the old contracts stay readable and answer without error,
// so a stale address here does not fail: it quietly reports every newer name as
// unregistered. Until 2026-10-05 this file read v1, retired 2026-09-08.
export const POP_RULES = "0xD5Ee34610F06f7FF4668aB4fabE2393B65a43AE7";

/** Personhood tiers. 0–2 are documented in IPersonhood; the dotns CLI also maps 3. */
export const TIERS = {
  0: { key: "none", label: "None", blurb: "No alias in this context" },
  1: { key: "lite", label: "Lite", blurb: "ProofOfPersonhoodLite" },
  2: { key: "full", label: "Full", blurb: "ProofOfPersonhoodFull" },
  3: { key: "reserved", label: "Reserved", blurb: "Reserved tier" },
};

// Browser-safe — no Buffer.
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const toBytes = (h) => Uint8Array.from(h.replace(/^0x/, "").match(/../g).map((b) => parseInt(b, 16)));

// ── addresses ───────────────────────────────────────────────────────────────

/** Decode an SS58 address to its 32-byte public key, verifying the checksum. */
export function ss58ToPublicKey(address) {
  const raw = base58.decode(address);
  // Prefix is 1 byte below 64, otherwise 2 bytes.
  const prefixLen = raw[0] < 64 ? 1 : 2;
  const body = raw.slice(0, prefixLen + 32);
  const checksum = raw.slice(prefixLen + 32);
  if (body.length !== prefixLen + 32 || checksum.length < 2) {
    throw new Error("Not a 32-byte SS58 address");
  }
  const expected = blake2b(
    new Uint8Array([...new TextEncoder().encode("SS58PRE"), ...body]),
    { dkLen: 64 },
  );
  if (checksum[0] !== expected[0] || checksum[1] !== expected[1]) {
    throw new Error("SS58 checksum mismatch — is the address complete?");
  }
  return raw.slice(prefixLen, prefixLen + 32);
}

/** Encode a 32-byte public key back to SS58. Inverse of ss58ToPublicKey. */
export function publicKeyToSs58(publicKey, prefix = 42) {
  const body = new Uint8Array([prefix, ...publicKey]);
  const checksum = blake2b(
    new Uint8Array([...new TextEncoder().encode("SS58PRE"), ...body]),
    { dkLen: 64 },
  );
  return base58.encode(new Uint8Array([...body, checksum[0], checksum[1]]));
}

/**
 * Map a Substrate public key to its EVM address.
 * `keccak256(publicKey)[12:]` — verified against `dotns pop info`, which reports
 * 5DfhGyQd…EqRzV as 0x35cdb23f…8d20.
 */
export function publicKeyToEvm(publicKey) {
  return "0x" + hex(keccak_256(publicKey).slice(12));
}

/**
 * Accept either an SS58 address or a 0x EVM address.
 *
 * Anything starting `0x` is judged as an EVM address rather than falling
 * through to the SS58 path — otherwise a mistyped EVM address produces a
 * base58 alphabet error, which sends people looking in the wrong place.
 */
export function resolveAddress(input) {
  const value = input.trim();

  if (/^0x/i.test(value)) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
      throw new Error(
        `An EVM address is 0x followed by 40 hex characters — this one has ${value.replace(/^0x/i, "").length}.`,
      );
    }
    return { evm: value.toLowerCase(), ss58: null, publicKey: null };
  }

  let publicKey;
  try {
    publicKey = ss58ToPublicKey(value);
  } catch (err) {
    // Surface our own checks; translate the base58 decoder's internals.
    if (/checksum|32-byte/i.test(err.message)) throw err;
    throw new Error(
      "Not a recognisable address. Expected an SS58 address (like 5DXuuCoE…) or an EVM address (0x… with 40 hex characters).",
    );
  }
  return { evm: publicKeyToEvm(publicKey), ss58: value, publicKey: "0x" + hex(publicKey) };
}

// ── abi ─────────────────────────────────────────────────────────────────────

const selector = (sig) => hex(keccak_256(new TextEncoder().encode(sig)).slice(0, 4));
const words = (result) => (result.replace(/^0x/, "").match(/.{64}/g) ?? []);

/** Right-pad an ASCII string into a bytes32 word. */
export function contextWord(text) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > 32) throw new Error("Context must be 32 bytes or fewer");
  return hex(bytes).padEnd(64, "0");
}

function encodeString(text) {
  const bytes = new TextEncoder().encode(text);
  const body = hex(bytes).padEnd(Math.ceil(bytes.length / 32) * 64 || 64, "0");
  return (32).toString(16).padStart(64, "0") + bytes.length.toString(16).padStart(64, "0") + body;
}

function decodeString(result, wordIndex) {
  const w = words(result);
  const start = parseInt(w[wordIndex], 16) / 32;
  const length = parseInt(w[start], 16);
  if (!length) return "";
  return new TextDecoder().decode(toBytes(w.slice(start + 1).join("").slice(0, length * 2)));
}

// Remembered so that once an endpoint has answered we stop paying the failover
// cost on every subsequent call in the session.
let liveRpc = null;

async function ethCall(to, data) {
  const body = JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "eth_call",
    params: [{ to, data: "0x" + data }, "latest"],
  });
  // A revert is the chain's answer, not an outage — rethrow it rather than
  // retrying elsewhere, or a genuine `NoPersonhood` would look like downtime.
  let transportError;
  for (const rpc of liveRpc ? [liveRpc, ...RPCS.filter((r) => r !== liveRpc)] : RPCS) {
    let json;
    try {
      const response = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      json = await response.json();
    } catch (e) {
      transportError = e;
      continue;
    }
    liveRpc = rpc;
    if (json.error) throw new Error(json.error.message);
    return json.result;
  }
  throw new Error(`no devnet RPC reachable (${transportError?.message ?? "unknown"})`);
}

// ── queries ─────────────────────────────────────────────────────────────────

/** IPersonhood.personhoodStatus(address,bytes32) → { status, contextAlias } */
export async function personhoodStatus(evmAddress, context = "dotns") {
  const data =
    selector("personhoodStatus(address,bytes32)") +
    evmAddress.replace(/^0x/, "").toLowerCase().padStart(64, "0") +
    contextWord(context);
  const result = await ethCall(PERSONHOOD_PRECOMPILE, data);
  const w = words(result);
  const alias = "0x" + w[1];
  return {
    status: parseInt(w[0], 16),
    contextAlias: alias,
    aliasSet: !/^0x0+$/.test(alias),
  };
}

/**
 * PopRules.classifyName(string) → which personhood tier a label requires.
 * Labels containing a dot revert — this takes a bare label, not `name.dot`.
 */
export async function classifyName(label) {
  const result = await ethCall(POP_RULES, selector("classifyName(string)") + encodeString(label));
  return {
    requires: parseInt(words(result)[0], 16),
    message: decodeString(result, 1),
  };
}

export const DOTNS_REGISTRY = "0xb052E5EfC5ADEff1f21d48DEfb5169Cb394A1a73";

/** ENS-style namehash: fold labels right-to-left into a 32-byte node. */
export function namehash(name) {
  let node = new Uint8Array(32);
  for (const label of name.split(".").reverse()) {
    const labelHash = keccak_256(new TextEncoder().encode(label));
    node = keccak_256(new Uint8Array([...node, ...labelHash]));
  }
  return hex(node);
}

/** Registry owner of `<label>.dot`, or null if unregistered. */
export async function nameOwner(label) {
  const result = await ethCall(
    DOTNS_REGISTRY,
    selector("owner(bytes32)") + namehash(`${label}.dot`),
  );
  const owner = "0x" + words(result)[0].slice(24);
  return /^0x0+$/.test(owner) ? null : owner;
}

export const DOTNS_REGISTRAR = "0xc609e0c2DAB4433d55a32FB098Db8788C1956302";

/**
 * How many `.dot` names an EVM address owns.
 *
 * A count is all the chain will give. The registrar answers
 * `supportsInterface(0x80ac58cd)` — it is ERC-721 — but returns 0 for
 * `0x780e9d63` and reverts on `tokenOfOwnerByIndex`, so it is **not
 * enumerable** and the names cannot be listed. Verified 2026-09-05.
 * Confirming an individual name means asking `owner()` about that name.
 */
export async function dotNameCount(evmAddress) {
  const result = await ethCall(
    DOTNS_REGISTRAR,
    selector("balanceOf(address)") + evmAddress.replace(/^0x/, "").toLowerCase().padStart(64, "0"),
  );
  return Number(BigInt("0x" + words(result)[0]));
}

/** PopRules.price(string) → registration price, in 18-decimal EVM units. */
export async function namePrice(label) {
  const result = await ethCall(POP_RULES, selector("price(string)") + encodeString(label));
  // pallet-revive scales 18-decimal EVM values to the 10-decimal native token.
  return Number(BigInt("0x" + words(result)[0])) / 1e18;
}

/** PopRules.getBaseNameReservation(string) → who has this base name reserved. */
export async function baseNameReservation(label) {
  const result = await ethCall(
    POP_RULES,
    selector("getBaseNameReservation(string)") + encodeString(label),
  );
  const w = words(result);
  const owner = "0x" + w[0].slice(24);
  return {
    owner: /^0x0+$/.test(owner) ? null : owner,
    expiry: parseInt(w[1], 16) || null,
  };
}
