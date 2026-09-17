import type {
  AgentStreamEvent,
  AgentTimelineItem,
  ToolCallDetail,
  ToolCallTimelineItem,
} from "../agent/agent-sdk-types.js";
import type { AgentTimelineRow } from "../agent/agent-timeline-store-types.js";
import { AgentTraceStateSchema, type AgentTraceState } from "./contract.js";
import { redactSecrets } from "./redaction.js";

const MAX_STATE_BYTES = 256 * 1024;
const MAX_MISSION_BYTES = 16 * 1024;
const MAX_FINAL_RESPONSE_BYTES = 16 * 1024;
const MAX_MESSAGE_BYTES = 8 * 1024;
const MAX_TOOL_RESULT_BYTES = 4 * 1024;
const MAX_TOOL_ARGUMENT_BYTES = 2 * 1024;
const MAX_COMMAND_BYTES = 1024;
const MAX_REF_BYTES = 512;
const MAX_CONVERSATION_ENTRIES = 80;
const MAX_TOOL_CALLS = 120;
const MAX_TEST_EVIDENCE = 40;
const MAX_SOURCE_REFS = 64;
const CONVERSATION_KEEP_HEAD = 20;
const FALLBACK_MISSION = "Paseo agent run without a recorded user prompt";

const TEST_COMMAND_PATTERN =
  /\b(vitest|jest|pytest|py\.test|cargo\s+test|go\s+test|npm\s+test|npm\s+run\s+test|npx\s+(?:vitest|jest|playwright\s+test)|yarn\s+test|pnpm\s+test|bun\s+test|mvn\s+test|mvnw?\s+verify|gradle\w*\s+test|ctest|bats|rspec|tox|nox|playwright\s+test|maestro\s+test|swift\s+test|xcodebuild\b[^;|&]*\btest|dotnet\s+test|mix\s+test|prove)\b/i;

export interface ObservedAgent {
  id: string;
  provider: string;
  cwd: string;
  workspaceId?: string;
  title?: string | null;
}

type TerminalTurnEvent = Extract<
  AgentStreamEvent,
  { type: "turn_completed" | "turn_failed" | "turn_canceled" }
>;

export interface AgentTraceBuild {
  state: AgentTraceState;
  sourceRunId: string;
  sourceEvidenceIds: string[];
}

function truncateText(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text;
  }
  const truncated = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
  return `${truncated}…[truncated]`;
}

export function sanitizeWireToken(value: string, maxLength: number): string {
  const sanitized = value.replace(/[^A-Za-z0-9_.:-]/g, "-");
  return sanitized.length > maxLength ? sanitized.slice(0, maxLength) : sanitized;
}

function scopeRunRows(rows: AgentTimelineRow[], turnId: string | undefined): AgentTimelineRow[] {
  if (turnId !== undefined) {
    return rows.filter((row) => row.turnId === turnId);
  }
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index].item.type === "user_message") {
      return rows.slice(index);
    }
  }
  return rows;
}

function lastUserText(rows: AgentTimelineRow[]): string | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const item = rows[index].item;
    if (item.type === "user_message") {
      return item.text;
    }
  }
  return null;
}

function lastAssistantText(rows: AgentTimelineRow[]): string | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const item = rows[index].item;
    if (item.type === "assistant_message") {
      return item.text;
    }
  }
  return null;
}

function toConversationEntry(row: AgentTimelineRow): {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: string;
} | null {
  const item = row.item;
  if (item.type === "user_message") {
    return {
      role: "user",
      content: truncateText(redactSecrets(item.text), MAX_MESSAGE_BYTES),
      timestamp: row.timestamp,
    };
  }
  if (item.type === "assistant_message") {
    return {
      role: "assistant",
      content: truncateText(redactSecrets(item.text), MAX_MESSAGE_BYTES),
      timestamp: row.timestamp,
    };
  }
  if (item.type === "error") {
    return {
      role: "system",
      content: truncateText(redactSecrets(item.message), MAX_MESSAGE_BYTES),
      timestamp: row.timestamp,
    };
  }
  return null;
}

function buildConversation(rows: AgentTimelineRow[]): AgentTraceState["conversation"] {
  const entries = rows
    .map(toConversationEntry)
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  if (entries.length <= MAX_CONVERSATION_ENTRIES) {
    return entries;
  }
  const head = entries.slice(0, CONVERSATION_KEEP_HEAD);
  const tail = entries.slice(entries.length - (MAX_CONVERSATION_ENTRIES - CONVERSATION_KEEP_HEAD));
  return [...head, ...tail];
}

