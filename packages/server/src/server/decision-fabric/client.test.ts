import { afterEach, describe, expect, test } from "vitest";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createDecisionFabricClient,
  DecisionFabricInvalidRequestError,
  DecisionFabricMalformedResponseError,
  DecisionFabricRequestError,
  DecisionFabricTimeoutError,
  DecisionFabricUnavailableError,
} from "./client.js";
import type { DecideRequest } from "./contract.js";

const RECEIPT_DIGEST = "a".repeat(64);

function validRequest(): DecideRequest {
  return {
    contract_id: "anvil.agent-trace-observability.v1",
    contract_version: "1.0.0",
    request_id: "paseo-agent-1-req-1",
    source_run_id: "paseo:agent-1:turn-1",
    state: { mission: "implement the feature" },
    source_evidence_ids: ["paseo-agent-agent-1"],
  };
}

function validResponse(requestId: string): Record<string, unknown> {
  return {
    request_id: requestId,
    contract_id: "anvil.agent-trace-observability.v1",
    contract_version: "1.0.0",
    requested_model: "jev-local",
    effective_model: "jev-local",
    answers: { verdict: { type: "score", score: 0.9 } },
    policy_mode: "SHADOW_ONLY",
    policy_outcome: "WOULD_REVIEW",
    receipt_id: "drc-test-1",
    receipt_digest: RECEIPT_DIGEST,
  };
}

interface StubDaemon {
  socketPath: string;
  requests: Array<{ path: string | undefined; method: string | undefined; body: string }>;
  close(): Promise<void>;
}

