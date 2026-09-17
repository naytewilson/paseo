import { describe, expect, test } from "vitest";

import { redactSecrets } from "./redaction.js";

const REDACTED = "[REDACTED_SECRET]";

describe("redactSecrets", () => {
  test("redacts provider API tokens", () => {
    const input = [
      "key=sk-ant-api03-AbCdEfGhIjKlMnOp",
      "openai sk-1234567890abcdefghij",
      "ghp_abcdefghijklmnopqrstuvwxyz1234",
      "github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz0123456789",
      "glpat-AbCdEfGhIjKlMnOpQrSt",
      "xoxb-1234567890-abcdefghijkl",
      "AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz12345",
      "AKIAIOSFODNN7EXAMPLE",
    ].join("\n");
    const output = redactSecrets(input);
    expect(output).not.toContain("sk-ant-");
    expect(output).not.toContain("sk-1234567890");
    expect(output).not.toContain("ghp_");
    expect(output).not.toContain("github_pat_");
    expect(output).not.toContain("glpat-");
    expect(output).not.toContain("xoxb-");
    expect(output).not.toContain("AIza");
    expect(output).not.toContain("AKIA");
    expect(output).toContain(REDACTED);
  });

  test("redacts bearer and basic authorization headers", () => {
    expect(redactSecrets("Authorization: Bearer abcdef1234567890.token")).toBe(
      `Authorization: ${REDACTED}`,
    );
    expect(redactSecrets("authorization = Basic dXNlcjpwYXNz")).toContain(REDACTED);
  });

  test("redacts JWTs", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PLf7E2h3M4o5";
    expect(redactSecrets(`token: ${jwt}`)).toBe(`token: ${REDACTED}`);
  });

  test("redacts private key blocks", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEpAIBAAKCAQEA7Z",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    expect(redactSecrets(`before\n${pem}\nafter`)).toBe(`before\n${REDACTED}\nafter`);
  });

  test("redacts credential-bearing URLs but preserves the scheme", () => {
    expect(redactSecrets("fetch https://user:passw0rd@example.com/repo")).toBe(
      `fetch https://${REDACTED}@example.com/repo`,
    );
  });

  test("redacts shell-style secret assignments", () => {
    const input = "export ANTHROPIC_API_KEY=real-secret-value\nPASSWORD=hunter2\n";
    const output = redactSecrets(input);
    expect(output).toBe(`export ANTHROPIC_API_KEY=${REDACTED}\nPASSWORD=${REDACTED}\n`);
  });

  test("redacts JSON secret properties", () => {
    const input = '{"api_key": "sk-live-abc123", "name": "fine"}';
    const output = redactSecrets(input);
    expect(output).toBe(`{"api_key": "${REDACTED}", "name": "fine"}`);
  });

  test("redacts key:value secret pairs in prose", () => {
    const output = redactSecrets("the password: sup3rsecret-value here");
    expect(output).toBe(`the password: ${REDACTED} here`);
  });

  test("is deterministic and idempotent", () => {
    const input = "Authorization: Bearer abc123def456\nkey sk-ant-zzzzzzzzzz";
    const once = redactSecrets(input);
    expect(redactSecrets(input)).toBe(once);
    expect(redactSecrets(once)).toBe(once);
  });

  test("leaves ordinary text untouched", () => {
    const input = "implemented the feature and ran npm run typecheck";
    expect(redactSecrets(input)).toBe(input);
  });
});
