/**
 * `dsh-session-delete` — host half.
 *
 * The Harness persists one Session log per Session directory and ships no
 * deletion API (see `@deepseek-ai/dsh-session-persistence-jsonl`: "Nothing
 * deletes session files"), so this plugin owns the missing capability: one
 * Remote method that permanently removes a stored Session's log directory.
 *
 * Deliberate shape:
 *
 * - Nothing here imports a `@deepseek-ai/*` package. A profile-linked bundle is
 *   loaded from outside the runtime tree, so this plugin depends only on Node
 *   built-ins and on the two Cordis/Gateway seams it talks to through `ctx`.
 * - The method is exposed through the visible `typertRemote` binding plus the
 *   versioned prototype marker. That is exactly what the Gateway's source-mode
 *   discovery reads (`remoteMethods()` and the `typertRemote` field) when no
 *   generated strict descriptor exists for the endpoint, so no build step is
 *   involved.
 *
 * @module dsh-session-delete
 */

import { rm, stat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'

/** Stable Cordis plugin name. */
export const name = 'session-delete'

/** Cordis service key and Typert wire namespace of the delete capability. */
const SERVICE_KEY = 'sessionDelete'
const NAMESPACE = 'sessionDelete'

/** Exported Remote method name (also the prototype method it marks).
*
* It must not shadow a member of the Client's namespace service: that service
* already carries `ctx`, `empty`, `invokeRemote`, `methods`, `name`,
* `namespace`, `has`, `install`, `installDirect`, `installScoped`,
* `assertMethodAvailable`, and `remove`, and the Client rejects a contribution
* whose method collides with one of them. */
const METHOD = 'deleteSession'

/** Versioned Remote-marker descriptor property, shared with the protocol package. */
const REMOTE_METHODS_KEY = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/** Canonical stored-log filename of the JSONL backend (`session.v4.jsonl.zstd`). */
const LOG_FILENAME = /^session\.v\d+\.jsonl\.zstd$/u

/** Universal carrier failure codes reused for this domain's refusals. */
const BAD_REQUEST = 'gateway/bad-request'
const INTERNAL = 'gateway/internal'
/** Domain code the Client turns into its own "still running" wording. */
const BUSY = 'session-delete/busy'

/**
 * Build one Remote failure that survives the wire.
 *
 * The protocol package identifies failures structurally (an `isDSHRemoteError`
 * marker plus a `code`), never by prototype identity, so a plain Error carrying
 * the same marker crosses the Gateway unchanged without importing the class.
 * @param code - stable failure code the Client discriminates on.
 * @param message - human diagnostic.
 * @param details - structured payload for the code.
 * @returns the throwable failure.
 */
function remoteFailure(code, message, details) {
	const error = new Error(message)
	error.name = 'RemoteError'
	error.isDSHRemoteError = true
	error.code = code
	error.details = details ?? {}
	return error
}

/** Whether a caught filesystem error means the path is simply absent. */
function isMissing(error) {
	return typeof error === 'object' && error !== null && error.code === 'ENOENT'
}

/**
 * Encode one Session id as the single path segment the JSONL backend owns.
 *
 * Mirrors that backend's `encodeSegment`: safe code units stay literal, every
 * other code unit becomes `~XXXX`, and `.`/`..` are escaped so a whole segment
 * can never traverse. It is reproduced here so the guard below can prove that a
 * resolved log path really belongs to the requested Session instead of trusting
 * a path handed to us.
 * @param raw - non-empty Session id.
 * @returns the escaped path segment.
 */
function encodeSegment(raw) {
	if (raw === '.') return '~002E'
	if (raw === '..') return '~002E~002E'
	let out = ''
	for (let index = 0; index < raw.length; index += 1) {
		const code = raw.charCodeAt(index)
		const char = String.fromCharCode(code)
		out += char !== '~' && /^[A-Za-z0-9._-]$/u.test(char)
			? char
			: `~${code.toString(16).toUpperCase().padStart(4, '0')}`
	}
	return out
}

/** Render the running-work families one refusal reported, for the diagnostic. */
function activitySummary(activity) {
	const kinds = []
	for (const entry of activity) {
		const kind = typeof entry?.kind === 'string' ? entry.kind : 'work'
		if (!kinds.includes(kind)) kinds.push(kind)
	}
	return kinds.length === 0 ? 'unknown work' : kinds.join(', ')
}

/**
 * The Host service behind the `sessionDelete` Remote namespace.
 *
 * It holds no state: every call resolves the Session's durable location from
 * `sessionPersistence` at that moment, which keeps the operation correct after
 * a restart, a store switch, or another writer's activity.
 */
class SessionDeleteService {
	/** @param ctx - Host Context carrying the Session and persistence services. */
	constructor(ctx) {
		this.ctx = ctx
	}

	/**
	 * Permanently delete one stored Session.
	 *
	 * Refuses while the Session still reports running work: a live writer would
	 * append to the path this call is about to remove and recreate the artifact
	 * without its header. The browser half stops offering the row once the call
	 * resolves, so an idle Session has no reachable appender left.
	 * @param request - `{ sessionId }` wire payload.
	 * @returns the outcome: `{ deleted: true }`, or `deleted: false` with the
	 *   reason `unknown` (no stored Session) or `unmaterialized` (a Session the
	 *   process holds in memory but never wrote to disk).
	 */
	async deleteSession(request) {
		const sessionId = readSessionId(request)
		const activity = await this.runningActivity(sessionId)
		if (activity.length > 0) {
			throw remoteFailure(
				BUSY,
				`session "${sessionId}" still has running work (${activitySummary(activity)}); stop it before deleting`,
				{ sessionId, activity },
			)
		}
		const persistence = this.ctx.get('sessionPersistence')
		if (persistence === undefined || typeof persistence.list !== 'function') {
			throw remoteFailure(INTERNAL, 'session persistence is unavailable, so nothing can be deleted', { sessionId })
		}
		const stored = await findStored(persistence, sessionId)
		if (stored === undefined) return { deleted: false, reason: 'unknown' }
		const directory = resolveSessionDirectory(persistence, stored, sessionId)
		if (!await pathExists(directory)) return { deleted: false, reason: 'unmaterialized' }
		await rm(directory, { recursive: true, force: true })
		if (await pathExists(directory)) {
			throw remoteFailure(INTERNAL, `the session directory survived deletion: ${directory}`, { sessionId, directory })
		}
		return { deleted: true, directory }
	}

	/**
	 * Ask the composed providers what still runs for one Session.
	 *
	 * This is the same waterfall `workspaceRegistry.archiveSession` consults, so
	 * the families it reports (running turn, owned jobs, subagents, schedules)
	 * match the Harness's own definition of "in use".
	 * @param sessionId - Session under inspection.
	 * @returns reported activity families; empty when nothing runs.
	 */
	async runningActivity(sessionId) {
		const ctx = this.ctx
		if (typeof ctx.waterfall !== 'function') return []
		const activity = await ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
		return Array.isArray(activity) ? activity : []
	}
}

/**
 * Read the Session id from one wire payload.
 * @param request - wire payload; a `src-json` parameter may arrive undefined.
 * @returns the validated Session id.
 * @throws a bad-request failure for a malformed payload.
 */
function readSessionId(request) {
	const sessionId = typeof request === 'object' && request !== null ? request.sessionId : undefined
	if (typeof sessionId !== 'string' || sessionId.trim() === '') {
		throw remoteFailure(BAD_REQUEST, 'sessionDelete.deleteSession requires a non-blank sessionId', {})
	}
	if (sessionId === '.' || sessionId === '..') {
		throw remoteFailure(BAD_REQUEST, `refusing the reserved session id "${sessionId}"`, { sessionId })
	}
	return sessionId
}

/**
 * Find one stored Session snapshot in the persistence listing.
 * @param persistence - the `sessionPersistence` service.
 * @param sessionId - Session to find.
 * @returns the snapshot, or undefined when persistence holds no such Session.
 */
async function findStored(persistence, sessionId) {
	const snapshots = await persistence.list()
	for (const snapshot of snapshots) if (snapshot?.header?.id === sessionId) return snapshot
	return undefined
}

/**
 * Resolve the directory that belongs to one stored Session.
 *
 * The backend's own `locate()` owns the path computation, and the guard below
 * still proves the result belongs to the requested id: the directory name must
 * be that id's encoded segment and the file inside it must be a canonical log
 * generation. A path that fails either check is refused rather than deleted.
 * @param persistence - the `sessionPersistence` service.
 * @param snapshot - listing entry for the Session.
 * @param sessionId - requested Session id.
 * @returns the absolute Session directory.
 * @throws an internal failure when the backend cannot locate the Session.
 */
function resolveSessionDirectory(persistence, snapshot, sessionId) {
	const located = typeof persistence.locate === 'function' ? persistence.locate(snapshot.header) : undefined
	const logPath = typeof located?.path === 'string' ? located.path : undefined
	if (logPath === undefined || !LOG_FILENAME.test(basename(logPath))) {
		throw remoteFailure(INTERNAL, `cannot resolve the stored log of session "${sessionId}"`, { sessionId })
	}
	const directory = dirname(logPath)
	if (basename(directory) !== encodeSegment(sessionId)) {
		throw remoteFailure(INTERNAL, `refusing to delete "${directory}": it is not the directory of session "${sessionId}"`, { sessionId, directory })
	}
	return directory
}

/**
 * Test one path's existence without throwing.
 * @param path - absolute path to test.
 * @returns whether the path exists.
 */
async function pathExists(path) {
	try {
		await stat(path)
		return true
	} catch (error) {
		if (isMissing(error)) return false
		throw error
	}
}

/**
 * Mark one public instance method as a Remote export.
 *
 * This writes the protocol's versioned prototype descriptor directly, which is
 * the same record `@Remote` schedules an initializer to write, and which the
 * Gateway's source-mode discovery reads for a plugin that ships no generated
 * strict descriptor.
 */
Object.defineProperty(SessionDeleteService.prototype, REMOTE_METHODS_KEY, {
	configurable: true,
	value: Object.freeze({
		version: 1,
		methods: Object.freeze([
			Object.freeze({ method: METHOD, invocation: Object.freeze({ kind: 'direct' }) }),
		]),
	}),
})

/**
 * Register the delete capability into the Host tree.
 * @param ctx - the plugin's Cordis Context.
 */
export function apply(ctx) {
	const service = new SessionDeleteService(ctx)
	// The Gateway resolves a source-mode endpoint by matching `typertRemote`
	// against a service in the tree, so the binding must name the receiver and
	// the Cordis service key it is published under.
	service.typertRemote = Object.freeze({ service, serviceKey: SERVICE_KEY, namespace: NAMESPACE })
	ctx.provide(SERVICE_KEY, service)
}

/** Test hooks: the pieces worth exercising without a composed runtime. */
export const internals = {
	SessionDeleteService,
	encodeSegment,
	readSessionId,
	resolveSessionDirectory,
}
