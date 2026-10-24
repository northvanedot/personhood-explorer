// Minimal Substrate storage reads over plain HTTPS JSON-RPC.
//
// Enough to check whether a storage entry exists, without pulling in a full
// chain client. Substrate storage keys are twox128(pallet) ++ twox128(entry)
// ++ hash(key), so we need xxhash64 — it isn't in @noble/hashes.

import { blake2b } from "@noble/hashes/blake2.js";

// Ordered, first that answers wins. rotko.net is last on purpose: it serves
// state fine over curl but answers the CORS preflight with no Access-Control
// headers, so a browser can never use it — which silently blanked the whole
// People-chain panel. The other two send full preflight headers.
export const PEOPLE_RPCS = [
  "https://people-paseo.gatotech.network",
  "https://rpc.interweb-it.com/people-paseo",
  "https://people-paseo.rotko.net",
];
export const PEOPLE_RPC = PEOPLE_RPCS[0];

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

export const ASSET_HUB_RPCS = [
  "https://asset-hub-paseo-rpc.n.dwellir.com",
  "https://sys.turboflakes.io/asset-hub-paseo",
];
export const ASSET_HUB_RPC = ASSET_HUB_RPCS[0];

export function storageKey(pallet, entry, keyBytes) {
  return "0x" + twox128(pallet) + twox128(entry) + (keyBytes ? blake2_128Concat(keyBytes) : "");
}

// Which endpoint last answered, per list, so failover is paid once per session
// rather than on every call.
const live = new Map();

/**
 * One JSON-RPC call, tried against each endpoint until one responds.
 *
 * `urls` may be a single string so callers can still pin one endpoint. A
 * node-level error (bad key, unknown method) is the chain answering and is
 * rethrown; only a transport failure moves on to the next endpoint.
 */
async function rpc(method, params, urls) {
  const list = Array.isArray(urls) ? urls : [urls];
  const key = list[0];
  const first = live.get(key);
  const ordered = first ? [first, ...list.filter((u) => u !== first)] : list;

  let transportError;
  for (const url of ordered) {
    let json;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      json = await response.json();
    } catch (e) {
      transportError = e;
      continue;
    }
    live.set(key, url);
    if (json.error) throw new Error(json.error.message);
    return json.result ?? null;
  }
  throw new Error(`no RPC endpoint reachable (${transportError?.message ?? "unknown"})`);
}

/**
 * Is the alias fee set on Asset Hub?
 *
 * `set_alias_account` aborts with `AliasFeeUnset` while the fee is None — so
 * while it is, *no account on the chain can bind an alias*. Worth surfacing,
 * because the symptom otherwise looks like the user's own mistake.
 *
 * From runtime v2.5.x the fee is no longer `AliasAccounts.AliasFee` storage —
 * that item is gone, so reading it returns null whatever the fee is. It is a
 * root-only dynamic parameter in `pallet_parameters`, default None
 * (paseo-network/runtimes, asset-hub-paseo). The key is
 * `RuntimeParametersKey::AliasAccounts(AliasFee)` = [3, 0]; the value is
 * [3, 0, Option<u128>]. No entry means the default, None.
 */
const ALIAS_FEE_PARAM = new Uint8Array([3, 0]);

export async function aliasFee(urls = ASSET_HUB_RPCS) {
  const raw = await rpc("state_getStorage", [storageKey("Parameters", "Parameters", ALIAS_FEE_PARAM)], urls);
  // Third byte is the Option tag: 01 = Some(fee), 00 = None set explicitly. The fee
  // itself is a little-endian u128 after it, in the PGAS asset's base units.
  if (raw === null || raw.slice(6, 8) !== "01") return { set: false, amount: null };
  const le = raw.slice(8, 8 + 32).match(/../g).reverse().join("");
  return { set: true, amount: BigInt("0x" + le) };
}

/**
 * How many accounts have an alias bound on Asset Hub, chain-wide. Keys only, so one
 * request while the map is small. A failed read throws rather than returning 0.
 */
