# Paseo stable 0.7.0 / Wave-10 deployment receipt

Date: 2026-08-31 (EDT)

This receipt records the stable Paseo cutover and the live acceptance performed
after the cutover. Product traffic and product URLs in this receipt use the
private Tailscale network only.

## Source truth

- Repository: `getpaseo/paseo` fork checkout at
  `/home/nayte/ANVIL-worker/paseo-dell-production-stabilization-v1`
- Branch: `paseo/dell-production-stabilization-v1`
- Stable release tag: `v0.7.0`, source commit
  `c56638ea8c2852d722a87e700abf3c966ded617e`
- Wave-10 merge used for the cutover: `d9044733ffdb023cb856a952c64b35f318cebfe8`
- The branch was pushed non-force to `fork/paseo/dell-production-stabilization-v1`.
- The merge preserved the Wave-10 ACP stream/update, question-form, and DOM
  combobox-anchor changes. The generated server distribution contains the
  `agent_thought_chunk` and `agent_message_chunk` adapters used by the live
  relay.

## Stable release verification

The official `v0.7.0` release was published on 2026-08-31 and is the source of
the merged release baseline. Its release notes include steady-rate assistant
streaming and ACP fixes. The registry resolved `@getpaseo/cli` version
`0.7.0`, with exact `0.7.0` dependencies for client, protocol, and server.

The pre-upgrade installed CLI was `0.7.0-beta.2`. The old package remains on
disk and is reachable through the rollback symlink:

```
/home/nayte/.local/bin/paseo-pre-stable-20260831-0.7.0-beta.2
```

The active deployment is the Wave-10 merged build:

```
/home/nayte/.local/bin/paseo
 -> /home/nayte/.local/lib/paseo-stable-0.7.0-wave10-d9044733/bin/paseo
```

Identity checks at cutover:

| Item                             | Identity                                                           |
| -------------------------------- | ------------------------------------------------------------------ |
| CLI version                      | `0.7.0`                                                            |
| CLI package                      | `@getpaseo/cli@0.7.0`                                              |
| Server package                   | `@getpaseo/server@0.7.0`                                           |
| CLI dist entry SHA-256           | `562b20edbb7a49c5c402a71c6ed5b046deefe343ee3d6d74a74478b1fac90d7c` |
| Server supervisor entry SHA-256  | `40d5c75545974a8ab7f20f9e394b324d63849b05324d938185ff59d78d52e75c` |
| CLI package tarball SHA-256      | `7b1bc5a364078fb44e490e63abaadd5c6ebc5df0547cf1637ae2ff1ff806d016` |
| Server package tarball SHA-256   | `6ad3a8daf109191bc4b77800e3bc6d4fd3d7d10c478e63f76dcd946915d6c170` |
| Protocol package tarball SHA-256 | `ebe48d94396126d8f0a5236e768c346bd753a9a64d4393362eafca5bf6fd299a` |

All seven locally packed workspace packages were installed into the new stage
with npm 11, and `npm ls` resolved the workspace packages to the same 0.7.0
stage. The previous beta package was not overwritten.

## Deployment configuration and health

The existing user service was retained and restarted cleanly. Its product
configuration remains:

```
Environment=PASEO_CORS_ORIGINS=http://100.121.148.16:8081
ExecStart=/home/nayte/.local/bin/paseo daemon start --foreground \
  --listen 100.121.148.16:6767 --web-ui --no-relay \
  --hostnames anvil-node-02,anvil-node-02.tail530013.ts.net,100.121.148.16
```

Cutover evidence:

- Old worker shut down cleanly at 18:11:15.937 EDT.
- Stable worker started at 18:11:18.477 EDT with `daemonVersion: "0.7.0"`.
- `systemctl --user show paseo.service`: `ActiveState=active`,
  `SubState=running`, main supervisor PID `2928924`.
- `paseo.service` owns the Tailscale listener `100.121.148.16:6767`.
- `curl http://100.121.148.16:6767/api/health` returned
  `{"status":"ok","timestamp":"2026-08-31T22:11:33.681Z"}`.
- Expo continued to use the Tailscale UI and daemon values
  `100.121.148.16:8081` and `100.121.148.16:6767`. The Metro protocol dist was
  rebuilt once after the merge so the stable `paseo-tool-call-detail` export
  resolved; the bundle then returned HTTP 200.

Existing persisted ACP agents that were already attached to the beta process
reported the pre-existing `acp does not support ACP session resume` limitation
when the daemon was restarted. A fresh agent/session was used for acceptance;
the stable update did not change that ACP capability or discard the old package.

## Test and build evidence

In an isolated worktree of the merged source:

- npm 11 lockfile install completed successfully.
- Protocol, client, server, and CLI builds completed successfully.
- Focused app acceptance tests: 2 files, 3 tests passed.
- Focused ACP/websocket tests: 2 files, 109 tests passed.
- Full app unit project: 582 files, 4,859 tests passed.
- Stable CLI smoke: `paseo --version` returned `0.7.0`; daemon help rendered;
  an isolated smoke daemon bound to `100.121.148.16:6768`, served `/api/health`,
  and shut down cleanly.
- Full server build and focused server tests passed. The complete server unit
  suite was not claimed: several repository test helpers require a newer
  Node built-in TypeScript runtime and fail with `ERR_NO_TYPESCRIPT` under the
  node runtime available on the node. This is a test-harness limitation, not a
  failed production build.

