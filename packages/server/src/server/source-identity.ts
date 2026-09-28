import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Source identity is embedded by the maintained package builder. */
export function resolveSourceIdentity(): string | null {
  let current = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = path.join(current, "source-identity.json");
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { sourceCommit?: unknown };
        return typeof parsed.sourceCommit === "string" && /^[0-9a-f]{40}$/.test(parsed.sourceCommit)
          ? parsed.sourceCommit
          : null;
      } catch {
        return null;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
