import {
  resolveAddress,
  personhoodStatus,
  classifyName,
  baseNameReservation,
  nameOwner,
  namePrice,
  dotNameCount,
  contextWord,
  ss58ToPublicKey,
  TIERS,
} from "./chain.js";
import {
  litePeople,
  accountToAlias,
  aliasFeeSet,
  resolveUsername,
  usernamesFor,
  accountIdForEvm,
} from "./substrate.js";
import { publicKeyToSs58, publicKeyToEvm } from "./chain.js";

const $ = (id) => document.getElementById(id);

/**
 * The verdict is built as HTML so it can carry <code> and links, which means
 * anything user-supplied inside it must be escaped. `context` is free text from
 * an input box, and without this a pasted `<img onerror=…>` executes.
 */
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

/**
 * Three-state results: a value, a definite "no" from the chain, or UNKNOWN.
 *
 * Collapsing the third into the second is the bug that made this app report a
 * registered person as unregistered when an endpoint stopped answering. Every
 * field in the identity card carries its own state, and `UNKNOWN` is rendered
 * as unknown — never as a negative, and never as an absence.
 */
const UNKNOWN = Symbol("unknown");

/** Run a lookup, turning a transport failure into UNKNOWN rather than a "no". */
const settle = (promise) => promise.then((v) => v, () => UNKNOWN);

/** Render one card field. `none` is the wording for a definite chain "no". */
function field(value, none) {
  if (value === UNKNOWN) {
    return `<span class="unknown">unknown — couldn't read the chain</span>`;
  }
  if (value === null || value === undefined || value === "" ||
      (Array.isArray(value) && !value.length)) {
    return `<span class="muted">${esc(none)}</span>`;
  }
  return esc(Array.isArray(value) ? value.join(", ") : String(value));
}

const ISSUE_3 =
  "https://github.com/Polkadot-Community-Foundation/polkadot-app-docs/issues/3";

// Remembered from the last account lookup so the name checker can say whether
// *that* account could actually claim the name, rather than leaving the user to
// compare two tiers by eye.
let lastTier = null;
let lastLabel = "that account";

/**
 * Turn two chains' worth of state into an explanation.
 *
 * The case that matters is "registered on the People chain but no alias bound":
 * the account IS a verified person, yet Asset Hub sees nothing, so every
 * contract rejects it. That's the NoPersonhood revert, and nothing in the
 * ecosystem currently tells you it's what's happening.
 */
/** Shown whenever a missing alias is the chain's fault rather than the user's. */
const CHAIN_BLOCKED = `<strong>Not your doing.</strong> <code>AliasAccounts.AliasFee</code> is unset chain-wide, so <code>set_alias_account</code> fails for everyone. Needs a governance call.`;

function explain({ status, aliasSet }, people, rawContext, feeSet) {
  // Everything below builds HTML, so escape once here rather than at each use.
  const context = esc(rawContext);
  const tier = esc(TIERS[status]?.label ?? status);

  // Asset Hub is satisfied — nothing else matters.
  if (status > 0 && aliasSet) {
    const lines = [
      `Verified person — tier <strong>${tier}</strong>, alias bound for <code>${context}</code>.`,
      `Checks in this context pass. Another context gives a different, unlinkable alias.`,
    ];
    if (status === 1) lines.push(`Lite — 6–8 character names need <strong>Full</strong>.`);
    return { tone: "ok", lines };
  }

  // Registered on the People chain, but Asset Hub can't see it.
  if (people?.registered) {
    const lines = [
      `<strong>Registered person</strong> on the People chain — ring-VRF key present.`,
      people.aliasBound
        ? `Alias bound there, but Asset Hub reports none for <code>${context}</code> — the ring root may not have propagated.`
        : `No alias bound, so Asset Hub sees nobody. This is the <code>NoPersonhood</code> revert (<a href="${ISSUE_3}" target="_blank" rel="noopener">app-docs#3</a>).`,
    ];
    if (feeSet === false) lines.push(CHAIN_BLOCKED);
    return { tone: "warn", lines };
  }

  // Distinct from "no record": we never got an answer, so we cannot say either way.
  if (people?.unreachable) {
    return {
      tone: "warn",
      lines: [
        `No personhood on Asset Hub for <code>${context}</code>.`,
        `The People chain could not be read, so whether this account is a <strong>registered person</strong> there is unknown — not "no".`,
      ],
    };
  }

  if (people === null) {
    return {
      tone: "warn",
      lines: [
        `No personhood on Asset Hub for <code>${context}</code>.`,
        `Use an SS58 address to also check the People chain, where registration lives.`,
      ],
    };
  }

  return {
    tone: "warn",
    lines: [
      `No record on <strong>either</strong> chain.`,
      `Personhood binds to the account that owns the username — not a product or CLI account. Find it with <code>Resources.UsernameOwnerOf</code>.`,
    ],
  };
}