function isToolCallItem(item: AgentTimelineItem): item is ToolCallTimelineItem {
  return item.type === "tool_call";
}

type ToolCallRow = AgentTimelineRow & { item: ToolCallTimelineItem };

function toolCallRows(rows: AgentTimelineRow[]): ToolCallRow[] {
  return rows.filter((row): row is ToolCallRow => isToolCallItem(row.item));
}

function toolCallArguments(item: ToolCallTimelineItem): unknown {
  const detail = item.detail;
  switch (detail.type) {
    case "shell":
      return {
        command: truncateText(redactSecrets(detail.command), MAX_COMMAND_BYTES),
        ...(detail.cwd !== undefined ? { cwd: redactSecrets(detail.cwd) } : {}),
      };
    case "read":
      return {
        filePath: redactSecrets(detail.filePath),
        ...(detail.offset !== undefined ? { offset: detail.offset } : {}),
        ...(detail.limit !== undefined ? { limit: detail.limit } : {}),
      };
    case "edit":
      return { filePath: redactSecrets(detail.filePath) };
    case "write":
      return { filePath: redactSecrets(detail.filePath) };
    case "search":
      return {
        query: truncateText(redactSecrets(detail.query), MAX_COMMAND_BYTES),
        ...(detail.toolName !== undefined ? { toolName: detail.toolName } : {}),
      };
    case "fetch":
      return { url: truncateText(redactSecrets(detail.url), MAX_COMMAND_BYTES) };
    case "sub_agent":
      return {
        ...(detail.subAgentType !== undefined ? { subAgentType: detail.subAgentType } : {}),
        ...(detail.description !== undefined
          ? { description: truncateText(redactSecrets(detail.description), MAX_COMMAND_BYTES) }
          : {}),
      };
    case "worktree_setup":
      return { worktreePath: redactSecrets(detail.worktreePath), branchName: detail.branchName };
    case "plan":
      return { text: truncateText(redactSecrets(detail.text), MAX_TOOL_ARGUMENT_BYTES) };
    case "plain_text":
      return detail.label !== undefined ? { label: redactSecrets(detail.label) } : undefined;
    case "unknown":
      return undefined;
  }
}

function toolCallDetailResult(detail: ToolCallDetail): string | undefined {
  switch (detail.type) {
    case "shell":
      return detail.output;
    case "read":
    case "search":
      return detail.content;
    case "write":
      return detail.content;
    case "edit":
      return detail.unifiedDiff;
    case "fetch":
      return detail.result;
    case "plain_text":
      return detail.text;
    case "sub_agent":
    case "worktree_setup":
      return detail.log;
    case "plan":
    case "unknown":
      return undefined;
  }
}

function toolCallErrorText(error: unknown): string {
  return typeof error === "string" ? error : JSON.stringify(error ?? "failed");
}

function toolCallResult(item: ToolCallTimelineItem): string | undefined {
  const raw =
    item.status === "failed" ? toolCallErrorText(item.error) : toolCallDetailResult(item.detail);
  return typeof raw === "string"
    ? truncateText(redactSecrets(raw), MAX_TOOL_RESULT_BYTES)
    : undefined;
}

function toolCallExitCode(item: ToolCallTimelineItem): number | null | undefined {
  return item.detail.type === "shell" ? (item.detail.exitCode ?? null) : undefined;
}

function buildToolCalls(rows: AgentTimelineRow[]): NonNullable<AgentTraceState["tool_calls"]> {
  const calls = toolCallRows(rows).map((row) => {
    const item = row.item;
    const entry: NonNullable<AgentTraceState["tool_calls"]>[number] = {
      seq: row.seq,
      tool: item.name,
    };
    const args = toolCallArguments(item);
    if (args !== undefined) {
      entry.arguments = args;
    }
    const result = toolCallResult(item);
    if (result !== undefined) {
      entry.result = result;
    }
    const exitCode = toolCallExitCode(item);
    if (exitCode !== undefined) {
      entry.exit_code = exitCode;
    }
    return entry;
  });
  return calls.length <= MAX_TOOL_CALLS ? calls : calls.slice(calls.length - MAX_TOOL_CALLS);
}

