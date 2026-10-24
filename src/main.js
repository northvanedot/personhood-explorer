import "./fonts.css";
import {
  resolveAddress,
  personhoodStatus,
  classifyName,
  baseNameReservation,
  nameOwner,
  namePrice,
  dotNameCount,
  TIERS,
  publicKeyToSs58,
  publicKeyToEvm,
} from "./chain.js";
import {
  litePeople,
  accountToAlias,
  aliasFee,
  aliasCount,
  countEntries,
  resolveUsername,
  usernamesFor,
  accountIdForEvm,
} from "./substrate.js";

const $ = (id) => document.getElementById(id);

// Anything that reaches innerHTML goes through this. There was an XSS here once.
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

/**
 * Three-state results: a value, a definite "no" from the chain, or UNKNOWN.
 *
 * Collapsing the third into the second is the bug that showed a registered person
 * as unregistered for five days in August, when an endpoint stopped answering.
 * The page is simple now, but every answer still has its own "Couldn't check".
 */
const UNKNOWN = Symbol("unknown");
const settle = (promise) => promise.then((v) => v, () => UNKNOWN);

// The precompile answers per context; the app checks the one DotNS uses.
const CONTEXT = "dotns";

const pill = (kind, text) => `<span class="pill ${kind}">${esc(text)}</span>`;
const short = (s) => (s.length > 14 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s);
const fmt = (n) => n.toLocaleString("en-US");

// The alias fee is chain-wide, so one read serves the whole session. null means
// it could not be read, which is never treated as "unset".
let aliasFeePromise = null;
const feeSetOnce = () =>
  (aliasFeePromise ??= aliasFee().then((f) => f.set, () => null));

// From the last lookup, so the name checker can say whether that account qualifies.
let lastTier = null;
// The live alias count from the stats strip; null until read, or if the read failed.
let aliasesBound = null;

/**
 * Work out which account the input names, from any of the four identifiers a
 * person has here: an SS58 address, an EVM address, a username, or a
 * `.dot` name.
 *
 * Everything anchors on the **identity account** — the one that owns the
 * username and carries the personhood record. Product accounts are per-app and
 * are exactly what made this confusing to begin with, so they are never the
 * anchor.
 */
async function resolveIdentity(value) {
  const dotMatch = value.match(/^(.+)\.dot$/i);
  const looksLikeAddress = /^0x[0-9a-fA-F]{40}$/.test(value);

  // From an EVM address the only way back to an account is the runtime API,
  // because keccak256 does not invert.
  if (looksLikeAddress) {
    const evm = value.toLowerCase();
    const account = await settle(accountIdForEvm(evm));
    return {
      via: "an EVM address",
      evm,
      publicKey: account === UNKNOWN ? UNKNOWN : account.publicKey,
      mapped: account === UNKNOWN ? UNKNOWN : account.mapped,
      dotLabel: null,
    };
  }

  if (dotMatch) {
    const label = dotMatch[1];
    const owner = await nameOwner(label);
    if (!owner) throw new Error(`${value} is not registered, so it names nobody.`);
    const account = await settle(accountIdForEvm(owner));
    return {
      via: `the owner of ${value}`,
      evm: owner.toLowerCase(),
      publicKey: account === UNKNOWN ? UNKNOWN : account.publicKey,
      mapped: account === UNKNOWN ? UNKNOWN : account.mapped,
      dotLabel: label,
    };
  }

  // An SS58 address, or a username that resolves to one. Both give the account
  // directly, so no reverse lookup is needed and `mapped` is not in question.
  let publicKeyHex = null;
  let via = "an SS58 address";
  try {
    publicKeyHex = resolveAddress(value).publicKey;
  } catch (addressError) {
    const hit = await resolveUsername(value);
    if (hit) {
      publicKeyHex = "0x" + Array.from(hit.publicKey, (b) => b.toString(16).padStart(2, "0")).join("");
      via = `the owner of ${hit.username}`;
    } else if (!/^0x/i.test(value)) {
      // Not an address and not a username — it may still be an unsuffixed name.
      const owner = await nameOwner(value);
      if (owner) {
        const account = await settle(accountIdForEvm(owner));
        return {
          via: `the owner of ${value}.dot`,
          evm: owner.toLowerCase(),
          publicKey: account === UNKNOWN ? UNKNOWN : account.publicKey,
          mapped: account === UNKNOWN ? UNKNOWN : account.mapped,
          dotLabel: value,
        };
      }
      throw new Error(
        `"${value}" is not an address, not a registered username, and not a registered .dot name.`,
      );
    } else {
      throw addressError;
    }
  }

  const publicKey = toPublicKeyBytes(publicKeyHex);
  return {
    via,
    evm: publicKeyToEvm(publicKey),
    publicKey: publicKeyHex,
    mapped: true,
    dotLabel: null,
  };
}