export async function aliasCount(urls = ASSET_HUB_RPCS) {
  const prefix = "0x" + twox128("AliasAccounts") + twox128("AccountToAlias");
  let total = 0;
  for (let start = null; ; ) {
    const page = await rpc("state_getKeysPaged", [prefix, 1000, start], urls);
    if (!page?.length) break;
    total += page.length;
    if (page.length < 1000) break;
    start = page[page.length - 1];
  }
  return total;
}

/** Returns the raw SCALE hex at a storage key, or null when the entry is empty. */
export async function getStorage(pallet, entry, keyBytes, urls = PEOPLE_RPCS) {
  return await rpc("state_getStorage", [storageKey(pallet, entry, keyBytes)], urls);
}

// pallet-revive answers `account_id` for addresses that were never mapped by
// fabricating `<the 20 h160 bytes> ‖ 0xEE × 12` instead of failing. Rendering
// that as an account would invent a person who does not exist, so it is checked
// on every result. A real key colliding with this shape is a 2^-96 event.
const FABRICATED_SUFFIX = "ee".repeat(12);

/**
 * EVM address → the Substrate account it maps to, via the `ReviveApi_account_id`
 * runtime API.
 *
 * `keccak256(pubkey)[12:]` goes the other way and is not invertible, so this is
 * the only route from an EVM address back to an account. It rides on plain
 * `state_call` — the argument is 20 raw bytes and the result is 32, neither of
 * which needs a SCALE codec.
 *
 * Returns `mapped: false` for the fabricated case. Callers must render that as
 * "not mapped" and never as an address.
 */
export async function accountIdForEvm(evmAddress, urls = ASSET_HUB_RPCS) {
  const h160 = evmAddress.toLowerCase().replace(/^0x/, "");
  const raw = await rpc("state_call", ["ReviveApi_account_id", "0x" + h160], urls);
  if (!raw) throw new Error("ReviveApi_account_id returned nothing");
  const pk = raw.replace(/^0x/, "");
  const fabricated = pk.slice(0, 40) === h160 && pk.slice(40) === FABRICATED_SUFFIX;
  return { publicKey: fabricated ? null : "0x" + pk, mapped: !fabricated };
}

/**
 * PeopleLite.LitePeople — presence means the account is a registered person on
 * the People chain. The value begins with the 32-byte ring VRF key.
 */
export async function litePeople(publicKey, urls = PEOPLE_RPCS) {
  const raw = await getStorage("PeopleLite", "LitePeople", publicKey, urls);
  if (!raw) return null;
  const body = raw.replace(/^0x/, "");
  // `LitePersonInfo` is `{ ring_vrf_key: [u8;32], method: RecognitionMethod }`,
  // and `RecognitionMethod` is a SCALE enum: 0x00 `UniqueDevice(AccountId32)`,
  // 0x01 `Fee`. So the whole record is already in hand — 65 bytes for the first,
  // 33 for the second — and reading the method costs no extra request.
  //
  // It is worth reading because the two mean very different things: `Fee` is a
  // payment with no uniqueness check at all.
  const tag = body.slice(64, 66);
  const method =
    tag === "00" ? { kind: "device", attester: "0x" + body.slice(66) }
    : tag === "01" ? { kind: "fee" }
    : { kind: "unknown", tag };
  return { raw, ringVrfKey: "0x" + body.slice(0, 64), method };
}

/**
 * Every PeopleLite.LitePeople record, counted by recognition method.
 *
 * Read live because a hard-coded count went stale twice in six weeks (275 → 401 →
 * 850). Keys are paged, then the values fetched in batches to read each method
 * tag — the same 00 `UniqueDevice` / 01 `Fee` byte `litePeople` decodes. Around a
 * thousand records costs half a dozen requests, which is why the caller only
 * asks when someone opens the section that uses it.
 */
