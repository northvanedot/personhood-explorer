/**
 * Product manifest. `pad` finds this by walking up from the build dir and writes
 * two on-chain records on deploy:
 *
 *   manifest    → whoisaperson.dot       displayName, description, icon CID
 *   executable  → app.whoisaperson.dot   kind + appVersion (subname auto-registered)
 *
 * These are what dotmetrics counts as "published". Unrelated to
 * `Publisher.publish` / the Browse registry, which reverts NoPersonhood.
 * Budget is 1024 bytes per text record.
 *
 * Deliberately plain — no `defineConfig` import. That helper is only for editor
 * IntelliSense, and its own docs cite `@parity/polkadot-app-deploy` while the
 * installed package is `@polkadot-community-foundation/...`. Not worth the
 * resolution risk for a type hint.
 */
export default {
  domain: "whoisaperson.dot",
  displayName: "Personhood Explorer",
  description:
    "Look up proof-of-personhood state for any account. Shows registration on the People chain, the contextual alias, and whether a .dot name is claimable. Read-only.",
  icon: {
    path: "icon.png",
    format: "png",
  },
  executables: [
    {
      kind: "app",
      path: "dist",
      appVersion: [1, 0, 0],
    },
  ],
};