## Actual Steel/Paseo live stream acceptance

The acceptance target was the current Tailscale Paseo workspace:

```
http://100.121.148.16:8081/h/srv_rXLZO41nM2Fn/workspace/wks_e808bf15d0343f97
```

No synthetic playback was used. A fresh Fazm Gemini Pro agent was created after
the stable daemon restart. The browser DOM was sampled through Steel's live
Chrome target with a monotonic clock. The sampler began at
`2026-08-31T22:20:16.517Z` (18:20:16.517 EDT).

### Progressive reasoning and answer timeline

The prompt was accepted when the UI entered its working state at
`22:20:20.575Z`. The numbers below are monotonic milliseconds from sampler
start; wall timestamps are UTC (subtract four hours for EDT).

| Event                          |                     Monotonic | Wall timestamp                  | Observation                                                |
| ------------------------------ | ----------------------------: | ------------------------------- | ---------------------------------------------------------- |
| prompt accepted / turn started |                 +4,058.608 ms | `22:20:20.575Z`                 | working indicator appeared                                 |
| first Thinking DOM growth      |                 +8,304.745 ms | `22:20:24.821Z`                 | Thinking length 2,256 -> 453-byte new live item            |
| second Thinking growth         |                +10,888.534 ms | `22:20:27.405Z`                 | length 869                                                 |
| third Thinking growth          |                +14,078.126 ms | `22:20:30.595Z`                 | length 1,427                                               |
| fourth Thinking growth         |                +16,965.308 ms | `22:20:33.482Z`                 | length 1,926                                               |
| fifth Thinking growth          |                +21,065.562 ms | `22:20:37.582Z`                 | length 2,336                                               |
| sixth Thinking growth          |                +23,039.789 ms | `22:20:39.556Z`                 | length 2,817                                               |
| seventh Thinking growth        |                +25,926.955 ms | `22:20:42.443Z`                 | length 3,311                                               |
| first assistant DOM growth     |                +27,292.397 ms | `22:20:43.809Z`                 | first assistant length 74                                  |
| second assistant growth        |                +27,595.919 ms | `22:20:44.112Z`                 | length 166                                                 |
| third assistant growth         |                +27,750.021 ms | `22:20:44.267Z`                 | length 264                                                 |
| additional assistant growth    | +27,901.744 to +32,026.691 ms | `22:20:44.418Z`–`22:20:48.543Z` | 3+ distinct assistant blocks and many paced length changes |
| terminal                       |                +32,026.794 ms | `22:20:48.543Z`                 | working indicator disappeared                              |

The final DOM contained two Thinking items with 2,256 and 3,302 characters,
14 assistant blocks, and the sampler observed 44 state records. The first
Thinking update preceded the first assistant update by approximately 18.99 s;
both surfaces changed repeatedly while the turn was still active. The service
metrics for the same agent recorded `timeline:reasoning`,
`timeline:assistant_message`, `turn_started`, and `turn_completed` events with
zero socket backpressure (`bufferedAmount.p95=0`, `max=0`).

### Follow-up question UI

While the fresh agent was running, the live ACP question card appeared with:

```
How do you want to sequence the initial rollout?
Instrumentation first
Tests first
Deployment first
```

The three rows were real single-select radio controls with the expected
accessibility labels. `Instrumentation first` was selected, the Submit action
became enabled, and submitting removed the card while the same agent continued
streaming. The continuation rendered new Thinking and assistant content and
reached terminal completion. The daemon metrics recorded one
`permission_requested`, one `agent_permission_response`, and one
`permission_resolved` for the turn.

### Dropdown UI

The live `combined-model-selector` was opened after the turn. Its dialog was
visible and selectable and contained:

- `Fazm Gemini Flash` (`gemini-flash-latest`)
- `Fazm Gemini Pro` (`gemini-pro-latest`)

Selecting the existing Pro row closed the dialog without an exception. No
`useBottomSheetInternal` error was produced. This verifies the web DOM-anchor
fix survived the stable merge and the stable bundle.

## Acceptance labels

**PROVEN**

- Stable source tag, merged Wave-10 source, pushed branch, staged package
  identities, active `0.7.0` daemon, Tailscale health, and rollback symlink.
- Full app unit suite and focused ACP suites pass on the merged source.
- Actual Steel/Paseo Thinking content grows seven times before assistant text.
- Actual Steel/Paseo assistant content grows on many distinct updates before
  terminal completion.
- Follow-up question UI renders, accepts a choice, submits, and resumes the
  same agent; model dropdown opens and selects.

**OBSERVED**

- The old beta package remains available for rollback.
- Existing persisted ACP sessions cannot resume across a daemon restart because
  the provider reports the same pre-existing ACP resume limitation.
- The complete server unit suite is unavailable under the node's current Node
  runtime because of the test helper's `ERR_NO_TYPESCRIPT` requirement.

**INFERRED**

- The stable release's steady-rate visual pacing complements, rather than
  replaces, the Wave-10 upstream relay stream; DOM growth and daemon stream
  counters agree on the live path.

**FALSIFIED**

- A stale beta CLI remained active after cutover.
- A completed answer followed by synthetic chunk playback was the only source
  of the live acceptance evidence.
- The dropdown was still dependent on the broken bottom-sheet context.

**BLOCKED**

- None for the requested stable cutover and live UI acceptance. The server
  unit-harness limitation is explicitly recorded above and is not a production
  deployment blocker.
