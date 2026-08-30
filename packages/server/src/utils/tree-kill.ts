import treeKill from "tree-kill";

export interface TreeKillTarget {
  pid?: number;
  /** POSIX process group that owns this provider tree, if one was created. */
  processGroupId?: number | null;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once?(event: "exit", listener: () => void): unknown;
}

export interface TerminateWithTreeKillOptions {
  gracefulSignal?: NodeJS.Signals;
  forceSignal?: NodeJS.Signals;
  gracefulTimeoutMs: number;
  forceTimeoutMs?: number;
  onForceSignal?: () => void;
}

export type TerminateWithTreeKillResult =
  | "already-exited"
  | "terminated"
  | "killed"
  | "kill-timeout";

// Injection seam: production wires terminateWithTreeKill; tests wire a fake that
// records which children were terminated as observable state.
export type ProcessTerminator = (
  child: TreeKillTarget,
  options: TerminateWithTreeKillOptions,
) => Promise<TerminateWithTreeKillResult>;

export async function terminateWithTreeKill(
  child: TreeKillTarget,
  options: TerminateWithTreeKillOptions,
): Promise<TerminateWithTreeKillResult> {
  const processGroupId = getOwnedProcessGroupId(child);
  if (isProcessExited(child) && !isProcessGroupAlive(processGroupId)) {
    return "already-exited";
  }

  const exitPromise = waitForTargetExit(child, processGroupId);
  await signalProcessTree(child, options.gracefulSignal ?? "SIGTERM");
  if (await waitForExitOrTimeout(exitPromise, options.gracefulTimeoutMs)) {
    return "terminated";
  }

  options.onForceSignal?.();
  await signalProcessTree(child, options.forceSignal ?? "SIGKILL");
  if (options.forceTimeoutMs === undefined) {
    return "killed";
  }
  return (await waitForExitOrTimeout(exitPromise, options.forceTimeoutMs))
    ? "killed"
    : "kill-timeout";
}

export function signalProcessTree(child: TreeKillTarget, signal: NodeJS.Signals): Promise<void> {
  const processGroupId = getOwnedProcessGroupId(child);
  if (processGroupId !== null) {
    signalProcessGroup(child, processGroupId, signal);
    return Promise.resolve();
  }

  if (isProcessExited(child)) {
    return Promise.resolve();
  }

  const pid = child.pid;
  if (typeof pid !== "number" || pid <= 0) {
    signalDirectChild(child, signal);
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    treeKill(pid, signal, (error) => {
      if (error) {
        signalDirectChild(child, signal);
      }
      resolve();
    });
  });
}

function signalProcessGroup(
  child: TreeKillTarget,
  processGroupId: number,
  signal: NodeJS.Signals,
): void {
  try {
    process.kill(-processGroupId, signal);
  } catch {
    // The group may have disappeared between inspection and signalling. If the
    // launcher is still alive, retain the direct-child fallback.
    if (!isProcessExited(child)) {
      signalDirectChild(child, signal);
    }
  }
}

function signalDirectChild(child: TreeKillTarget, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // Ignore cleanup races.
  }
}

function isProcessExited(child: TreeKillTarget): boolean {
  return (
    (child.exitCode !== null && child.exitCode !== undefined) ||
    (child.signalCode !== null && child.signalCode !== undefined)
  );
}

function waitForProcessExit(child: TreeKillTarget): Promise<void> {
  if (isProcessExited(child)) {
    return Promise.resolve();
  }
  if (!child.once) {
    return new Promise(() => undefined);
  }

  return new Promise((resolve) => {
    child.once?.("exit", resolve);
  });
}

function waitForTargetExit(child: TreeKillTarget, processGroupId: number | null): Promise<void> {
  if (processGroupId === null) {
    return waitForProcessExit(child);
  }
  return waitForProcessGroupExit(processGroupId);
}

function waitForProcessGroupExit(processGroupId: number): Promise<void> {
  if (!isProcessGroupAlive(processGroupId)) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const poll = (): void => {
      if (!isProcessGroupAlive(processGroupId)) {
        resolve();
        return;
      }
      const timer = setTimeout(poll, 50);
      timer.unref();
    };
    poll();
  });
}

function getOwnedProcessGroupId(child: TreeKillTarget): number | null {
  if (process.platform === "win32") {
    return null;
  }
  const processGroupId = child.processGroupId;
  return typeof processGroupId === "number" &&
    Number.isInteger(processGroupId) &&
    processGroupId > 0
    ? processGroupId
    : null;
}

export function isProcessGroupAlive(processGroupId: number | null | undefined): boolean {
  if (
    process.platform === "win32" ||
    typeof processGroupId !== "number" ||
    !Number.isInteger(processGroupId) ||
    processGroupId <= 0
  ) {
    return false;
  }

  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return (
      error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EPERM"
    );
  }
}

async function waitForExitOrTimeout(
  exitPromise: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      exitPromise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
