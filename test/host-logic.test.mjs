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

function fakeContext({ activity = [], snapshots, locate }) {
  const persistence = {
    list: async () => snapshots(),
    locate: (header) => locate(header),
  }
  return {
    get: (key) => (key === 'sessionPersistence' ? persistence : undefined),
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

await rm(root, { recursive: true, force: true })
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
