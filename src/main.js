import {
  resolveAddress,
  personhoodStatus,
  classifyName,
  baseNameReservation,
  nameOwner,
  namePrice,
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
} from "./substrate.js";
import { publicKeyToSs58 } from "./chain.js";

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

async function check() {
  const input = $("address").value.trim();
  const context = $("context").value.trim() || "dotns";
  // Clear, not just hide — stale text in a hidden node is misleading to anyone
  // inspecting the page, and reads as a current error if it reappears.
  $("error").textContent = "";
  $("error").classList.add("hidden");
  $("verdict").innerHTML = "";
  $("result").classList.add("hidden");
  if (!input) return;

  $("check").disabled = true;
  $("check").textContent = "Checking…";
  try {
    contextWord(context);

    // Address first; anything unparseable gets a shot at being a username.
    let resolved;
    let matchedUsername = null;
    try {
      resolved = resolveAddress(input);
    } catch (addressError) {
      const hit = await resolveUsername(input);
      if (!hit) {
        throw /^0x/i.test(input)
          ? addressError
          : new Error(`No registered username matching "${input}", and it isn't a valid address.`);
      }
      matchedUsername = hit.username;
      resolved = resolveAddress(publicKeyToSs58(hit.publicKey));
    }
    const { evm, ss58 } = resolved;

    const [info, feeSet] = await Promise.all([
      personhoodStatus(evm, context),
      aliasFeeSet().catch(() => null),
    ]);

    // People-chain state needs the public key, so only for SS58 input.
    let people = null;
    let usernames = [];
    if (ss58) {
      const publicKey = ss58ToPublicKey(ss58);
      const [lp, alias, names] = await Promise.all([
        litePeople(publicKey).catch(() => null),
        accountToAlias(publicKey).catch(() => null),
        usernamesFor(publicKey).catch(() => []),
      ]);
      people = { registered: Boolean(lp), ringVrfKey: lp?.ringVrfKey ?? null, aliasBound: Boolean(alias) };
      usernames = names;
    }
    $("outUsername").textContent = usernames.length
      ? usernames.join(", ")
      : matchedUsername ?? (ss58 ? "none registered" : "— (EVM address given)");

    const tier = TIERS[info.status] ?? { key: "none", label: `Unknown (${info.status})`, blurb: "" };
    $("tier").className = `badge ${tier.key}`;
    $("tier").textContent = tier.label;
    $("tierBlurb").textContent = tier.blurb;
    $("outSs58").textContent = ss58 ?? "— (EVM address given)";
    $("outEvm").textContent = evm;
    $("outContext").textContent = `"${context}"  ·  0x${contextWord(context)}`;
    $("outAlias").textContent = info.aliasSet ? info.contextAlias : "not set (all zero)";

    $("peopleRows").classList.toggle("hidden", !people);
    if (people) {
      $("outRegistered").textContent = people.registered
        ? "yes — PeopleLite.LitePeople present"
        : "no record";
      $("outRing").textContent = people.ringVrfKey ?? "—";
      $("outAliasBound").textContent = people.aliasBound ? "yes" : "no — AccountToAlias empty";
    }

    lastTier = info.status;
    lastLabel = usernames[0] ?? matchedUsername ?? (ss58 ? `${ss58.slice(0, 8)}…` : `${evm.slice(0, 8)}…`);

    const { tone, lines } = explain(info, people, context, feeSet);
    $("verdict").className = `verdict ${tone}`;
    $("verdict").innerHTML = lines.map((l) => `<p>${l}</p>`).join("");
    $("result").classList.remove("hidden");
  } catch (err) {
    // A bare "Failed to fetch" tells the user nothing. This app leans on one
    // public eth-rpc endpoint, and there is no known alternative for the devnet.
    const offline = err instanceof TypeError || /fetch|network/i.test(err.message);
    $("error").textContent = offline
      ? "Couldn't reach the RPC endpoint. This app depends on a single public endpoint (paseo-assethub-rpc.laissez-faire.trade) — if it's down, nothing here will resolve."
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
