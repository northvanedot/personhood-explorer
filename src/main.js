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
  litePeopleTally,
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

/**
 * What a result actually establishes — and what it does not.
 *
 * A personhood result is routinely read as stronger than it is, so each state
 * gets a claim of its own. Every line below is from the pallet source
 * (`people-lite`, `alias-accounts`) or the precompile, not from the tier name.
 *
 * The long form is in the README; these are the one-liners.
 */
/** Registration on the People chain. `method` decides what was actually checked. */
function establishesRegistration(method) {
  if (method?.kind === "fee") {
    return `Registered by <strong>paying the fee</strong> — <code>register_with_fee</code>. The chain checked that this ring-VRF key is unused and that the caller owns it. <strong>Nothing about a person was checked at all</strong>, so this establishes a paid registration, not a human.`;
  }
  if (method?.kind === "device") {
    return `An attester authorised by governance vouched for a unique device, and the chain checked that this ring-VRF key is unused in the collection. <strong>The chain verified signatures, not a person</strong> — that one human holds one record is the attester's claim, not something proved here.`;
  }
  return `Registered, but by a method this app does not recognise, so <strong>we can't tell you what it establishes</strong>.`;
}

/**
 * The tier the precompile reports.
 *
 * Status is read off an *alias* record, not off registration — `personhood_info`
 * returns nothing when the account has no alias in the context, and the tier is
 * then derived from which collection that alias belongs to. With the alias fee
 * unset no alias can be bound, so on this devnet **every** tier above None is
 * unreachable, not just Full.
 */
function establishesTier(status, feeSet) {
  if (status === 0) {
    return feeSet === false
      ? `The tier comes from an <em>alias</em>, not from registration, and nobody can bind one on this devnet (below) — <strong>None is the only tier anyone can have here</strong>. It does not mean this account was rejected.`
      : `No alias bound in this context, so the precompile reports None. That is a statement about this account in this context, <strong>not about the person</strong>.`;
  }
  if (status === 1) {
    return `Lite — the alias belongs to the People Lite collection. That inherits whatever the lite registration checked, which may be only a paid fee. See the People-chain row for which.`;
  }
  if (status === 2) {
    return `Full — the alias belongs to the People collection, the tier backed by proof-of-ink rather than a device attestation.`;
  }
  return `Tier ${esc(String(status))} is not one this app knows, so <strong>we can't tell you what it establishes</strong>.`;
}

/**
 * What a bound alias would mean. Marked as unverified on purpose: no alias can
 * exist on this devnet, so none of it has been observed here.
 */
const ESTABLISHES_ALIAS =
  `Per the pallet docs, an alias is <strong>the same person across sessions within one context</strong>, and a different context yields a different alias that cannot be linked to it. <strong>Unverified here</strong> — no alias can be bound on this devnet, so this app has never seen one. Note also that <code>AccountToAlias</code> holds one alias per account and is public, so an account that binds one is publicly tied to it.`;

