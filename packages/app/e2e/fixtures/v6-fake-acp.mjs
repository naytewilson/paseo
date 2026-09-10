#!/usr/bin/env node
// V6 model + reasoning fidelity fake ACP agent: deterministic disjoint
// per-model reasoning sets. model-a -> [low, medium] (default low);
// model-b -> [high, xhigh] (default xhigh); model-c -> no controllable
// reasoning. Logs every prompt boundary to V6_FAKE_LOG.
import * as acp from "@agentclientprotocol/sdk/dist/acp.js";
import { Readable, Writable } from "node:stream";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOG = process.env.V6_FAKE_LOG ?? join(tmpdir(), "v6-fake-acp-prompt-boundary.jsonl");

const LEVELS = {
  "v6-model-a": ["low", "medium"],
  "v6-model-b": ["high", "xhigh"],
};
const DEFAULTS = { "v6-model-a": "low", "v6-model-b": "xhigh" };
const MODELS = [
  {
    modelId: "v6-model-a",
    name: "V6 Model A",
    description: "disjoint low/medium",
    _meta: { thoughtLevels: ["low", "medium"], defaultThoughtLevel: "low" },
  },
  {
    modelId: "v6-model-b",
    name: "V6 Model B",
    description: "disjoint high/xhigh",
    _meta: { thoughtLevels: ["high", "xhigh"], defaultThoughtLevel: "xhigh" },
  },
  {
    modelId: "v6-model-c",
    name: "V6 Model C",
    description: "no controllable reasoning",
    _meta: { reasoning: false },
  },
];

function modelOption(current) {
  return {
    id: "model-option",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: current,
    options: MODELS.map((m) => ({ value: m.modelId, name: m.name })),
  };
}

function thoughtOption(model, thinking) {
  const levels = LEVELS[model];
  if (!levels) return null;
  return {
    id: "thought_level-option",
    name: "Thinking",
    category: "thought_level",
    type: "select",
    currentValue: thinking ?? DEFAULTS[model],
    options: levels.map((v) => ({ value: v, name: v })),
  };
}

function configFor(model, thinking) {
  const out = [modelOption(model)];
  const t = thoughtOption(model, thinking);
  if (t) out.push(t);
  return out;
}

class FakeAgent {
  constructor(connection) {
    this.connection = connection;
    this.sessions = new Map();
  }
  async initialize(_params) {
    return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {} };
  }
  async authenticate(_params) {
    return {};
  }
  async newSession(_params) {
    const sessionId = `v6-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    this.sessions.set(sessionId, { model: "v6-model-a", thinking: "low" });
    await this.connection.sessionUpdate({
      sessionId,
      update: { sessionUpdate: "available_commands_update", availableCommands: [] },
    });
    return {
      sessionId,
      models: { currentModelId: "v6-model-a", availableModels: MODELS },
      configOptions: configFor("v6-model-a", "low"),
    };
  }
  async setSessionConfigOption(params) {
    const s = this.sessions.get(params.sessionId);
    if (!s) throw new Error(`unknown session ${params.sessionId}`);
    if (params.configId === "model-option") {
      if (!MODELS.some((m) => m.modelId === params.value)) {
        throw new Error(`unknown model '${params.value}'`);
      }
      s.model = params.value;
      s.thinking = DEFAULTS[s.model] ?? null;
    } else if (params.configId === "thought_level-option") {
      const levels = LEVELS[s.model] ?? [];
      if (!levels.includes(params.value)) {
        throw new Error(
          `thinking option '${params.value}' is not available for model '${s.model}'`,
        );
      }
      s.thinking = params.value;
    }
    return { configOptions: configFor(s.model, s.thinking) };
  }
  // NOTE: unstable_setSessionModel deliberately NOT implemented so the client
  // exercises the config-option fallback path deterministically.
  async prompt(params) {
    const s = this.sessions.get(params.sessionId);
    const record = {
      t: new Date().toISOString(),
      sessionId: params.sessionId,
      model: s?.model ?? null,
      thinking: s?.thinking ?? null,
      prompt: params.prompt,
    };
    appendFileSync(LOG, JSON.stringify(record) + "\n");
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `v6-fake-ok model=${record.model} thinking=${record.thinking}` },
      },
    });
    return { stopReason: "end_turn" };
  }
  async cancel(_params) {}
}

const input = Writable.toWeb(process.stdout);
const output = Readable.toWeb(process.stdin);
const stream = acp.ndJsonStream(input, output);
new acp.AgentSideConnection((conn) => new FakeAgent(conn), stream);
