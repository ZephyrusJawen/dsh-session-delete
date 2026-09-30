// Host-half behaviour without a composed runtime: a real filesystem with
// stubbed persistence and activity seams.
//
// This file needs nothing beyond the Node runtime.
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { internals } from '../lib/index.js'

const { SessionDeleteService, encodeSegment, resolveSessionDirectory } = internals

let failures = 0
function check(label, condition, extra = '') {
  const mark = condition ? 'PASS' : 'FAIL'
  if (!condition) failures += 1
  console.log(`${mark}  ${label}${extra ? ` :: ${extra}` : ''}`)
}

const root = await mkdtemp(join(tmpdir(), 'dsh-session-delete-test-'))
const cwd = 'C:\\Users\\test\\workspace'
const projectKey = '--C-Users-test-workspace--'
const sessionId = 'session-11111111-2222-3333-4444-555555555555'
const sessionDir = join(root, projectKey, encodeSegment(sessionId))
const logPath = join(sessionDir, 'session.v4.jsonl.zstd')

/** A minimal `ctx.sessions` store double recording flush/detach calls. */
function fakeSessionsStore(sessions = []) {
  const store = {
    flushCalls: [],
    get: (id) => sessions.find((session) => session.id === id),
    list: () => [...sessions],
    flush: async (session) => {
      store.flushCalls.push(session.id)
      return true
    },
    liveEntryFor: (session) => {
      const entry = session.__entry
      if (entry === undefined) throw new Error('no live entry')
      return entry
    },
    detachEntered: (entry) => {
      entry.detached = true
      const index = sessions.indexOf(entry.session)
      if (index !== -1) sessions.splice(index, 1)
    },
  }
  return store
}

/** A minimal `ctx.workspaceRegistry` double with one workspace and global sets. */
function fakeRegistry({ archived = [], pinned = [], sessionIds = [] } = {}) {
  const calls = []
  const workspace = {
    id: 'workspace-1',
    path: cwd,
    sessionIds: [...sessionIds],
    detachSession: async (id) => {
      calls.push(['detach', workspace.id, id])
      const index = workspace.sessionIds.indexOf(id)
      if (index !== -1) workspace.sessionIds.splice(index, 1)
    },
  }
  return {
    calls,
    workspace,
    archivedSessionIds: archived,
    pinnedSessionIds: pinned,
    unarchiveSession: async (id) => {
      calls.push(['unarchive', id])
      const index = archived.indexOf(id)
      if (index !== -1) archived.splice(index, 1)
    },
    unpinSession: async (id) => {
      calls.push(['unpin', id])
      const index = pinned.indexOf(id)
      if (index !== -1) pinned.splice(index, 1)
    },
    list: () => [workspace],
  }
}

/** One live session object with its store entry. */
function fakeLiveSession(id, { announcing = false, appending = false } = {}) {
  const session = { id }
  session.__entry = { session, announcing, appending, detached: false }
  return session
}

function fakeContext({ activity = [], snapshots, locate, sessions, registry }) {
  const persistence = {
    list: async () => snapshots(),
    locate: (header) => locate(header),
  }
  return {
    get: (key) => (
      key === 'sessionPersistence' ? persistence
        : key === 'sessions' ? sessions
          : key === 'workspaceRegistry' ? registry
            : undefined
    ),
    waterfall: async () => activity,
    logger: { warn: () => {}, error: () => {} },
  }
}

function serviceFor(options) {
  return new SessionDeleteService(fakeContext(options))
}

// --- 1. a materialized stored session is removed ----------------------------
await mkdir(sessionDir, { recursive: true })
await writeFile(logPath, 'header\n')
{
  const snapshots = [{ header: { id: sessionId, cwd }, revision: 'r1' }]
  const service = serviceFor({
    snapshots: () => snapshots,
    locate: () => ({ kind: 'jsonl', path: logPath }),
  })
  const outcome = await service.deleteSession({ sessionId })
  check('deletes a materialized session', outcome.deleted === true, JSON.stringify(outcome))
  let gone = false
  try { await stat(sessionDir) } catch { gone = true }
  check('session directory is gone', gone)
}

// --- 2. running work refuses ------------------------------------------------
{
  const snapshots = [{ header: { id: sessionId, cwd } }]
  const service = serviceFor({
    activity: [{ kind: 'turn', items: [] }],
    snapshots: () => snapshots,
    locate: () => ({ kind: 'jsonl', path: logPath }),
  })
  let failure
  try { await service.deleteSession({ sessionId }) } catch (error) { failure = error }
  check('refuses while work runs', failure?.code === 'session-delete/busy', String(failure?.code))
  check('failure is a structural RemoteError', failure?.isDSHRemoteError === true)
}

// --- 3. an unknown session is not an error ----------------------------------
{
  const service = serviceFor({ snapshots: () => [], locate: () => undefined })
  const outcome = await service.deleteSession({ sessionId })
  check('unknown session reports a miss', outcome.deleted === false && outcome.reason === 'unknown', JSON.stringify(outcome))
}

// --- 4. an unmaterialized session reports without deleting ------------------
{
  const snapshots = [{ header: { id: sessionId, cwd } }]
  const service = serviceFor({
    snapshots: () => snapshots,
    locate: () => ({ kind: 'jsonl', path: logPath }),
  })
  const outcome = await service.deleteSession({ sessionId })
  check('unmaterialized session reports a miss', outcome.deleted === false && outcome.reason === 'unmaterialized', JSON.stringify(outcome))
}