/**
 * Work out which account the input names, from any of the four identifiers a
 * person has here: an SS58 address, an EVM address, a `.01` username, or a
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

/**
 * Render the identity card: every identifier this account is known by.
 *
 * `.dot` names can only be *confirmed*, never listed — the registrar is ERC-721
 * but not enumerable, so `balanceOf` gives a count and nothing gives the names.
 * Saying "owns 2, one of which is X" is the honest shape; claiming a complete
 * list would not be.
 */
function renderCard({ identity, usernames, dotCount, confirmedNames, context }) {
  const mapped = identity.mapped;
  const ss58 =
    identity.publicKey === UNKNOWN
      ? UNKNOWN
      : identity.publicKey
        ? publicKeyToSs58(toPublicKeyBytes(identity.publicKey))
        : null;

  // An address the chain has never mapped is a definite answer, not a gap — but
  // it is also not an account, so nothing account-shaped may be shown for it.
  const ss58Cell =
    mapped === UNKNOWN
      ? field(UNKNOWN)
      : mapped === false
        ? `<span class="muted">not mapped — this EVM address has no account on chain</span>`
        : field(ss58, "—");

  const namesCell =
    dotCount === UNKNOWN
      ? field(UNKNOWN)
      : dotCount === 0
        ? `<span class="muted">none owned</span>`
        : `${esc(String(dotCount))} owned${
            confirmedNames.length
              ? ` · ${confirmedNames.map((n) => esc(n) + ".dot").join(", ")}`
              : ""
          }${
            confirmedNames.length < dotCount
              ? ` <span class="muted">(the registrar is not enumerable — the rest cannot be listed)</span>`
              : ""
          }`;

  $("cardVia").textContent = `matched by ${identity.via}`;
  // With no account there is nothing that could hold a username, so "none
  // registered" would be a claim about something that does not exist.
  $("cardUsername").innerHTML =
    mapped === false
      ? `<span class="muted">no account, so none</span>`
      : field(usernames, "none registered");
  $("cardSs58").innerHTML = ss58Cell;
  $("cardEvm").innerHTML = field(identity.evm, "—");
  $("cardNames").innerHTML = namesCell;
  $("card").classList.remove("hidden");
  return { ss58, mappedKnown: mapped !== UNKNOWN && mapped !== false };
}

