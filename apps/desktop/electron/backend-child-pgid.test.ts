import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

import { test } from 'vitest'

import { type KillableChild, readProcessGroupId, stopBackendChild } from './backend-child'

/**
 * Regression: the desktop spawns its backend with start_new_session(), which
 * gives the child its own SESSION but leaves it in Electron's process GROUP
 * (pgid == Electron PID). The old teardown assumed pgid == pid and sent
 * `kill(-pid)`, which always raised ESRCH, so the fallback signalled only the
 * direct child. `stopBackendChild` must never signal a group it does not own.
 */

function fakeChild(pid: number) {
  const killed: NodeJS.Signals[] = []

  return {
    killed,
    child: {
      pid,
      killed: false,
      kill: (signal: NodeJS.Signals): void => {
        killed.push(signal)
      }
    } satisfies KillableChild
  }
}

test('a child that is not its own group leader is signalled directly, never via -pid', () => {
  const { killed, child } = fakeChild(4242)
  const groupSignals: Array<[number, string]> = []
  const windowsCalls: number[] = []

  stopBackendChild(child, {
    isWindows: false,
    forceKillProcessTree: pid => windowsCalls.push(pid),
    killGroup: (pgid, signal) => groupSignals.push([pgid, signal]),
    // Real-world desktop layout: the child sits in Electron's group.
    resolvePgid: () => 4240
  })

  assert.deepEqual(groupSignals, [], 'never signals a group the backend does not own')
  assert.deepEqual(killed, ['SIGTERM'])
  assert.deepEqual(windowsCalls, [])
})

test('pgid 0 is never signalled (the kernel would read it as "caller group" = Electron)', () => {
  const { killed, child } = fakeChild(4343)
  const groupSignals: Array<[number, string]> = []

  stopBackendChild(child, {
    isWindows: false,
    forceKillProcessTree: () => {},
    killGroup: (pgid, signal) => groupSignals.push([pgid, signal]),
    resolvePgid: () => 0
  })

  assert.deepEqual(groupSignals, [])
  assert.deepEqual(killed, ['SIGTERM'])
})

test('a child that IS its own group leader still gets the whole-group signal', () => {
  const { killed, child } = fakeChild(5252)
  const groupSignals: Array<[number, string]> = []

  stopBackendChild(child, {
    isWindows: false,
    forceKillProcessTree: () => {},
    killGroup: (pgid, signal) => groupSignals.push([pgid, signal]),
    resolvePgid: pid => pid
  })

  assert.deepEqual(groupSignals, [[-5252, 'SIGTERM']])
  assert.deepEqual(killed, [], 'the group signal already covers the child')
})

test('an unresolvable PGID falls back to the direct child instead of guessing', () => {
  const { killed, child } = fakeChild(6262)
  const groupSignals: Array<[number, string]> = []

  stopBackendChild(child, {
    isWindows: false,
    forceKillProcessTree: () => {},
    killGroup: (pgid, signal) => groupSignals.push([pgid, signal]),
    resolvePgid: () => null
  })

  assert.deepEqual(groupSignals, [])
  assert.deepEqual(killed, ['SIGTERM'])
})

test('a throwing PGID probe does not break teardown', () => {
  const { killed, child } = fakeChild(7272)

  stopBackendChild(child, {
    isWindows: false,
    forceKillProcessTree: () => {},
    killGroup: () => {},
    resolvePgid: () => {
      throw new Error('EACCES')
    }
  })

  assert.deepEqual(killed, ['SIGTERM'])
})

test('Windows still tree-kills and never probes POSIX process groups', () => {
  const { killed, child } = fakeChild(8282)
  const windowsCalls: number[] = []
  let probed = false

  stopBackendChild(child, {
    isWindows: true,
    forceKillProcessTree: pid => windowsCalls.push(pid),
    resolvePgid: () => {
      probed = true

      return null
    }
  })

  assert.deepEqual(windowsCalls, [8282])
  assert.deepEqual(killed, [])
  assert.equal(probed, false)
})

test.skipIf(process.platform !== 'linux')(
  'readProcessGroupId reports the PGID the desktop spawn actually produces',
  async (): Promise<void> => {
    // Two shapes, both real: a plain spawn (what the desktop does — child
    // inherits Electron's process group) and detached (own session AND own
    // group). argv0 carries a space and parentheses so the /proc/<pid>/stat
    // column walk is exercised against a hostile comm field.
    const shapes: Array<{ detached: boolean }> = [{ detached: false }, { detached: true }]

    for (const shape of shapes) {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: shape.detached,
        stdio: 'ignore',
        argv0: 'backend (mcp)'
      })

      try {
        await once(child, 'spawn')

        const pgid = readProcessGroupId(child.pid as number)

        assert.equal(typeof pgid, 'number', `PGID must resolve (detached=${shape.detached})`)
        assert.ok((pgid as number) > 0)

        if (shape.detached) {
          assert.equal(pgid, child.pid, 'detached child leads its own group')
        } else {
          assert.notEqual(
            pgid,
            child.pid,
            'non-detached child inherits the parent group — this is the case that broke -pid'
          )
          assert.equal(pgid, readProcessGroupId(process.pid), 'same group as the spawner')
        }
      } finally {
        child.kill('SIGKILL')

        if (child.exitCode === null && child.signalCode === null) {
          await once(child, 'exit')
        }
      }
    }
  }
)

test('readProcessGroupId returns null for a process that does not exist', () => {
  assert.equal(readProcessGroupId(2 ** 22 + 1), null)
})