const toPublicKeyBytes = (hexKey) =>
  Uint8Array.from(hexKey.replace(/^0x/, "").match(/../g).map((b) => parseInt(b, 16)));

/** The answer for "Verified person", from the People chain record. */
function personAnswer(identity, people) {
  if (identity.mapped === false) {
    return [pill("no", "No account"), "This address has never been used on the devnet."];
  }
  if (identity.publicKey === UNKNOWN || people === UNKNOWN) {
    return [pill("unknown", "Couldn't check"), "The network didn't answer. Try again in a moment."];
  }
  if (!people.registered) return [pill("no", "Not a verified person"), "No personhood record for this account."];
  if (people.method?.kind === "fee") {
    return [pill("yes", "✓ Verified person, paid"), "Registered by paying a fee. No check that the person is unique."];
  }
  if (people.method?.kind === "device") {
    return [pill("yes", "✓ Verified person"), "Registered from the Polkadot app and confirmed as one unique device."];
  }
  return [pill("yes", "✓ Verified person"), "Registered, by a method this app doesn't recognise."];
}

/** The answer for "Proven to apps": does Asset Hub see an alias for this account. */
function appsAnswer(info, people, feeSet) {
  if (info === UNKNOWN) return [pill("unknown", "Couldn't check"), ""];
  const tier = TIERS[info.status];
  if (info.status === 1 || info.status === 2) {
    return [pill("yes", `Yes, ${tier.label}`), "Apps can check this account is a person, through a private alias."];
  }
  if (people !== UNKNOWN && people?.aliasBound) {
    return [pill("yes", "Yes"), "This account has a private alias that apps can check."];
  }
  if (people === UNKNOWN || !people?.registered) return [pill("no", "No"), ""];
  // Only say what is true today: whether anyone has done it, from the live count.
  // How to do it is left out, because no Polkadot app offers it yet (2026-10-24).
  return [
    pill("no", "Not yet"),
    feeSet === false
      ? "Not possible on this devnet yet."
      : aliasesBound === 0
        ? "Nobody on the devnet has done this yet."
        : "",
  ];
}

function namesAnswer(dotCount, confirmedNames) {
  if (dotCount === UNKNOWN) return pill("unknown", "Couldn't check");
  if (dotCount === 0) return "None";
  // The registrar can count names but not list them, so only the ones we could
  // confirm are named, and the rest are counted.
  const named = confirmedNames.map((n) => `${esc(n)}.dot`);
  const rest = dotCount - confirmedNames.length;
  if (!named.length) return esc(fmt(dotCount));
  return named.join(", ") + (rest > 0 ? ` and ${esc(fmt(rest))} more` : "");
}

function resetCard() {
  $("error").textContent = "";
  $("error").classList.add("hidden");
  // Clear, not just hide: a card left holding the previous person's details is
  // misleading the moment the next lookup fails.
  for (const id of ["title", "subtitle", "person", "personHelp", "apps", "appsHelp", "names", "addr"]) {
    $(id).textContent = "";
  }
  $("card").classList.add("hidden");
}

// Each lookup takes a number. One that finishes after a newer one has started
// writes nothing, so a slow answer can never paint someone else's card over the
// person actually asked about.
let lookupSeq = 0;