async function startStubDaemon(
  handler: (body: string, response: http.ServerResponse) => void,
): Promise<StubDaemon> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jev-fabric-test-"));
  const socketPath = path.join(dir, "decisiond.sock");
  const requests: StubDaemon["requests"] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ path: req.url, method: req.method, body });
      handler(body, res);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return {
    socketPath,
    requests,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function jsonReply(
  status: number,
  payload: unknown,
): (body: string, res: http.ServerResponse) => void {
  return (_body, res) => {
    const data = typeof payload === "string" ? payload : JSON.stringify(payload);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(data);
  };
}

describe("createDecisionFabricClient", () => {
  const daemons: StubDaemon[] = [];
  async function track(
    handler: (body: string, response: http.ServerResponse) => void,
  ): Promise<StubDaemon> {
    const daemon = await startStubDaemon(handler);
    daemons.push(daemon);
    return daemon;
  }

  afterEach(async () => {
    while (daemons.length > 0) {
      await daemons.pop()?.close();
    }
  });

  test("posts the contract request over the unix socket and parses the response", async () => {
    const daemon = await track((body, res) => {
      const request = JSON.parse(body) as { request_id: string };
      jsonReply(200, validResponse(request.request_id))(body, res);
    });
    const client = createDecisionFabricClient({
      socketPath: daemon.socketPath,
      timeoutMs: 5_000,
    });

    const response = await client.decide(validRequest());

    expect(daemon.requests).toHaveLength(1);
    expect(daemon.requests[0].method).toBe("POST");
    expect(daemon.requests[0].path).toBe("/v1/decide");
    const sent = JSON.parse(daemon.requests[0].body) as Record<string, unknown>;
    expect(sent.contract_id).toBe("anvil.agent-trace-observability.v1");
    expect(sent.contract_version).toBe("1.0.0");
    expect(sent.source_evidence_ids).toEqual(["paseo-agent-agent-1"]);
    expect(response.policy_mode).toBe("SHADOW_ONLY");
    expect(response.policy_outcome).toBe("WOULD_REVIEW");
    expect(response.receipt_id).toBe("drc-test-1");
    expect(response.receipt_digest).toBe(RECEIPT_DIGEST);
  });

  test("fails with DecisionFabricUnavailableError when the socket does not exist", async () => {
    const client = createDecisionFabricClient({
      socketPath: path.join(os.tmpdir(), `jev-missing-${Date.now()}.sock`),
      timeoutMs: 5_000,
    });
    await expect(client.decide(validRequest())).rejects.toBeInstanceOf(
      DecisionFabricUnavailableError,
    );
  });

  test("fails with DecisionFabricTimeoutError when the daemon never responds", async () => {
    const daemon = await track((_body, _res) => {
      // Deliberately never write a response.
    });
    const client = createDecisionFabricClient({
      socketPath: daemon.socketPath,
      timeoutMs: 250,
    });
    await expect(client.decide(validRequest())).rejects.toBeInstanceOf(DecisionFabricTimeoutError);
  });

  test("fails with DecisionFabricMalformedResponseError on non-JSON 200 bodies", async () => {
    const daemon = await track(jsonReply(200, "not json"));
    const client = createDecisionFabricClient({
      socketPath: daemon.socketPath,
      timeoutMs: 5_000,
    });
    await expect(client.decide(validRequest())).rejects.toBeInstanceOf(
      DecisionFabricMalformedResponseError,
    );
  });

  test("fails with DecisionFabricMalformedResponseError when receipt fields are missing", async () => {
    const daemon = await track((body, res) => {
      const request = JSON.parse(body) as { request_id: string };
      const response = validResponse(request.request_id) as { receipt_digest?: string };
      delete response.receipt_digest;
      jsonReply(200, response)(body, res);
    });
    const client = createDecisionFabricClient({
      socketPath: daemon.socketPath,
      timeoutMs: 5_000,
    });
    await expect(client.decide(validRequest())).rejects.toBeInstanceOf(
      DecisionFabricMalformedResponseError,
    );
  });

  test("fails with DecisionFabricMalformedResponseError when policy_mode is not SHADOW_ONLY", async () => {
    const daemon = await track((body, res) => {
      const request = JSON.parse(body) as { request_id: string };
      jsonReply(200, { ...validResponse(request.request_id), policy_mode: "ENFORCED" })(body, res);
    });
    const client = createDecisionFabricClient({
      socketPath: daemon.socketPath,
      timeoutMs: 5_000,
    });
    await expect(client.decide(validRequest())).rejects.toBeInstanceOf(
      DecisionFabricMalformedResponseError,
    );
  });

  test("fails with DecisionFabricMalformedResponseError when request_id does not echo ours", async () => {
    const daemon = await track(jsonReply(200, validResponse("someone-elses-id")));
    const client = createDecisionFabricClient({
      socketPath: daemon.socketPath,
      timeoutMs: 5_000,
    });
    await expect(client.decide(validRequest())).rejects.toBeInstanceOf(
      DecisionFabricMalformedResponseError,
    );
  });

  test("maps non-2xx responses to DecisionFabricRequestError with the daemon code", async () => {
    const daemon = await track(
      jsonReply(400, {
        error: { code: "STATE_SCHEMA_VIOLATION", message: "bad state", retryable: false },
      }),
    );
    const client = createDecisionFabricClient({
      socketPath: daemon.socketPath,
      timeoutMs: 5_000,
    });
    const error = await client.decide(validRequest()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DecisionFabricRequestError);
    expect((error as DecisionFabricRequestError).status).toBe(400);
    expect((error as DecisionFabricRequestError).code).toBe("STATE_SCHEMA_VIOLATION");
    expect((error as DecisionFabricRequestError).retryable).toBe(false);
  });

  test("rejects forbidden/extra request fields before any bytes leave the machine", async () => {
    const daemon = await track(jsonReply(200, validResponse("unused")));
    const client = createDecisionFabricClient({
      socketPath: daemon.socketPath,
      timeoutMs: 5_000,
    });
    const poisoned = { ...validRequest(), api_key: "sk-live-secret" } as unknown as DecideRequest;
    await expect(client.decide(poisoned)).rejects.toBeInstanceOf(DecisionFabricInvalidRequestError);
    expect(daemon.requests).toHaveLength(0);
  });
});
