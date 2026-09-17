import http from "node:http";

import {
  DECIDE_PATH,
  DecideRequestSchema,
  DecideResponseSchema,
  parseDecideErrorBody,
  type DecideRequest,
  type DecideResponse,
} from "./contract.js";

const MAX_RESPONSE_BYTES = 1024 * 1024;

export class DecisionFabricUnavailableError extends Error {
  constructor(
    public readonly socketPath: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`Decision fabric at ${socketPath} unavailable: ${message}`, options);
    this.name = "DecisionFabricUnavailableError";
  }
}

export class DecisionFabricTimeoutError extends Error {
  constructor(
    public readonly socketPath: string,
    public readonly timeoutMs: number,
  ) {
    super(`Decision fabric at ${socketPath} timed out after ${timeoutMs}ms`);
    this.name = "DecisionFabricTimeoutError";
  }
}

export class DecisionFabricRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | null,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(`Decision fabric rejected the decide request (HTTP ${status}): ${message}`);
    this.name = "DecisionFabricRequestError";
  }
}

export class DecisionFabricMalformedResponseError extends Error {
  constructor(message: string) {
    super(`Decision fabric returned a malformed response: ${message}`);
    this.name = "DecisionFabricMalformedResponseError";
  }
}

export class DecisionFabricInvalidRequestError extends Error {
  constructor(message: string) {
    super(`Decision fabric request failed contract validation: ${message}`);
    this.name = "DecisionFabricInvalidRequestError";
  }
}

export interface DecisionFabricClient {
  decide(request: DecideRequest): Promise<DecideResponse>;
}

interface DecisionFabricClientOptions {
  socketPath: string;
  timeoutMs: number;
}

function readResponseBody(
  response: http.IncomingMessage,
  onDone: (body: string | null, error: Error | null) => void,
): void {
  const chunks: Buffer[] = [];
  let bytes = 0;
  response.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_RESPONSE_BYTES) {
      response.destroy(new DecisionFabricMalformedResponseError("response body exceeds 1 MiB"));
      return;
    }
    chunks.push(chunk);
  });
  response.on("end", () => onDone(Buffer.concat(chunks).toString("utf8"), null));
  response.on("error", (error) => onDone(null, error));
}

function postJson(
  options: DecisionFabricClientOptions,
  payload: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath: options.socketPath,
      method: "POST",
      path: DECIDE_PATH,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload, "utf8"),
        accept: "application/json",
        connection: "close",
      },
      timeout: options.timeoutMs,
    });
    request.on("timeout", () => {
      request.destroy(new DecisionFabricTimeoutError(options.socketPath, options.timeoutMs));
    });
    request.on("error", (error) => {
      if (error instanceof DecisionFabricTimeoutError) {
        reject(error);
        return;
      }
      reject(
        new DecisionFabricUnavailableError(options.socketPath, error.message, { cause: error }),
      );
    });
    request.on("response", (response) => {
      readResponseBody(response, (body, error) => {
        if (error !== null || body === null) {
          reject(
            error instanceof DecisionFabricMalformedResponseError
              ? error
              : new DecisionFabricUnavailableError(
                  options.socketPath,
                  error?.message ?? "response stream ended without a body",
                  { cause: error ?? undefined },
                ),
          );
          return;
        }
        resolve({ status: response.statusCode ?? 0, body });
      });
    });
    request.end(payload);
  });
}

export function createDecisionFabricClient(
  options: DecisionFabricClientOptions,
): DecisionFabricClient {
  return {
    async decide(request: DecideRequest): Promise<DecideResponse> {
      const validated = DecideRequestSchema.safeParse(request);
      if (!validated.success) {
        throw new DecisionFabricInvalidRequestError(
          validated.error.issues.map((issue) => issue.message).join("; "),
        );
      }
      const { status, body } = await postJson(options, JSON.stringify(validated.data));
      if (status < 200 || status >= 300) {
        const parsed = parseDecideErrorBody(body);
        throw new DecisionFabricRequestError(
          status,
          parsed?.code ?? null,
          parsed?.message ?? body.slice(0, 500),
          parsed?.retryable ?? false,
        );
      }
      let json: unknown;
      try {
        json = JSON.parse(body);
      } catch {
        throw new DecisionFabricMalformedResponseError("response is not valid JSON");
      }
      const parsed = DecideResponseSchema.safeParse(json);
      if (!parsed.success) {
        throw new DecisionFabricMalformedResponseError(
          parsed.error.issues.map((issue) => issue.message).join("; "),
        );
      }
      if (parsed.data.policy_mode !== "SHADOW_ONLY") {
        throw new DecisionFabricMalformedResponseError(
          `unexpected policy_mode ${parsed.data.policy_mode}`,
        );
      }
      if (parsed.data.request_id !== request.request_id) {
        throw new DecisionFabricMalformedResponseError("response request_id does not echo ours");
      }
      return parsed.data;
    },
  };
}