async function check() {
  const input = $("address").value.trim();
  const mine = ++lookupSeq;
  const stale = () => mine !== lookupSeq;
  resetCard();
  if (!input) return;

  $("check").disabled = true;
  $("check").textContent = "Looking up…";
  try {
    const identity = await resolveIdentity(input);
    if (stale()) return;
    const evm = identity.evm;
    const hasKey = identity.publicKey !== UNKNOWN && typeof identity.publicKey === "string";
    const publicKey = hasKey ? toPublicKeyBytes(identity.publicKey) : null;

    const [info, dotCount, feeSet, usernames, lp, alias] = await Promise.all([
      settle(personhoodStatus(evm, CONTEXT)),
      settle(dotNameCount(evm)),
      feeSetOnce(),
      hasKey ? settle(usernamesFor(publicKey)) : Promise.resolve([]),
      hasKey ? settle(litePeople(publicKey)) : Promise.resolve(null),
      hasKey ? settle(accountToAlias(publicKey)) : Promise.resolve(null),
    ]);
    const people = !hasKey
      ? identity.publicKey === UNKNOWN ? UNKNOWN : null
      : lp === UNKNOWN
        ? UNKNOWN
        : { registered: Boolean(lp), method: lp?.method ?? null, aliasBound: alias !== UNKNOWN && Boolean(alias) };

    // Names can only be confirmed one at a time: try the one typed, and the stem
    // of each username.
    const candidates = new Set();
    if (identity.dotLabel) candidates.add(identity.dotLabel.toLowerCase());
    if (Array.isArray(usernames)) for (const u of usernames) candidates.add(String(u).split(".")[0].toLowerCase());
    const confirmedNames = [];
    for (const label of candidates) {
      const owner = await settle(nameOwner(label));
      if (owner !== UNKNOWN && owner && owner.toLowerCase() === evm) confirmedNames.push(label);
    }

    if (stale()) return;
    const ss58 = hasKey ? publicKeyToSs58(publicKey) : null;
    const username = Array.isArray(usernames) ? usernames[0] : null;
    const title =
      username ?? (identity.dotLabel ? `${identity.dotLabel}.dot` : short(ss58 ?? evm));
    $("title").textContent = title;
    $("avatar").textContent = title.replace(/[^a-z0-9]/gi, "").charAt(0).toUpperCase() || "?";
    $("subtitle").textContent =
      identity.dotLabel
        ? username ? `Owner of ${identity.dotLabel}.dot` : "Found by .dot name"
        : identity.via.startsWith("the owner of")
          ? "Found by username"
          : "Found by address";

    const [personPill, personHelp] = personAnswer(identity, people);
    $("person").innerHTML = personPill;
    $("personHelp").textContent = personHelp;
    const [appsPill, appsHelp] = appsAnswer(info, people, feeSet);
    $("apps").innerHTML = appsPill;
    $("appsHelp").textContent = appsHelp;
    // Hidden while nobody on the devnet has an alias, since it would say "Not yet"
    // for everyone. It appears by itself once the count is above zero, or when this
    // account has one; no redeploy needed.
    $("appsRow").classList.toggle("hidden", !(aliasesBound > 0 || appsPill.includes("pill yes")));
    $("names").innerHTML = namesAnswer(dotCount, confirmedNames);

    const shown = ss58 ?? evm;
    $("addr").innerHTML =
      identity.publicKey === UNKNOWN && identity.mapped !== false
        ? pill("unknown", "Couldn't check")
        : `<span class="addr">${esc(short(shown))}</span><button class="copy" data-copy="${esc(shown)}">Copy</button>`;

    lastTier = info === UNKNOWN ? null : info.status;
    $("card").classList.remove("hidden");
  } catch (err) {
    if (stale()) return;
    // Reaching here with a network error means every endpoint failed. Otherwise
    // the message is about the input, and resolveIdentity wrote it in plain words.
    const offline = err instanceof TypeError || /fetch|network|reachable/i.test(err.message);
    $("error").textContent = offline
      ? "Couldn't reach the network. Try again in a moment."
      : /is not an address, not a registered username/.test(err.message)
        ? `No account, username or .dot name called "${input}".`
        : err.message;
    $("error").classList.remove("hidden");
  } finally {
    if (!stale()) {
      $("check").disabled = false;
      $("check").textContent = "Look up";
    }
  }
}

