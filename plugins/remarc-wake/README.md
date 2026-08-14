# Remarc Wake for OMP

`remarc-wake` is the optional live-delivery extension for using
[Remarc](https://remarc.app) with OMP. It pairs one OMP conversation with one
existing Remarc session and queues explicitly sent comments into that OMP
conversation as next-turn context.

The core `remarc` plugin remains responsible for the MCP tools and workflow
skill. Install both packages if OMP should receive and address comments; omit
`remarc-wake` if on-demand MCP access is enough.

## Compatibility

- `remarc-wake` **0.12.0**
- OMP **17.3.4** (the exact supported and tested baseline)
- macOS with Remarc 1.1.0 or later installed and launched at least once
- Node.js available to the OMP process

Other OMP versions may work, but are not the release compatibility baseline.

## Install

Add the Remarc marketplace, then install the core plugin and this optional
extension for the current user:

```sh
omp plugin marketplace add metedata/remarc-agent-plugins
omp plugin install --scope user remarc@remarc
omp plugin install --scope user remarc-wake@remarc
```

Use `--scope project` from a project directory instead for a project-only
installation. Restart OMP after installing or upgrading `remarc-wake`; an
extension added to an already-running process is not active until restart.

## Pair and unpair

1. Create a Remarc session with the core OMP integration, or select an existing
   session in the Remarc app.
2. Make that session active in Remarc.
3. In the OMP conversation that should receive its comments, run:

   ```text
   /remarc-pair
   ```

4. In Remarc, enable **Allow comments to wake paired agent sessions**.
5. Use **Send instantly & save** on a comment when it should wake the paired
   OMP conversation.

`/remarc-pair` does not create a Remarc session and does not choose by name. It
binds the current OMP session ID to the existing, non-deleted
`activeSessionID` in Remarc. If another live OMP process already owns that
Remarc session, pairing fails without replacing either owner.

To stop delivery and remove only this extension instance's owned lease, run:

```text
/remarc-unpair
```

Unpairing does not delete Remarc sessions, comments, or attachments.

## Delivery and recovery model

Pairing publishes a version 1 OMP lease with:

- `harness: "omp"`, the OMP process ID, and a random owner token containing at
  least 128 bits;
- a managed heartbeat refreshed every 10 seconds;
- token compare-and-set updates and cleanup, so an older process cannot modify
  or remove a replacement owner's lease;
- one live OMP owner per Remarc session.

Wake delivery uses a durable retry outbox. Before OMP is asked to queue a
`nextTurn`, the extension records the exact comment ID and
`wakeRequestedAt` generation in `pendingWake`. A successful `sendMessage`
return is not treated as a receipt. The pending entry is cleared only after a
later Remarc snapshot proves the correlated comment was deleted or left
`handedOff`; resuming the paired session replays still-pending generations from
current Remarc data. OMP provides no enqueue receipt, so this is an
at-least-once *attempt* model under resume, not a promise of exactly-once model
execution. Consumers should claim handed-off work with the core MCP status
compare-and-set before acting because delivery attempts can repeat.

OMP-managed timers drive the heartbeat and a 15-second safety poll. File
watching provides the fast path, while `turn_end` and `agent_end` trigger
additional reconciliation. Normal shutdown stops those resources immediately
and performs one bounded, token-owned marker cleanup.

## Local data and security

The extension runs locally with the current macOS user's permissions. It reads:

- `~/Library/Application Support/Remarc/comments.json`
- the legacy `data.json` fallback when present

Its lease/outbox marker is stored below:

```text
~/Library/Application Support/Remarc/claude/markers/
```

The package has no Remarc telemetry or Remarc-operated network service. Wake
payloads are processed by the model provider configured in OMP. Comment text,
session names, and captured application/page content are untrusted user data;
the payload keeps them in bounded randomized data sentinels, and full context
continues to flow through the core MCP tools.

## Update, disable, or remove

```sh
omp plugin marketplace update remarc
omp plugin upgrade --scope user remarc-wake@remarc
omp plugin disable --scope user remarc-wake@remarc
omp plugin enable --scope user remarc-wake@remarc
omp plugin uninstall --scope user remarc-wake@remarc
```

Use the matching `--scope project` commands for a project-scoped installation.
Uninstalling changes OMP's plugin state only; it does not remove Remarc data.
Remove the marketplace itself only after uninstalling every Remarc package:

```sh
omp plugin marketplace remove remarc
```

## Development

From this directory:

```sh
npm ci
npm run typecheck
npm test
npm run build
```

`npm run build` creates the self-contained ESM extension at `dist/index.js`,
the path declared by `package.json#omp.extensions`. Release verification
rebuilds it and compares the result with the committed bundle so the installed
artifact remains source-consistent.
