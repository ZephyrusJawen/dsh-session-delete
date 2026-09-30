# dsh-session-delete

Delete a [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) session from the sidebar.

English | [中文](README.zh.md)

## Why this exists

The Harness persists one append-only log per session and deliberately ships no
way to remove one. Its own packages say so:

- `@deepseek-ai/dsh-session-persistence-jsonl`: "Nothing deletes session files —
  logs accumulate under `root` until removed externally; the seam has no
  deletion API."
- `@deepseek-ai/dsh-workspace`: session deletion and folder removal are
  "separate, absent capabilities".
- `@deepseek-ai/dsh-acp`: persistence supports listing, resuming, and closing
  sessions, but not deletion.

This bundle adds that capability through the ordinary plugin surface, with no
patches to the application itself.

## What it adds

- **A host method** — the `sessionDelete` Remote namespace with a single
  `deleteSession({ sessionId })` that removes the session's stored log
  directory.
- **A sidebar entry** — a red **Delete session** item at the bottom of a session
  row's `...` menu, after Archive. Selecting it opens a confirmation dialog that
  names the session and warns that the action cannot be undone.

After a successful delete the page re-pulls the host's session list, so the row
disappears immediately. When the deleted session was the one on screen, the view
moves to a fresh session in the same workspace.

## Requirements

- DeepSeek Harness desktop or `dsh web` on the **0.2.x** line (tested against
  `0.2.0-rc.2`). The package declares `@deepseek-ai/dsh: ^0.2.0-rc.2` as a peer,
  so a mismatched runtime is flagged instead of failing silently. This plugin
  reaches into runtime internals (the session-log layout, the
  `workspace/session-activity` waterfall), so a distant release may need a
  change here.
- No build step and no host packages to resolve: the host half imports only Node
  built-ins, and the browser half is plain JS in the module-row format the
  client module system serves.

## Install

Quit the application first — the desktop profile is rewritten while it runs.

```sh
# from a local checkout
dsh plugin --profile desktop add /path/to/dsh-session-delete

# from a packed tarball
dsh plugin --profile desktop add ./dsh-session-delete-0.1.0.tgz

# straight from GitHub, over HTTPS (this package ships its built output, so nothing builds)
dsh plugin --profile desktop add https://github.com/<you>/dsh-session-delete.git
```

Use that explicit HTTPS URL rather than the `github:<you>/<repo>` shorthand: the
shorthand resolves to an **SSH** URL (`git+ssh://git@github.com/...`), so it
needs a known SSH host key and a registered SSH key, and it fails with
`Host key verification failed` on a machine without them. HTTPS needs neither
for a public repository, and for a private one the credential manager simply
prompts for a sign-in.

Then start the application again. Use `--profile <name>` for a profile other
than the desktop one.

The command links the package into the profile, appends it to
`dsh.profile.bundles`, and takes effect on the next launch.

### Uninstall

```sh
dsh plugin --profile desktop remove dsh-session-delete
```

## Usage

1. Open a session row's `...` menu (right-click the row on Windows) and pick
   **Delete session**.
2. Confirm in the dialog.
3. The row disappears and the log directory is gone from
   `$DSH_HOME/sessions/<project>/<session-id>/`.

## Refusals and safety

- **Running work is refused.** The method asks the composed
  `workspace/session-activity` waterfall — the same check Archive uses — and
  refuses while a turn, job, subagent, or schedule still runs, because a live
  writer would recreate the log it is about to lose. Stop the work first; the
  dialog reports this in the user's language.
- **Only the session's own directory is touched.** The location comes from the
  persistence backend's `locate()`, and it is then verified: the directory name
  must encode exactly this session id and the file inside must be a canonical
  `session.v<n>.jsonl.zstd` generation. Anything else is refused rather than
  deleted.
- **A session with no stored log is reported, not deleted.** A brand-new session
  that was never flushed has no artifact; deleting it would be a no-op and the
  host would recreate it on the next flush, so the dialog says there is nothing
  to delete.
- **Derived state self-heals.** The durable workspace table and any search index
  may keep an id for a while; both already tolerate externally removed session
  files (`session-query` reconciles on its next observation, and the sidebar
  filters unknown ids), so nothing else is rewritten.

## How it works

| Piece | Mechanism |
|---|---|
| Host endpoint | A service published with `ctx.provide` carrying the versioned prototype marker plus the visible `typertRemote` binding — exactly what the Gateway's source-mode discovery reads when a plugin ships no generated descriptor. |
| Browser entry | `ctx.slots.inject("sidebar.workspaces.session.menu.item")` plus a `shell.overlay` entry, built from the shared UI primitives (`MenuItemButton`, `Modal`, `Button`). |
| Two fibers | `ctx.remote.sessionDelete` is a nested Cordis service key, which Cordis only lets a Context read when that Context declares it in `inject` — and the service does not exist until this plugin publishes it. `apply` mounts the namespace; the row entry and dialog live in a child fiber that injects it, so Cordis parks that fiber until the endpoint is live and the menu entry can never appear without one. |
| Deletion | `sessionPersistence.list()` finds the stored session, `locate()` resolves its path, a guard proves the path belongs to that id, then the session directory is removed. |

## Known limitations

- The delete is permanent and immediate; there is no recycle bin.
- Attachments and other shared artifacts are intentionally left alone
  (`dsh-attachment` states that stored attachments are never deleted
  automatically and may be shared by resumed or forked sessions).
- Deleting the session you are viewing is allowed; the view moves to a fresh
  session in the same workspace rather than showing the deleted conversation.
- Desktop recovery ("disable all plugins") backs up `cordis.patch.yml` and
  resets `dsh.profile.bundles`; re-run the install command if that happens.

## Development

```
lib/index.js        host half: the Remote method and its guards
lib/client.js       browser half: the row entry, the dialog, the Remote call
cordis.patch.yml    the bundle layer: one host row
test/               four standalone scripts, no test framework
```

```sh
pnpm install   # only the two packages the Cordis tests import
pnpm test
```

| Test | Covers |
|---|---|
| `host-logic.test.mjs` | deletion on a real filesystem, the activity refusal, unknown and unmaterialized sessions, the foreign-directory guard, malformed payloads |
| `client-wiring.test.mjs` | module-row contract, slot registrations, descriptor shape, delete → refresh → navigate, failure wording |
| `cordis-registration.test.mjs` | the host plugin in a real Cordis tree, the protocol marker, disposal |
| `cordis-client-fibers.test.mjs` | the browser half in a real Cordis tree, including the nested-key rule that shapes the two-fiber split |

The last two skip themselves when their packages are missing.

## License

[MIT](LICENSE)