// The alias fee is chain-wide state, not per-account, so one read serves every
// lookup in the session — and it is what lets the name checker say that a gated
// name is unclaimable rather than merely gated.
let aliasFeePromise = null;
const aliasFeeSetOnce = () => (aliasFeePromise ??= aliasFeeSet().catch(() => null));

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
const CHAIN_BLOCKED = `<strong>Not your doing.</strong> The alias fee — a root-only runtime parameter, <code>AliasFee</code> — is unset chain-wide, so <code>set_alias_account</code> fails for everyone. Needs a root-origin call to open.`;

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
      people.aliasBound
        ? `Alias bound there, but Asset Hub reports none for <code>${context}</code> — the ring root may not have propagated.`
        : `No alias bound, so Asset Hub sees nobody — the state behind a <code>NoPersonhood</code> revert.`,
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
      `That is a fact about <em>this account</em>. It does <strong>not</strong> establish that the person behind it has no personhood — personhood binds to the account that owns the username, not to a product or CLI account. Find that one with <code>Resources.UsernameOwnerOf</code>.`,
    ],
  };
}

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
      aliasFeeSetOnce(),
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
        method: lp === FAILED ? null : (lp?.method ?? null),
        aliasBound: alias !== FAILED && Boolean(alias),
      };
      usernames = Array.isArray(cardUsernames) ? cardUsernames : [];
    }
    const tier = TIERS[info.status] ?? { key: "none", label: `Unknown (${info.status})`, blurb: "" };
    $("tier").className = `badge ${tier.key}`;
    $("tier").textContent = tier.label;
    $("tierBlurb").textContent = tier.blurb;
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
      $("outMethod").textContent = people.unreachable
        ? "unknown"
        : people.method?.kind === "device"
          ? "attested — unique device"
          : people.method?.kind === "fee"
            ? "fee paid — no uniqueness check"
            : people.registered
              ? "unrecognised"
              : "—";
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

    // Claims are built as HTML but contain no user input — `context` is the only
    // free text that reaches them and it is escaped at the top of explain().
    $("tierEstablishes").innerHTML = establishesTier(info.status, feeSet);
    $("peopleEstablishes").innerHTML =
      people && !people.unreachable && people.registered
        ? establishesRegistration(people.method)
        : "";
    $("peopleEstablishes").classList.toggle(
      "hidden",
      !(people && !people.unreachable && people.registered),
    );
    $("aliasEstablishes").innerHTML = info.aliasSet ? ESTABLISHES_ALIAS : "";
    $("aliasEstablishes").classList.toggle("hidden", !info.aliasSet);

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
    const [{ requires, message }, reservation, owner, price, feeSet] = await Promise.all([
      classifyName(label),
      baseNameReservation(label),
      nameOwner(label),
      namePrice(label).catch(() => null),
      aliasFeeSetOnce(),
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
    // The v1 PopRules returned 0 for every label not open to all; the v3 one in use
    // since 2026-10-05 returns 10 PAS for 6–8 character labels too. The 0 branches
    // stay so a zero still reads as the contract's point — the barrier is
    // personhood or governance, not money — rather than as a broken field.
    $("namePrice").textContent =
      price === null
        ? "—"
        : price === 0 && requires === 3
          ? "0 PAS — the barrier here is governance, not money"
          : price === 0 && requires > 0
            ? "0 PAS — the barrier here is personhood, not money"
            : `${price} PAS`;
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
    } else if (requires > 0 && feeSet === false) {
      // The gate is a personhood tier, and no tier above None is reachable while
      // the alias fee is unset. Saying only "needs personhood" sends people off to
      // earn something nobody on this chain can have.
      tone = "warn";
      verdict =
        `<strong>Nobody can claim this name on this devnet.</strong> It needs ` +
        `<strong>${esc(TIERS[requires].label)}</strong> personhood, and personhood is read from a ` +
        `contextual alias that no account can bind — the alias fee is unset ` +
        `chain-wide. Not a gate you can pass: it needs a root-origin call to open. ` +
        `<strong>9 characters or more has no personhood requirement.</strong>`;
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

// Counted live, and only when someone opens the section: a hard-coded figure went
// stale twice, and a full read is half a dozen requests nobody else should pay for.
// A failed read says unknown — the app never shows a guess as a count.
let litePeopleCounted = false;
$("registrationDetails").addEventListener("toggle", async () => {
  if (!$("registrationDetails").open || litePeopleCounted) return;
  litePeopleCounted = true;
  const out = $("litePeopleCount");
  try {
    const { total, device, fee, other } = await litePeopleTally();
    const n = (x) => `<strong>${esc(x.toLocaleString("en-US"))}</strong>`;
    // The unrecognised count goes last, as its own sentence, so it cannot be read as
    // the subject of the clause about Fee.
    const odd = !other ? "" : other === 1 ? " One more carries a method this app does not recognise." : ` ${n(other)} more carry a method this app does not recognise.`;
    const all = other ? `${n(device)} of the ${n(total)}` : `All ${n(total)}`;
    out.innerHTML =
      (fee === 0
        ? `${all} lite people on this devnet, counted just now, were registered by <code>UniqueDevice</code> and none by <code>Fee</code>, so the fee path is live code with no instances here.`
        : `Of ${n(total)} lite people on this devnet, counted just now, ${n(device)} were registered by <code>UniqueDevice</code> and ${n(fee)} by <code>Fee</code> — for those ${n(fee)}, the chain asserts nothing about uniqueness.`) + odd;
  } catch {
    litePeopleCounted = false;
    out.textContent = "The People chain could not be read just now, so the count is unknown — not zero. Close and reopen this section to try again.";
  }
});

$("check").addEventListener("click", check);
$("checkName").addEventListener("click", checkName);
$("address").addEventListener("keydown", (e) => e.key === "Enter" && check());
$("context").addEventListener("keydown", (e) => e.key === "Enter" && check());
$("label").addEventListener("keydown", (e) => e.key === "Enter" && checkName());
