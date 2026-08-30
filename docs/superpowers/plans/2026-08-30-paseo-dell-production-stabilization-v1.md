# Paseo Dell Production Stabilization V1

> **Execution note:** Follow this plan task-by-task, checking each item off as it is completed.

**Goal:** Stabilize the live Paseo 0.7.0-beta.2 installation on anvil-node-02, and produce one reproducible, rollbackable source replacement that preserves the current Codex, OpenCode, Grok, Kiro, and ANVIL workflows.

**Architecture:** Keep the production data/config under `/home/nayte/.paseo` and keep the existing user-systemd service boundary. Converge non-secret topology in persisted Paseo configuration, reduce the unit to the service-specific foreground command, and use the supported hashed daemon password. Build a clean source worktree from the exact `v0.7.0-beta.2` release commit. The source changes are deliberately split into CLI targeting/redaction/truthfulness, provider process ownership, ACP notification handling, supervisor log boundaries, and WebSocket admission/resource limits. Provider processes receive a durable POSIX process-group identity; the managed-process ledger records that identity and startup reconciliation can clean a surviving group after its launcher exits. Windows retains the existing tree-kill fallback with explicit semantics.

**Tech stack:** Node.js 22, TypeScript, npm workspaces, Vitest, `ws`, Pino, user systemd on Linux. No Python, Docker, hosted CI, force push, broad cgroup kill, or destructive workspace reset.

**Spec:** User-provided `PASEO DELL PRODUCTION STABILIZATION V1` continuation contract (30 August 2026).

## Task 1: Runtime evidence and reversible capsule

1. Reverify the direct-worker cgroup, service unit, process tree, listeners, Paseo configuration, agent/managed-process ledgers, provider snapshot, CLI behavior, log statistics, Tailscale state, and stale installations.
2. Preserve the existing live agents, their two managed OpenCode helpers, history, credentials, and historical logs.
3. Keep the rollback root with copies and hashes of every local config, unit, executable/link, and package pointer that may be changed.
4. Reconcile only processes positively proven to be stale/unowned Kiro/Gemini provider trees. Record before/after task and memory measurements.

## Task 2: Persisted topology and application authentication

1. Make persisted configuration describe the intended tailnet listener, disabled relay, enabled web UI, and proven hostnames.
2. Disable Hermes through the supported configuration surface while its executable is unavailable.
3. Remove redundant service command-line topology overrides and reload user systemd.
4. Set a strong random daemon password through the installed supported mechanism; retain plaintext only in a mode-0600 ephemeral client secret file until post-restart validation, never in argv, Git, logs, or the battle report.
5. Restart only through the normal user-systemd path after source promotion and verify unauthenticated rejection plus authenticated status, agent listing, provider listing, diagnostics, and web UI access.

## Task 3: CLI discovery, credential redaction, and provider truthfulness

1. Add failing tests for endpoint precedence: explicit host, `PASEO_HOST`, valid live TCP/IPC runtime PID target, persisted target, and localhost fallback, including stale PID state.
2. Implement live PID endpoint validation without blindly trusting a stale PID file.
3. Separate connection identity from display identity so TCP password query values never appear in errors, diagnostics, JSON errors, or logs; add sentinel-secret regression tests.
4. Change offline/provider-snapshot-failure output so missing live evidence is `unknown` (or the existing daemon error), never `available`; add CLI regression tests.

## Task 4: Provider lifecycle ownership and ACP probe behavior

1. Add failing tests for a launcher that exits before its child and leaves the child running/reparented.
2. Implement durable provider process-group ownership on POSIX, record the group identity in the managed-process ledger, and use it for normal close, failed probe/init, restart/reconnect replacement, and startup reconciliation. Keep a deliberate tree-kill fallback for platforms without the POSIX mechanism.
3. Add startup reconciliation tests proving a dead launcher with a surviving owned group is cleaned while legitimate managed OpenCode helpers are protected.
4. Add ACP tests proving known Kiro/Grok extension notifications are handled where semantically relevant and unknown vendor notifications are consumed/ignored without noisy Method-not-found failures.

## Task 5: Structured logging and WebSocket bounds

1. Add a supervisor regression using multiline provider stdout/stderr and assert every daemon event-log line remains parseable JSONL.
2. Put provider output in a separate bounded/rotated or structured provider log stream with timestamp, provider/agent/process context where available, and redaction of bearer/password/token fields.
3. Add an explicit WebSocket payload limit compatible with binary file-transfer frames and a bounded pending pre-hello connection limit; add ordinary-frame, oversized-frame, pending-limit, and authenticated-client tests.

## Task 6: Isolated validation and artifact

1. Install/build/test only from the clean owned worktree in an isolated prefix with a separate Paseo home, disposable state, and non-production port.
2. Run targeted changed-package Vitest tests, package typechecks/lint/format checks, relevant package-level tests, `git diff --check`, and the deterministic parent-exits-first adversarial test. Do not cite hosted CI.
3. Build hashable package artifacts from the verified source SHA and inspect staged files for secrets/unrelated changes.
4. Reverify source provenance, branch/base/head, and fork/remote identity before any push.

## Task 7: Production promotion and acceptance

1. Promote the verified artifact through an atomic executable/link switch; do not run production from the source tree or overwrite the known-good package installation.
2. Restart `paseo.service` once normally, then run the complete production acceptance matrix: daemon/default CLI/auth, redaction, truthful provider listing, four provider diagnostics, Hermes disposition, no new orphan trees, helper/agent resumability, strict JSONL/event-provider log separation, resource measurements, listener topology, and secret scan.
3. Recheck WebSocket hello/app-version telemetry. Close a stale browser instance only if it can be attributed without collateral browser termination; otherwise record operator action required and do not invent a compatibility floor.
4. Search explicit consumers before reversible archival of stale `/usr/local/bin/paseo` and `/usr/local/bin/opencode`; preserve historical Codex directories unless references prove they are unused.

## Task 8: Durable Git handoff and receipt

1. Commit coherent source changes on `paseo/dell-production-stabilization-v1`, preserving the exact release-base provenance.
2. If the owned fork is available/created, fetch before push, push the verified branch non-force, fetch again, and prove local and remote branch SHAs match. Do not open a PR or wait for hosted CI as the production gate.
3. Return the requested Battle Report with exact commands/results, hashes, rollback steps, evidence labels, remaining unknowns, and exactly one final verdict permitted by the contract.