function buildTestEvidence(
  rows: AgentTimelineRow[],
): NonNullable<AgentTraceState["test_evidence"]> {
  const entries = toolCallRows(rows).flatMap((row) => {
    if (row.item.detail.type !== "shell") {
      return [];
    }
    const detail = row.item.detail;
    if (!TEST_COMMAND_PATTERN.test(detail.command)) {
      return [];
    }
    const output = typeof detail.output === "string" ? detail.output : "";
    return [
      {
        command: truncateText(redactSecrets(detail.command), MAX_COMMAND_BYTES),
        exit_code: detail.exitCode ?? null,
        summary: truncateText(
          redactSecrets(output.length > 0 ? output.slice(-2000) : row.item.status),
          MAX_TOOL_RESULT_BYTES,
        ),
      },
    ];
  });
  return entries.length <= MAX_TEST_EVIDENCE
    ? entries
    : entries.slice(entries.length - MAX_TEST_EVIDENCE);
}

function buildSourceRefs(rows: AgentTimelineRow[]): string[] {
  const refs = new Set<string>();
  for (const row of rows) {
    const item = row.item;
    if (!isToolCallItem(item)) {
      continue;
    }
    const detail = item.detail;
    if (detail.type === "read" || detail.type === "edit" || detail.type === "write") {
      refs.add(`file:${detail.filePath}`);
    } else if (detail.type === "search" && detail.filePaths) {
      for (const filePath of detail.filePaths) {
        refs.add(`file:${filePath}`);
      }
    } else if (detail.type === "fetch") {
      refs.add(`url:${detail.url}`);
    } else if (detail.type === "worktree_setup") {
      refs.add(`file:${detail.worktreePath}`);
    }
    if (refs.size >= MAX_SOURCE_REFS) {
      break;
    }
  }
  return [...refs]
    .slice(0, MAX_SOURCE_REFS)
    .map((ref) => truncateText(redactSecrets(ref), MAX_REF_BYTES));
}

function outcomeOf(event: TerminalTurnEvent): "completed" | "failed" | "canceled" {
  if (event.type === "turn_completed") return "completed";
  if (event.type === "turn_failed") return "failed";
  return "canceled";
}

function buildDeterministicInputs(params: {
  agent: ObservedAgent;
  event: TerminalTurnEvent;
  runRows: AgentTimelineRow[];
  totalRows: number;
}): NonNullable<AgentTraceState["deterministic_inputs"]> {
  const { agent, event, runRows, totalRows } = params;
  return {
    agent_id: agent.id,
    provider: agent.provider,
    cwd: redactSecrets(agent.cwd),
    ...(agent.workspaceId !== undefined ? { workspace_id: agent.workspaceId } : {}),
    turn_id: event.turnId ?? null,
    terminal_event: event.type,
    outcome: outcomeOf(event),
    ...(event.type === "turn_failed" ? { error: redactSecrets(event.error) } : {}),
    ...(event.type === "turn_failed" && event.code ? { error_code: event.code } : {}),
    ...(event.type === "turn_canceled" ? { cancel_reason: redactSecrets(event.reason) } : {}),
    ...(event.type === "turn_completed" && event.usage ? { usage: event.usage } : {}),
    run_row_count: runRows.length,
    timeline_row_count: totalRows,
  };
}

function buildDeterministicAudit(params: {
  event: TerminalTurnEvent;
  runRows: AgentTimelineRow[];
  totalRows: number;
}): NonNullable<AgentTraceState["deterministic_audit"]> {
  const { event, runRows, totalRows } = params;
  const toolCalls = toolCallRows(runRows);
  const statusCounts = { completed: 0, failed: 0, canceled: 0, running: 0 };
  for (const row of toolCalls) {
    statusCounts[row.item.status] += 1;
  }
  return [
    {
      check: "terminal_outcome",
      result: { event: event.type, outcome: outcomeOf(event), turnId: event.turnId ?? null },
    },
    {
      check: "tool_call_status",
      result: { total: toolCalls.length, ...statusCounts },
    },
    {
      check: "timeline_rows",
      result: { run: runRows.length, total: totalRows },
    },
  ];
}

function stateBytes(state: AgentTraceState): number {
  return Buffer.byteLength(JSON.stringify(state), "utf8");
}

