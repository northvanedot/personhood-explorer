// Minimal Substrate storage reads over plain HTTPS JSON-RPC.
//
// Enough to check whether a storage entry exists, without pulling in a full
// chain client. Substrate storage keys are twox128(pallet) ++ twox128(entry)
// ++ hash(key), so we need xxhash64 — it isn't in @noble/hashes.

import { blake2b } from "@noble/hashes/blake2.js";

export const PEOPLE_RPC = "https://people-paseo.rotko.net";

// ── xxhash64 ────────────────────────────────────────────────────────────────

const MASK = (1n << 64n) - 1n;
const P1 = 11400714785074694791n;
const P2 = 14029467366897019727n;
const P3 = 1609587929392839161n;
const P4 = 9650029242287828579n;
const P5 = 2870177450012600261n;

const mul = (a, b) => (a * b) & MASK;
const add = (a, b) => (a + b) & MASK;
const rotl = (x, r) => ((x << r) | (x >> (64n - r))) & MASK;
const round = (acc, lane) => mul(rotl(add(acc, mul(lane, P2)), 31n), P1);
const merge = (acc, val) => add(mul(acc ^ round(0n, val), P1), P4);

function u64le(bytes, i) {
  let v = 0n;
  for (let k = 7; k >= 0; k--) v = (v << 8n) | BigInt(bytes[i + k]);
  return v;
}
function u32le(bytes, i) {
  return BigInt(bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)) & 0xffffffffn;
}

export function xxhash64(input, seed = 0n) {
  const len = input.length;
  let i = 0;
  let acc;

  if (len >= 32) {
    let a1 = add(add(seed, P1), P2);
    let a2 = add(seed, P2);
    let a3 = seed;
    let a4 = (seed - P1) & MASK;
    for (; i <= len - 32; i += 32) {
      a1 = round(a1, u64le(input, i));
      a2 = round(a2, u64le(input, i + 8));
      a3 = round(a3, u64le(input, i + 16));
      a4 = round(a4, u64le(input, i + 24));
    }
    acc = add(add(rotl(a1, 1n), rotl(a2, 7n)), add(rotl(a3, 12n), rotl(a4, 18n)));
    acc = merge(acc, a1);
    acc = merge(acc, a2);
    acc = merge(acc, a3);
    acc = merge(acc, a4);
  } else {
    acc = add(seed, P5);
  }

  acc = add(acc, BigInt(len));

  for (; i <= len - 8; i += 8) {
    acc = add(mul(rotl(acc ^ round(0n, u64le(input, i)), 27n), P1), P4);
  }
  if (i <= len - 4) {
    acc = add(mul(rotl(acc ^ mul(u32le(input, i), P1), 23n), P2), P3);
    i += 4;
  }
  for (; i < len; i++) {
    acc = mul(rotl(acc ^ mul(BigInt(input[i]), P5), 11n), P1);
  }

  acc = mul(acc ^ (acc >> 33n), P2);
  acc = mul(acc ^ (acc >> 29n), P3);
  return acc ^ (acc >> 32n);
}

const leBytes = (value) => {
  const out = new Uint8Array(8);
  let v = value;
  for (let i = 0; i < 8; i++) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
};

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** twox128 — two xxhash64 rounds (seeds 0 and 1), little-endian, concatenated. */
export function twox128(text) {
  const input = new TextEncoder().encode(text);
  return hex(leBytes(xxhash64(input, 0n))) + hex(leBytes(xxhash64(input, 1n)));
}

/** Blake2_128Concat — the hasher Substrate uses for AccountId map keys. */
export function blake2_128Concat(bytes) {
  return hex(blake2b(bytes, { dkLen: 16 })) + hex(bytes);
}

// ── storage ─────────────────────────────────────────────────────────────────

export const ASSET_HUB_RPC = "https://asset-hub-paseo-rpc.n.dwellir.com";

export function storageKey(pallet, entry, keyBytes) {
  return "0x" + twox128(pallet) + twox128(entry) + (keyBytes ? blake2_128Concat(keyBytes) : "");
}

async function rpc(method, params, url) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await response.json();
  if (json.error) throw new Error(json.error.message);
  return json.result ?? null;
}