export async function litePeopleTally(urls = PEOPLE_RPCS) {
  const prefix = "0x" + twox128("PeopleLite") + twox128("LitePeople");
  const keys = [];
  for (let start = null; ; ) {
    const page = await rpc("state_getKeysPaged", [prefix, 1000, start], urls);
    if (!page?.length) break;
    keys.push(...page);
    if (page.length < 1000) break;
    start = page[page.length - 1];
  }
  const tally = { total: keys.length, device: 0, fee: 0, other: 0 };
  for (let i = 0; i < keys.length; i += 200) {
    const [set] = await rpc("state_queryStorageAt", [keys.slice(i, i + 200)], urls);
    for (const [, value] of set.changes) {
      // Value is ring_vrf_key (32 bytes) then the method tag.
      const tag = value?.slice(2 + 64, 2 + 66);
      tag === "00" ? tally.device++ : tag === "01" ? tally.fee++ : tally.other++;
    }
  }
  return tally;
}

/**
 * How many entries a storage map holds, from its keys alone: no values fetched, so
 * a map under a thousand entries is one request. Used for the live stats strip.
 * A failed read throws, so the caller can show "–" rather than a zero.
 */
export async function countEntries(pallet, entry, urls = PEOPLE_RPCS) {
  const prefix = "0x" + twox128(pallet) + twox128(entry);
  let total = 0;
  for (let start = null; ; ) {
    const page = await rpc("state_getKeysPaged", [prefix, 1000, start], urls);
    if (!page?.length) break;
    total += page.length;
    if (page.length < 1000) break;
    start = page[page.length - 1];
  }
  return total;
}

/** PeopleLite.AccountToAlias — presence means an alias is bound for this account. */
export async function accountToAlias(publicKey, urls = PEOPLE_RPCS) {
  return await getStorage("PeopleLite", "AccountToAlias", publicKey, urls);
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
 * Read every page. One page of 1000 was enough until the devnet passed 982 usernames
 * on 2026-10-24; past that, names that hash into a later page would have come back
 * "not registered" — a missing read shown as an answer. Cached for the session.
 */
export async function fetchUsernames(urls = PEOPLE_RPCS) {
  if (usernameCache) return usernameCache;

  const prefix = "0x" + twox128("Resources") + twox128("UsernameOwnerOf");
  const keys = [];
  for (let start = null; ; ) {
    const page = await rpc("state_getKeysPaged", [prefix, 1000, start], urls);
    if (!page?.length) break;
    keys.push(...page);
    if (page.length < 1000) break;
    start = page[page.length - 1];
  }
  if (!keys.length) return (usernameCache = []);

  const changes = [];
  for (let i = 0; i < keys.length; i += 500) {
    const [set] = await rpc("state_queryStorageAt", [keys.slice(i, i + 500)], urls);
    changes.push(...set.changes);
  }

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

/** Usernames owned by a public key. */
export async function usernamesFor(publicKey, urls = PEOPLE_RPCS) {
  const want =
    "0x" + Array.from(publicKey, (b) => b.toString(16).padStart(2, "0")).join("");
  return (await fetchUsernames(urls))
    .filter((u) => u.ownerHex === want)
    .map((u) => u.username);
}

/**
 * Resolve a username to its owner's public key.
 * Accepts `northvane` or `northvane.02` — a bare label matches on the stem, but only
 * when exactly one username has that stem. Suffixes exist because a stem can belong to
 * several accounts (one person reinstalling gets a new one), so picking the first would
 * silently answer for the wrong account.
 */
export async function resolveUsername(input, urls = PEOPLE_RPCS) {
  const all = await fetchUsernames(urls);
  const q = input.trim().toLowerCase();
  const toHit = (u) => ({ username: u.username, publicKey: fromHex(u.ownerHex.slice(2)) });
  const exact = all.find((u) => u.username.toLowerCase() === q);
  if (exact) return toHit(exact);
  const stem = all.filter((u) => u.username.toLowerCase().replace(/\.\d+$/, "") === q);
  if (stem.length > 1) {
    const names = stem.map((u) => u.username).sort().join(" or ");
    throw new Error(
      `"${input.trim()}" could be ${names}. Type one in full, or ${q}.dot for the .dot name.`,
    );
  }
  return stem.length ? toHit(stem[0]) : null;
}