async function check() {
  const input = $("address").value.trim();
  const context = $("context").value.trim() || "dotns";
  // Clear, not just hide — stale text in a hidden node is misleading to anyone
  // inspecting the page, and reads as a current error if it reappears.
  $("error").textContent = "";
  $("error").classList.add("hidden");
  $("verdict").innerHTML = "";
  $("result").classList.add("hidden");
  // Hiding is not enough — the panel keeps the previous person's identifiers,
  // which is the same trap as the stale error text above, and worse here: the
  // next lookup that fails would leave someone else's address on screen.
  $("card").classList.add("hidden");
  for (const id of ["cardVia", "cardUsername", "cardSs58", "cardEvm", "cardNames"]) {
    $(id).textContent = "";
  }
  if (!input) return;

  $("check").disabled = true;
  $("check").textContent = "Checking…";
  try {
    contextWord(context);

    const identity = await resolveIdentity(input);
    const evm = identity.evm;
    const havePublicKey =
      identity.publicKey !== UNKNOWN && typeof identity.publicKey === "string";

    const [info, feeSet, dotCount] = await Promise.all([
      personhoodStatus(evm, context),
      aliasFeeSet().catch(() => null),
      settle(dotNameCount(evm)),
    ]);

    // People-chain state needs the public key, so only when we actually have an
    // account — an unmapped EVM address has none, and an unreadable chain has
    // not told us either way.
    let people = null;
    let usernames = [];
    let publicKey = null;
    if (havePublicKey) {
      publicKey = toPublicKeyBytes(identity.publicKey);
    }

    const cardUsernames = havePublicKey
      ? await settle(usernamesFor(publicKey))
      : identity.mapped === UNKNOWN
        ? UNKNOWN
        : [];

    // Names can only be confirmed one at a time, so try the ones we have reason
    // to suspect: the name typed, and the stem of each username.
    const candidates = new Set();
    if (identity.dotLabel) candidates.add(identity.dotLabel.toLowerCase());
    if (Array.isArray(cardUsernames)) {
      for (const u of cardUsernames) candidates.add(String(u).split(".")[0].toLowerCase());
    }
    const confirmedNames = [];
    for (const label of candidates) {
      const owner = await settle(nameOwner(label));
      if (owner !== UNKNOWN && owner && owner.toLowerCase() === evm) confirmedNames.push(label);
    }

    const { ss58 } = renderCard({
      identity,
      usernames: cardUsernames,
      dotCount,
      confirmedNames,
      context,
    });

    const matchedUsername = Array.isArray(cardUsernames) ? (cardUsernames[0] ?? null) : null;

    if (havePublicKey) {
      // `unreachable` matters as much as the data. Swallowing a transport error
      // into null renders a registered person as "no record" — which is the one
      // wrong answer this app must never give.
      const FAILED = Symbol("unreachable");
      const [lp, alias] = await Promise.all([
        litePeople(publicKey).catch(() => FAILED),
        accountToAlias(publicKey).catch(() => FAILED),
      ]);
      const unreachable = lp === FAILED;
      people = {
        unreachable,
        registered: !unreachable && Boolean(lp),
        ringVrfKey: (lp === FAILED ? null : lp?.ringVrfKey) ?? null,
        aliasBound: alias !== FAILED && Boolean(alias),
      };
      usernames = Array.isArray(cardUsernames) ? cardUsernames : [];
    }
    $("outUsername").textContent = usernames.length
      ? usernames.join(", ")
      : matchedUsername ?? (ss58 ? "none registered" : "— (EVM address given)");

    const tier = TIERS[info.status] ?? { key: "none", label: `Unknown (${info.status})`, blurb: "" };
    $("tier").className = `badge ${tier.key}`;
    $("tier").textContent = tier.label;
    $("tierBlurb").textContent = tier.blurb;
    const ss58Text =
      ss58 === UNKNOWN
        ? "unknown — couldn't read the chain"
        : (ss58 ?? (identity.mapped === false ? "not mapped" : "— (EVM address given)"));
    $("outSs58").textContent = ss58Text;
    $("outEvm").textContent = evm;
    $("outContext").textContent = `"${context}"  ·  0x${contextWord(context)}`;
    $("outAlias").textContent = info.aliasSet ? info.contextAlias : "not set (all zero)";

    $("peopleRows").classList.toggle("hidden", !people);
    $("peopleNote").classList.toggle("hidden", Boolean(people));
    if (!people) {
      $("peopleNote").textContent =
        identity.mapped === false
          ? "No account on chain for this EVM address, so there is nothing on the People chain to look up."
          : identity.mapped === UNKNOWN
            ? "Could not resolve this EVM address to an account, so People-chain state is unknown — not absent."
            : "Give an SS58 address, a username or a .dot name to also check the People chain.";
    }
    if (people) {
      $("outRegistered").textContent = people.unreachable
        ? "couldn't read — People chain unreachable"
        : people.registered
          ? "yes — PeopleLite.LitePeople present"
          : "no record";
      $("outRing").textContent = people.ringVrfKey ?? "—";
      $("outAliasBound").textContent = people.unreachable
        ? "unknown"
        : people.aliasBound
          ? "yes"
          : "no — AccountToAlias empty";
    }

    lastTier = info.status;
    lastLabel =
      usernames[0] ??
      matchedUsername ??
      (typeof ss58 === "string" ? `${ss58.slice(0, 8)}…` : `${evm.slice(0, 8)}…`);

    const { tone, lines } = explain(info, people, context, feeSet);
    $("verdict").className = `verdict ${tone}`;
    $("verdict").innerHTML = lines.map((l) => `<p>${l}</p>`).join("");
    $("result").classList.remove("hidden");
  } catch (err) {
    // A bare "Failed to fetch" tells the user nothing. chain.js now tries every
    // known devnet endpoint before giving up, so reaching here means they are
    // all unreachable — say that, rather than naming one host as the culprit.
    const offline = err instanceof TypeError || /fetch|network|reachable/i.test(err.message);
    $("error").textContent = offline
      ? "Couldn't reach any devnet RPC endpoint. This app reads public endpoints directly; if they are all down or blocked, nothing here will resolve."
      : err.message;
    $("error").classList.remove("hidden");
  } finally {
    $("check").disabled = false;
    $("check").textContent = "Check";
  }
}