function shrinkToolCalls(
  calls: NonNullable<AgentTraceState["tool_calls"]>,
  over: () => boolean,
): void {
  for (const call of calls) {
    if (!over()) {
      break;
    }
    if (call.result !== undefined) {
      call.result = truncateText(call.result, 512);
    }
    if (call.arguments !== undefined) {
      call.arguments = truncateText(JSON.stringify(call.arguments), 512);
    }
  }
  while (calls.length > 40 && over()) {
    calls.shift();
  }
}

function shrinkTestEvidence(
  entries: NonNullable<AgentTraceState["test_evidence"]>,
  over: () => boolean,
): void {
  for (const entry of entries) {
    if (!over()) {
      break;
    }
    entry.summary = truncateText(entry.summary, 512);
  }
  while (entries.length > 20 && over()) {
    entries.shift();
  }
}

function shrinkConversation(
  entries: NonNullable<AgentTraceState["conversation"]>,
  over: () => boolean,
): void {
  while (entries.length > 30 && over()) {
    entries.splice(CONVERSATION_KEEP_HEAD, 1);
  }
  for (const entry of entries) {
    if (!over()) {
      break;
    }
    entry.content = truncateText(entry.content, 1024);
  }
  while (entries.length > 12 && over()) {
    entries.splice(Math.min(CONVERSATION_KEEP_HEAD, 12), 1);
  }
}

/**
 * Progressive degradation when a state exceeds the provider-bound budget:
 * shrink tool results and test output, then drop old entries, then truncate
 * conversation content, and only then touch the mission/final response. The
 * final step drops optional sections entirely so the bound is guaranteed for
 * any input.
 */
function enforceStateBudget(state: AgentTraceState): AgentTraceState {
  const over = () => stateBytes(state) > MAX_STATE_BYTES;

  if (state.tool_calls) {
    shrinkToolCalls(state.tool_calls, over);
  }
  if (state.test_evidence) {
    shrinkTestEvidence(state.test_evidence, over);
  }
  if (state.conversation) {
    shrinkConversation(state.conversation, over);
  }
  if (state.source_refs && state.source_refs.length > 16 && over()) {
    state.source_refs = state.source_refs.slice(0, 16);
  }
  if (state.final_response !== undefined && over()) {
    state.final_response = truncateText(state.final_response, 4 * 1024);
  }
  if (over()) {
    state.mission = truncateText(state.mission, 4 * 1024);
  }
  if (over()) {
    delete state.conversation;
    delete state.tool_calls;
    delete state.test_evidence;
    delete state.source_refs;
  }
  return state;
}

export function buildAgentTrace(params: {
  agent: ObservedAgent;
  event: TerminalTurnEvent;
  rows: AgentTimelineRow[];
}): AgentTraceBuild {
  const { agent, event, rows } = params;
  const turnId = event.turnId;
  const runRows = scopeRunRows(rows, turnId);

  const missionText = lastUserText(runRows) ?? lastUserText(rows);
  const mission =
    missionText !== null && missionText.trim().length >= 8
      ? truncateText(redactSecrets(missionText), MAX_MISSION_BYTES)
      : FALLBACK_MISSION;

  const finalResponse = lastAssistantText(runRows);

  const state: AgentTraceState = {
    mission,
    conversation: buildConversation(runRows),
    tool_calls: buildToolCalls(runRows),
    ...(finalResponse !== null
      ? { final_response: truncateText(redactSecrets(finalResponse), MAX_FINAL_RESPONSE_BYTES) }
      : {}),
    test_evidence: buildTestEvidence(runRows),
    source_refs: buildSourceRefs(runRows),
    deterministic_audit: buildDeterministicAudit({ event, runRows, totalRows: rows.length }),
    deterministic_inputs: buildDeterministicInputs({
      agent,
      event,
      runRows,
      totalRows: rows.length,
    }),
  };
  AgentTraceStateSchema.parse(state);
  enforceStateBudget(state);

  const runRef = turnId ?? `rows-${runRows[0]?.seq ?? 0}-${runRows.at(-1)?.seq ?? 0}`;
  const sourceRunId = sanitizeWireToken(`paseo:${agent.id}:${runRef}`, 200);
  const sourceEvidenceIds = [
    sanitizeWireToken(`paseo-agent-${agent.id}`, 200),
    ...(turnId !== undefined ? [sanitizeWireToken(`paseo-turn-${turnId}`, 200)] : []),
    ...(runRows.length > 0
      ? [`paseo-rows-${runRows[0].seq}-${runRows[runRows.length - 1].seq}`]
      : []),
  ];

  return { state, sourceRunId, sourceEvidenceIds };
}
