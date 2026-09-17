const REDACTED = "[REDACTED_SECRET]";

const SENSITIVE_NAME =
  "(?:api[_-]?key|access[_-]?key|secret[_-]?key|secret|token|password|passwd|credential|private[_-]?key|client[_-]?secret|auth[_-]?token|session[_-]?key)";

const PROVIDER_TOKEN_PATTERN = new RegExp(
  [
    "sk-ant-[A-Za-z0-9_-]{8,}",
    "sk-[A-Za-z0-9_-]{12,}",
    "gh[opsur]_[A-Za-z0-9]{16,}",
    "github_pat_[A-Za-z0-9_]{20,}",
    "glpat-[A-Za-z0-9_-]{16,}",
    "xox[baprs]-[A-Za-z0-9-]{8,}",
    "AIza[0-9A-Za-z_-]{20,}",
    "AKIA[0-9A-Z]{16}",
    "\\d{8,10}:[A-Za-z0-9_-]{30,}",
  ].join("|"),
  "g",
);

const REDACTION_RULES: Array<[RegExp, string]> = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/g,
    REDACTED,
  ],
  [/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=._~-]{8,}/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g, REDACTED],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, `$1${REDACTED}@`],
  [
    new RegExp(
      `(\\b[A-Z0-9_]*${SENSITIVE_NAME}[A-Z0-9_]*\\b\\s*(?:export\\s+)?=\\s*)(?:"[^"]*"|'[^']*'|[^\\s"']+)`,
      "gi",
    ),
    `$1${REDACTED}`,
  ],
  [new RegExp(`("[^"]*${SENSITIVE_NAME}[^"]*"\\s*:\\s*)"([^"]*)"`, "gi"), `$1"${REDACTED}"`],
  [
    new RegExp(`(\\b${SENSITIVE_NAME}\\b\\s*[:=]\\s*)(?:"[^"]*"|'[^']*'|[^\\s,"']{4,})`, "gi"),
    `$1${REDACTED}`,
  ],
  [PROVIDER_TOKEN_PATTERN, REDACTED],
];

/**
 * Deterministic pre-egress secret redaction for provider-bound trace text.
 * Anything resembling a credential is replaced with a fixed marker so redacted
 * output stays byte-stable across runs.
 */
export function redactSecrets(text: string): string {
  let result = text;
  for (const [pattern, replacement] of REDACTION_RULES) {
    result = result.replace(pattern, replacement);
  }
  return result;
}