// --- 5. a foreign directory is refused, never deleted -----------------------
{
  const foreign = join(root, projectKey, 'some-other-session')
  await mkdir(foreign, { recursive: true })
  await writeFile(join(foreign, 'session.v4.jsonl.zstd'), 'x\n')
  const snapshots = [{ header: { id: sessionId, cwd } }]
  const service = serviceFor({
    snapshots: () => snapshots,
    locate: () => ({ kind: 'jsonl', path: join(foreign, 'session.v4.jsonl.zstd') }),
  })
  let failure
  try { await service.deleteSession({ sessionId }) } catch (error) { failure = error }
  check('refuses a foreign directory', failure !== undefined && /not the directory of session/u.test(failure.message), failure?.message)
  check('foreign directory survived', (await stat(foreign)).isDirectory())
}

// --- 6. guards on the resolved location shape -------------------------------
{
  let nonLog
  try {
    resolveSessionDirectory({ locate: () => ({ path: join(root, projectKey, encodeSegment(sessionId), 'notes.txt') }) }, { header: { id: sessionId } }, sessionId)
  } catch (error) { nonLog = error }
  check('refuses a non-log filename', nonLog !== undefined, nonLog?.message)

  let missingLocate
  try {
    resolveSessionDirectory({}, { header: { id: sessionId } }, sessionId)
  } catch (error) { missingLocate = error }
  check('refuses an unlocatable session', missingLocate !== undefined, missingLocate?.message)

  const ok = resolveSessionDirectory({ locate: () => ({ path: logPath }) }, { header: { id: sessionId } }, sessionId)
  check('accepts the canonical directory', basename(ok) === encodeSegment(sessionId), ok)
}

// --- 7. malformed payloads --------------------------------------------------
{
  const service = serviceFor({ snapshots: () => [], locate: () => undefined })
  for (const payload of [undefined, {}, { sessionId: '' }, { sessionId: 42 }, { sessionId: '..' }]) {
    let failure
    try { await service.deleteSession(payload) } catch (error) { failure = error }
    check(`refuses payload ${JSON.stringify(payload)}`, failure?.code === 'gateway/bad-request', String(failure?.code))
  }
}

// --- 8. a live session is detached from the store and ledger ---------------
{
  const liveId = 'session-99999999-8888-7777-6666-555555555555'
  const liveDir = join(root, projectKey, encodeSegment(liveId))
  await mkdir(liveDir, { recursive: true })
  await writeFile(join(liveDir, 'session.v4.jsonl.zstd'), 'header\n')
  const live = fakeLiveSession(liveId)
  const sessions = [live]
  const store = fakeSessionsStore(sessions)
  const registry = fakeRegistry({ archived: [liveId], pinned: [], sessionIds: [liveId] })
  const service = serviceFor({
    sessions: store,
    registry,
    snapshots: () => [{ header: { id: liveId, cwd }, revision: 'r1' }],
    locate: () => ({ kind: 'jsonl', path: join(liveDir, 'session.v4.jsonl.zstd') }),
  })
  const outcome = await service.deleteSession({ sessionId: liveId })
  check('live session: log removed', outcome.deleted === true, JSON.stringify(outcome))
  let gone = false
  try { await stat(liveDir) } catch { gone = true }
  check('live session: directory is gone', gone)
  check('live session: pending writes flushed first', store.flushCalls.length === 1 && store.flushCalls[0] === liveId)
  check('live session: detached from store', sessions.length === 0)
  check('live session: entry marked detached', live.__entry.detached === true)
  check('live session: unarchived', registry.archivedSessionIds.length === 0)
  check('live session: dropped from workspace account', registry.workspace.sessionIds.length === 0)
  const ledgerOps = registry.calls.map((call) => call[0])
  check('live session: ledger ops ran before removal', ledgerOps.includes('unarchive') && ledgerOps.includes('detach'))
}

// --- 9. a live-only session is deleted without any disk log -----------------
{
  const liveOnly = 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const sessions = [fakeLiveSession(liveOnly)]
  const store = fakeSessionsStore(sessions)
  const registry = fakeRegistry({ sessionIds: [liveOnly] })
  const service = serviceFor({
    sessions: store,
    registry,
    snapshots: () => [],
    locate: () => undefined,
  })
  const outcome = await service.deleteSession({ sessionId: liveOnly })
  check('live-only session reports deleted', outcome.deleted === true && outcome.unmaterialized === true, JSON.stringify(outcome))
  check('live-only session: detached from store', sessions.length === 0)
  check('live-only session: dropped from workspace account', registry.workspace.sessionIds.length === 0)
}

// --- 10. a mid-append live session refuses and stays attached ---------------
{
  const busyId = 'session-11112222-3333-4444-5555-666677778888'
  const session = fakeLiveSession(busyId, { appending: true })
  const sessions = [session]
  const store = fakeSessionsStore(sessions)
  const registry = fakeRegistry({ sessionIds: [busyId] })
  const service = serviceFor({
    sessions: store,
    registry,
    snapshots: () => [],
    locate: () => undefined,
  })
  let failure
  try { await service.deleteSession({ sessionId: busyId }) } catch (error) { failure = error }
  check('mid-append session refuses', failure?.code === 'session-delete/busy', String(failure?.code))
  check('mid-append session stays attached', sessions.length === 1 && session.__entry.detached === false)
  check('mid-append session: nothing flushed', store.flushCalls.length === 0)
  check('mid-append session: ledger untouched', registry.calls.length === 0 && registry.workspace.sessionIds.length === 1)
}

await rm(root, { recursive: true, force: true })
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