/**
 * AliasAccounts.AliasFee on Asset Hub.
 *
 * `set_alias_account` reads this on its second line and aborts with
 * `AliasFeeUnset` when it's None — so while this is empty, *no account on the
 * chain can bind an alias*. Worth surfacing, because the symptom otherwise looks
 * like the user's own mistake.
 */
export async function aliasFeeSet(url = ASSET_HUB_RPC) {
  const raw = await rpc("state_getStorage", [storageKey("AliasAccounts", "AliasFee", null)], url);
  return raw !== null;
}

/** Returns the raw SCALE hex at a storage key, or null when the entry is empty. */
export async function getStorage(pallet, entry, keyBytes, rpc = PEOPLE_RPC) {
  const response = await fetch(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "state_getStorage",
      params: [storageKey(pallet, entry, keyBytes)],
    }),
  });
  const json = await response.json();
  if (json.error) throw new Error(json.error.message);
  return json.result ?? null;
}

/**
 * PeopleLite.LitePeople — presence means the account is a registered person on
 * the People chain. The value begins with the 32-byte ring VRF key.
 */
export async function litePeople(publicKey, rpc = PEOPLE_RPC) {
  const raw = await getStorage("PeopleLite", "LitePeople", publicKey, rpc);
  if (!raw) return null;
  return { raw, ringVrfKey: "0x" + raw.replace(/^0x/, "").slice(0, 64) };
}

/** PeopleLite.AccountToAlias — presence means an alias is bound for this account. */
export async function accountToAlias(publicKey, rpc = PEOPLE_RPC) {
  return await getStorage("PeopleLite", "AccountToAlias", publicKey, rpc);
}

// ── usernames ───────────────────────────────────────────────────────────────

let usernameCache = null;

/**
 * Every registered username and its owner, in two RPC calls.
 *
 * There is no reverse (account → username) storage entry, so we enumerate the
 * whole map. `Resources.UsernameOwnerOf` uses Blake2_128Concat, which appends
 * the *unhashed* key to the storage key — so the username itself is readable
 * straight out of the key list, no extra lookup needed.
 *
 * ~221 entries on the devnet, so this is cheap. Cached for the session.
 */
export async function fetchUsernames(rpc = PEOPLE_RPC) {
  if (usernameCache) return usernameCache;

  const prefix = "0x" + twox128("Resources") + twox128("UsernameOwnerOf");
  const keys = await rpc_("state_getKeysPaged", [prefix, 1000], rpc);
  if (!keys?.length) return (usernameCache = []);

  const [{ changes }] = await rpc_("state_queryStorageAt", [keys], rpc);

  usernameCache = changes
    .filter(([, value]) => value)
    .map(([key, value]) => ({
      // Strip 16B twox128(pallet) + 16B twox128(entry) + 16B blake2_128, then
      // the SCALE compact length prefix on the string itself.
      username: decodeScaleString(fromHex(key.slice(2 + 64 + 32))),
      ownerHex: value.toLowerCase(),
    }));
  return usernameCache;
}

/** Decode a SCALE-encoded string: compact length prefix, then UTF-8 bytes. */
function decodeScaleString(bytes) {
  const mode = bytes[0] & 0b11;
  const offset = mode === 0 ? 1 : mode === 1 ? 2 : mode === 2 ? 4 : 1 + (bytes[0] >> 2);
  return new TextDecoder().decode(bytes.slice(offset));
}

const fromHex = (h) => Uint8Array.from(h.match(/../g).map((b) => parseInt(b, 16)));

async function rpc_(method, params, url) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await response.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

/** Usernames owned by a public key. */
export async function usernamesFor(publicKey, rpc = PEOPLE_RPC) {
  const want =
    "0x" + Array.from(publicKey, (b) => b.toString(16).padStart(2, "0")).join("");
  return (await fetchUsernames(rpc))
    .filter((u) => u.ownerHex === want)
    .map((u) => u.username);
}

/**
 * Resolve a username to its owner's public key.
 * Accepts `northvane` or `northvane.01` — bare labels match on the stem.
 */
export async function resolveUsername(input, rpc = PEOPLE_RPC) {
  const all = await fetchUsernames(rpc);
  const q = input.trim().toLowerCase();
  const hit =
    all.find((u) => u.username.toLowerCase() === q) ??
    all.find((u) => u.username.toLowerCase().replace(/\.\d+$/, "") === q);
  return hit ? { username: hit.username, publicKey: fromHex(hit.ownerHex.slice(2)) } : null;
}