async function checkName() {
  // PopRules reverts on anything containing a dot, so strip a trailing .dot
  // rather than making the user care about that.
  const label = $("label").value.trim().replace(/\.dot$/i, "");
  $("nameError").textContent = "";
  $("nameError").classList.add("hidden");
  $("nameResult").classList.add("hidden");
  if (!label) return;

  $("checkName").disabled = true;
  $("checkName").textContent = "Checking…";
  try {
    const [{ requires, message }, reservation, owner, price] = await Promise.all([
      classifyName(label),
      baseNameReservation(label),
      nameOwner(label),
      namePrice(label).catch(() => null),
    ]);

    // "Requires" is a pure function of the label's length and says nothing about
    // ownership. The contract's own message says "Available to all", which reads
    // as a contradiction beside "taken" — so translate it instead of passing it
    // through.
    const REQUIREMENT = {
      0: "any account may register a name this length",
      1: "Lite personhood",
      2: "Full personhood",
      3: "governance only",
    };
    $("nameStatus").textContent = owner ? `registered — ${owner}` : "unregistered";
    $("nameRequires").textContent = `${TIERS[requires]?.label ?? requires} — ${REQUIREMENT[requires] ?? message}`;
    $("namePrice").textContent = price === null ? "—" : `${price} PAS`;
    $("nameReservation").textContent = reservation.owner
      ? `${reservation.owner}${reservation.expiry ? ` until ${new Date(reservation.expiry * 1000).toISOString().slice(0, 10)}` : ""}`
      : "nobody";

    // Only bring the account into it when it's the reason the name can't be had.
    // Otherwise the mention is noise about something the user didn't ask about.
    const cost = price ? ` for ${price} PAS` : "";
    let tone = "ok";
    let verdict;
    if (owner) {
      tone = "warn";
      verdict = `Already registered.`;
    } else if (requires === 3) {
      tone = "warn";
      verdict = `Governance-reserved — labels of 5 characters or fewer aren't open.`;
    } else if (requires > 0 && lastTier !== null && requires > lastTier) {
      tone = "warn";
      verdict = `Needs <strong>${esc(TIERS[requires].label)}</strong> personhood — the account you checked above has <strong>${esc(TIERS[lastTier].label)}</strong>.`;
    } else if (requires > 0) {
      verdict = `Available${cost}, with <strong>${esc(TIERS[requires].label)}</strong> personhood.`;
    } else {
      verdict = `Available${cost}.`;
    }
    $("nameVerdict").className = `verdict ${tone}`;
    $("nameVerdict").innerHTML = `<p>${verdict}</p>`;
    $("nameResult").classList.remove("hidden");
  } catch (err) {
    $("nameError").textContent =
      err.message === "execution reverted"
        ? "PopRules rejected that label — it takes a bare name, letters and digits only."
        : err.message;
    $("nameError").classList.remove("hidden");
  } finally {
    $("checkName").disabled = false;
    $("checkName").textContent = "Check name";
  }
}

$("check").addEventListener("click", check);
$("checkName").addEventListener("click", checkName);
$("address").addEventListener("keydown", (e) => e.key === "Enter" && check());
$("context").addEventListener("keydown", (e) => e.key === "Enter" && check());
$("label").addEventListener("keydown", (e) => e.key === "Enter" && checkName());
