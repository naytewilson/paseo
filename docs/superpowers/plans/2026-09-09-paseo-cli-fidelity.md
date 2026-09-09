# Paseo CLI fidelity closure — implementation wave

## Source truth and scope

- Active assignment: `/tmp/codex-remote-attachments/01a08802-acc2-7c82-bd8d-61e08edf508e/1EA4D309-F938-4132-9245-24BCF30D685B/1-PASEO_CLI_DELL_NEO_FIDELITY_CAMPAIGN.toon`.
- PASEO checkout: `/home/nayte/ANVIL-worker/worktrees/paseo-cli-fidelity-20260909`, upstream `main` at `726067b43759c5c489ab865eee0fe05e8334ea77`.
- Direct-CLI T3 checkout: `/home/nayte/ANVIL-worker/worktrees/t3code-cli-fidelity-20260909`, fork branch `forge/muse-command-direct-cli-live-squashed` at `a8132b482982557261ccd02e44aa3ce448bf06ab`.
- Live Dell service and T3 provider worktrees are protected. Runtime changes happen only after source tests pass and provenance/ownership are rechecked.

## Root-cause contract

1. The live Command Code CLI emits structured tool records: `tool_queued`, `tool_running`, and `tool_completed` with `file_path` input and ACP text content blocks in the result.
2. The bridge and ACP SDK preserve those fields through the wire.
3. PASEO's `mapToolDetail` is the first lossy boundary: it omits snake-case aliases and treats the output block array as an opaque value.
4. The direct T3 adapters independently parse only assistant text and terminal result records, dropping tool identity, arguments, results, and thought deltas before runtime ingestion.

## Test-first tasks

### PASEO mapper

- Add a focused `acp-agent.test.ts` regression using a representative `read` snapshot with `rawInput.file_path` and `rawOutput` as ACP text blocks.
- Assert canonical `read.filePath`, `read.content`, and snake-case line controls survive mapping.
- Add coverage for the shared text extraction path so object-shaped legacy providers remain compatible.

### T3 direct CLI adapters

- Extend parser tests with current Command Code JSON events for `message_update`/`tool_use`, `tool_queued`, `tool_running`, `tool_completed`, `thinking_delta`, and the existing result record.
- Extend the process test with a deterministic child that emits a thought, a tool lifecycle, and an assistant reply; assert the adapter publishes canonical runtime item/content events with stable tool id, input, output, and status.
- Cover the equivalent Muse event shapes when the installed branch's native JSONL vocabulary exposes them; do not invent thinking evidence when the CLI does not emit it.

## Implementation tasks

1. In PASEO, normalize provider aliases (`file_path` and other common snake-case fields) and extract text from ACP output content-block arrays without logging or persisting credentials.
2. In T3, add a typed direct-CLI parsed-event union for thought deltas and tool start/update records; preserve the raw input/output in runtime item `data` and emit tool item lifecycle events alongside assistant/reasoning deltas.
3. Keep the existing session/resume, cancellation, failure, and assistant completion behavior unchanged.
4. Run focused tests, then package typechecks/builds. Hosted CI is embargoed and is not evidence.

## Live closure gates

- Re-query Dell service PID, unit command, daemon version, installed CLI/bridge provenance, and protected T3 process before any restart/deploy.
- Re-run one deterministic read-only Dell task and inspect raw CLI, bridge, PASEO timeline, and user-facing projection. Require exact path, tool status, and result content; label thinking `PROVEN` only if actual thought text is observed.
- Independently inventory Neo connectivity, installed Paseo/Muse/Command Code provenance, launch path, and auth state without secrets; run the same read-only probe if the lane is reachable.
- Do not claim two-host closure if Neo is inaccessible, if the deployed runtime remains on the old source, or if UI proof cannot be observed. Preserve those as explicit `UNKNOWN`/`BLOCKED` gates.

## Handoff receipt

Record starting/final refs, changed files, exact test commands/results, runtime versions and PIDs, artifact paths/hashes, protected surfaces, evidence labels, unresolved gates, and the next authorized action. Commit/push only coherent verified source work to the owned fork branches; never force-push or mutate the protected live trees.
