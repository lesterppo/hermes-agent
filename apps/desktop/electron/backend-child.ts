/**
 * backend-child.ts
 *
 * Windows-aware teardown for the desktop's managed backend child process.
 *
 * Node's `child.kill()` only signals the direct child. On Windows a backend
 * that spawned its own grandchildren (a `hermes` REPL, a pty terminal
 * session, the gateway) survives a plain SIGTERM and keeps files (e.g. the
 * venv shim) locked. So on Windows we tree-kill via `forceKillProcessTree`.
 *
 * On POSIX the backend gets its own SESSION (start_new_session=True) but NOT
 * its own process GROUP: libuv keeps the child in the parent's group, so
 * pgid == the Electron PID while sid == the child PID. `process.kill(-pid)`
 * therefore targets a group that does not exist — it throws ESRCH, and the
 * fallback only signals the direct child, orphaning the backend's MCP
 * grandchildren (observed: a dead desktop's backend kept holding its port).
 * We resolve the child's real PGID and only signal it when it is unambiguously
 * the child's own group; otherwise we signal the child and let its
 * parent-death/shutdown path reap the grandchildren. Signalling the parent's
 * group would SIGTERM Electron itself.
 *
 * Extracted into its own dependency-free module (no electron import) so the
 * tree-kill / group-kill branching can be asserted directly with a fake child
 * object and spy kill functions, instead of grepping main.ts source text for
 * the function body.
 */

import { readFileSync } from 'node:fs'

export interface StopBackendChildDeps {
  /** Defaults to the real platform check; injectable for tests. */
  isWindows?: boolean
  /** Windows tree-kill implementation (real: taskkill /T /F via execFileSync). */
  forceKillProcessTree: (pid: number) => void
  /**
   * POSIX group-signal implementation. Real: process.kill(-pgid, signal).
   * Injectable so the negative-pid group send is asserted in tests without a
   * live process group. Defaults to process.kill.
   */
  killGroup?: (pgid: number, signal: string) => void
  /**
   * Resolves a backend child's real process-group id (POSIX). Real: read the
   * PGID column of /proc/<pid>/stat. Injectable so tests do not depend on the
   * host's process table; a null/undefined result disables group signalling.
   */
  resolvePgid?: (pid: number) => number | null
}

/** The PGID that may be signalled for `child`, or null when it is not its own group. */
function signalableGroup(child: BackendProcessRoot, deps: StopBackendChildDeps): number | null {
  if (!Number.isInteger(child.pid) || (child.pid as number) <= 0) {
    return null
  }

  const pid = child.pid as number
  let pgid: number | null = null

  try {
    pgid = (deps.resolvePgid ?? readProcessGroupId)(pid)
  } catch {
    pgid = null
  }

  // Only the child's OWN group is safe: pgid 0 is the kernel's "caller's group"
  // wildcard and any other value belongs to Electron or a sibling — signalling
  // it would kill the desktop itself. A null/unknown PGID falls back to the
  // direct child.
  return pgid === pid ? pgid : null
}

/**
 * Read the PGID column (field 5) of /proc/<pid>/stat.
 *
 * The comm field (2) is parenthesised and may itself contain spaces and
 * parentheses ("python (backend)"), so the columns are counted from the LAST
 * ')' rather than by splitting the whole line.
 */
export function readProcessGroupId(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')

    // fields[0] is state (column 3), so pgrp (column 5) is fields[2].
    const pgrp = Number.parseInt(fields[2] ?? '', 10)

    return Number.isInteger(pgrp) && pgrp > 0 ? pgrp : null
  } catch {
    return null
  }
}

export interface BackendProcessRoot {
  pid?: number | null
}

export interface KillableChild extends BackendProcessRoot {
  killed?: boolean
  kill: (signal: NodeJS.Signals) => void
}

export interface WaitableChild extends KillableChild {
  exitCode: number | null
  signalCode: string | null
  once: (event: 'exit' | 'error', listener: () => void) => unknown
  removeListener: (event: 'exit' | 'error', listener: () => void) => unknown
}

/** Graceful exit, SIGKILL escalation, then a bounded wait for the escalation. */
export async function waitForBackendExit(
  child: WaitableChild | null | undefined,
  deps: StopBackendChildDeps,
  timeoutMs: number = 5000
): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return
  }

  const exited = (): boolean => child.exitCode !== null || child.signalCode !== null

  const wait = (delay: number): Promise<void> =>
    new Promise<void>((resolve: () => void): void => {
      if (exited()) {
        resolve()

        return
      }

      const finish = (): void => {
        clearTimeout(timer)
        child.removeListener('exit', finish)
        resolve()
      }

      const timer = setTimeout(finish, delay)
      child.once('exit', finish)
    })

  await wait(timeoutMs)

  if (exited()) {
    return
  }

  try {
    if ((deps.isWindows ?? process.platform === 'win32') && Number.isInteger(child.pid)) {
      deps.forceKillProcessTree(child.pid as number)
    } else {
      const group = signalableGroup(child, deps)

      if (group !== null) {
        const killGroup = deps.killGroup ?? ((pid: number, signal: string): boolean => process.kill(pid, signal))

        try {
          killGroup(-group, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      } else {
        child.kill('SIGKILL')
      }
    }
  } catch {
    // A failed signal may mean the child is gone, but only exit proves it.
  }

  await wait(1000)

  if (!exited()) {
    throw new Error(
      `Backend child${child.pid ? ` (PID ${child.pid})` : ''} did not exit after SIGKILL; retaining ownership.`
    )
  }
}

/**
 * Stop a managed child process, choosing the right strategy for the platform.
 * No-ops silently if `child` is falsy, already killed, or the kill attempt
 * throws (the process may already be gone) -- mirrors the original inline
 * best-effort semantics in main.ts.
 */
export function stopBackendChild(child: KillableChild | null | undefined, deps: StopBackendChildDeps): void {
  if (!child || child.killed) {
    return
  }

  const isWindows = deps.isWindows ?? process.platform === 'win32'
  const killGroup = deps.killGroup ?? ((pgid: number, signal: string): boolean => process.kill(pgid, signal))

  try {
    if (isWindows && Number.isInteger(child.pid)) {
      deps.forceKillProcessTree(child.pid as number)
    } else {
      const group = signalableGroup(child, deps)

      if (group !== null) {
        // POSIX: signal the child's OWN group so MCP grandchildren die too.
        try {
          killGroup(-group, 'SIGTERM')
        } catch {
          child.kill('SIGTERM')
        }
      } else {
        // Not a group leader (the usual Electron case: pgid == Electron PID).
        // Signal the child; its parent-death watchdog and shutdown path reap
        // the grandchildren. Never signal the parent's group — that is Electron.
        child.kill('SIGTERM')
      }
    }
  } catch {
    // Already gone.
  }
}