async function checkName() {
  // The rules contract rejects anything with a dot, so a trailing .dot is dropped.
  const label = $("label").value.trim().replace(/\.dot$/i, "");
  $("nameError").classList.add("hidden");
  $("nameResult").classList.add("hidden");
  if (!label) return;

  $("checkName").disabled = true;
  $("checkName").textContent = "Checking…";
  try {
    const [{ requires }, reservation, owner, price, feeSet] = await Promise.all([
      classifyName(label),
      baseNameReservation(label),
      nameOwner(label),
      namePrice(label).catch(() => null),
      feeSetOnce(),
    ]);
    const cost = price === null ? "" : price === 0 ? "Free." : `${fmt(price)} PAS.`;
    const until = reservation.expiry
      ? ` until ${new Date(reservation.expiry * 1000).toISOString().slice(0, 10)}`
      : "";

    let kind;
    let answer;
    let why;
    if (owner) {
      [kind, answer, why] = ["no", "Taken", `${label}.dot already belongs to someone.`];
    } else if (reservation.owner) {
      [kind, answer, why] = ["no", "Reserved", `Held for someone else${until}.`];
    } else if (requires === 3) {
      [kind, answer, why] = ["no", "Reserved", "Very short names are kept for Polkadot governance."];
    } else if (requires > 0 && feeSet === false) {
      // No tier above None can be proven while the alias fee is unset, so "needs
      // personhood" would send people after something nobody here can have.
      [kind, answer, why] = ["no", "Not yet", "Names this short need a verified person, and that can't be proven on this devnet yet. Names of 9 letters or more are open to everyone."];
    } else if (requires > 0) {
      const need = TIERS[requires]?.label ?? "verified";
      const mine = lastTier !== null && lastTier < requires
        ? " The account you looked up isn't there yet."
        : "";
      [kind, answer, why] = ["no", "Needs a verified person", `Names this short need ${need} proof of personhood. ${cost}${mine}`];
    } else {
      // Registering signs and pays, which this read-only app never does, so it
      // names the official app instead. Plain text: the host's link handling has
      // reported success while opening nothing (devnet issue #14).
      [kind, answer, why] = ["yes", "Available", `${cost} Open to everyone. Register it in the DotNS app (dotns.dot) inside the Polkadot app.`.trim()];
    }
    $("nameAnswer").className = `answer ${kind}`;
    $("nameAnswer").textContent = answer;
    $("nameWhy").textContent = why;
    $("nameResult").classList.remove("hidden");
  } catch (err) {
    $("nameError").textContent =
      err.message === "execution reverted"
        ? "Use letters and numbers only."
        : "Couldn't check that name right now. Try again in a moment.";
    $("nameError").classList.remove("hidden");
  } finally {
    $("checkName").disabled = false;
    $("checkName").textContent = "Check";
  }
}

// Live numbers, each read on its own: one failure shows "–" for that number only,
// never a zero.
async function loadStats() {
  const reads = [
    ["statPeople", countEntries("PeopleLite", "LitePeople")],
    ["statAliases", aliasCount().then((n) => {
      aliasesBound = n;
      $("statAliasesCard").classList.toggle("hidden", n === 0);
      return n;
    })],
  ];
  let failed = false;
  await Promise.all(
    reads.map(([id, p]) =>
      p.then(
        (n) => ($(id).textContent = fmt(n)),
        () => {
          $(id).textContent = "–";
          failed = true;
        },
      ),
    ),
  );
  if (failed) $("statsNote").textContent = "Some numbers couldn't be read just now.";
}

$("check").addEventListener("click", check);
$("checkName").addEventListener("click", checkName);
$("address").addEventListener("keydown", (e) => e.key === "Enter" && check());
$("label").addEventListener("keydown", (e) => e.key === "Enter" && checkName());
document.addEventListener("click", (e) => {
  const value = e.target?.dataset?.copy;
  if (!value) return;
  navigator.clipboard?.writeText(value).then(
    () => (e.target.textContent = "Copied"),
    () => (e.target.textContent = "Copy failed"),
  );
});
loadStats();
