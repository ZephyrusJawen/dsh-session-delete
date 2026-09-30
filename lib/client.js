/**
 * `dsh-session-delete` — browser half.
 *
 * One Session-row menu entry ("Delete session", after Archive) that opens a
 * confirmation dialog and then calls the Host's `sessionDelete/deleteSession`
 * Remote method. After a successful removal the Session list is re-pulled from the
 * Host so the row disappears, and the conversation view moves on when the
 * deleted Session was the one on screen.
 *
 * Deliberate shape:
 *
 * - The Host publishes no generated strict descriptor for this endpoint, so the
 *   contribution below is written by hand. Only parameters are declared strict
 *   (the Client requires it); the result stays `src-json` and therefore passes
 *   through the Host value unchanged.
 * - Nothing but the platform's own modules is required: React, the shared UI
 *   primitives, and nothing else.
 *
 * The modules row format is the framework's lazy-CJS bundle contract: running
 * this script only registers the factory, and its body runs at first
 * materialization.
 */
window.__ModuleLoader__.load({
	id: 'dsh-session-delete',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		const react = require('react')
		const { jsx, jsxs, Fragment } = require('react/jsx-runtime')
		const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

		/** Dictionary namespace owned by this plugin. */
		const NS = 'sessionDelete'
		/** The Session row's "..." menu and the shared overlay seat. */
		const MENU_SLOT = 'sidebar.workspaces.session.menu.item'
		const OVERLAY_SLOT = 'shell.overlay'
		/** Remote endpoint this plugin mounts on the Client. */
		const PACKAGE = 'dsh-session-delete'
		const SERVICE_KEY = 'sessionDelete'
		const NAMESPACE = 'sessionDelete'
		const METHOD = 'deleteSession'
		const ENDPOINT = `${NAMESPACE}/${METHOD}`
		/** Failure codes this page maps to its own wording. */
		const BUSY = 'session-delete/busy'
		const NOT_STORED = 'session-delete/not-stored'
		const NOT_MOUNTED = 'session-delete/not-mounted'
		/** Order seat after the built-in pin(100)/rename(200)/fork(300)/archive(400) rows. */
		const MENU_ORDER = 500

		const zh = {
			'menu.deleteSession': '删除会话',
			'delete.title': '删除会话',
			'delete.desc': '将永久删除会话「{title}」及其全部记录，此操作无法撤销。',
			'delete.running': '该会话仍有任务在运行，请先停止后再删除。',
			'delete.action': '删除',
			'delete.pending': '正在删除…',
			'delete.cancel': '取消',
			'delete.close': '关闭',
			'delete.notStored': '该会话尚未写入磁盘，没有可删除的记录。',
			'delete.unknown': '该会话已不存在。',
			'delete.notMounted': '删除能力未能加载（插件未挂载）。请查看控制台日志，或重启应用后重试。',
		}
		const en = {
			'menu.deleteSession': 'Delete session',
			'delete.title': 'Delete session',
			'delete.desc': 'Permanently delete "{title}" and all of its history. This cannot be undone.',
			'delete.running': 'This session still has running work. Stop it first, then delete.',
			'delete.action': 'Delete',
			'delete.pending': 'Deleting…',
			'delete.cancel': 'Cancel',
			'delete.close': 'Close',
			'delete.notStored': 'This session has no stored log yet, so there is nothing to delete.',
			'delete.unknown': 'This session no longer exists.',
			'delete.notMounted': 'The delete capability is not loaded (its plugin did not mount). Check the console log or restart the app.',
		}

		/**
		 * Client description of the Host method.
		 *
		 * The one parameter is marked strict because the Client refuses a
		 * contribution whose parameters carry no strict codec; its `create()`
		 * factory is never invoked on this path. The `src-json` result keeps the
		 * Host value as-is.
		 */
		const CONTRIBUTION = {
			package: PACKAGE,
			descriptors: [{
				id: `${PACKAGE}#${ENDPOINT}`,
				service: SERVICE_KEY,
				namespace: NAMESPACE,
				method: METHOD,
				invocation: { kind: 'direct' },
				parameters: [{
					name: 'request',
					wire: 'request',
					source: 'json',
					codec: {
						mode: 'strict',
						typeSymbol: `${PACKAGE}#${ENDPOINT}:request`,
						create: () => ({ parse: (value) => value }),
					},
				}],
				result: { mode: 'src-json' },
			}],
		}

		/**
		 * One observable value with the `getSnapshot`/`subscribe` pair the Slot
		 * hook binding expects, so injected entries can render pending requests
		 * without importing a store package.
		 * @param initial - the initial value.
		 * @returns the store.
		 */
		function createStore(initial) {
			let value = initial
			const listeners = new Set()
			return {
				getSnapshot: () => value,
				subscribe: (listener) => {
					listeners.add(listener)
					return () => { listeners.delete(listener) }
				},
				set: (next) => {
					value = next
					for (const listener of [...listeners]) listener()
				},
			}
		}

		/** The Session row menu row: opens the confirmation for one Session. */
		function DeleteSessionMenuItem({ sessionId, useMenuOpenState, t, requestDelete }) {
			const [, setMenuOpen] = useMenuOpenState()
			return jsx(primitives.MenuItemButton, {
				danger: true,
				icon: jsx(primitives.IconTrashOutlineRegular, { size: 14 }),
				onSelect: () => {
					setMenuOpen(false)
					requestDelete(sessionId)
				},
				children: t('menu.deleteSession'),
			})
		}

		/**
		 * The `shell.overlay` entry: nothing while no confirmation is pending,
		 * otherwise one dialog per request (keyed by the Session).
		 */
		function DeleteSessionConfirmDialog({ useDeleteRequest, settleDelete, confirmDelete, t }) {
			const request = useDeleteRequest((pending) => pending)
			if (request === null || request === undefined) return null
			return jsx(DeleteSessionConfirmForm, {
				request,
				settleDelete,
				confirmDelete,
				t,
			}, request.sessionId)
		}

		/** One request's dialog: in-flight and error state die with it. */
		function DeleteSessionConfirmForm({ request, settleDelete, confirmDelete, t }) {
			const [busy, setBusy] = react.useState(false)
			const [error, setError] = react.useState(null)
			const close = () => {
				if (busy) return
				settleDelete()
			}
			const confirm = () => {
				setBusy(true)
				setError(null)
				confirmDelete(request.sessionId).then(() => {
					setBusy(false)
					settleDelete()
				}, (reason) => {
					setBusy(false)
					setError(describeFailure(reason, t))
				})
			}
			return jsxs(primitives.Modal, {
				open: true,
				onClose: close,
				closeLabel: t('delete.close'),
				title: t('delete.title'),
				description: t('delete.desc', { title: request.displayTitle }),
				footer: jsxs(Fragment, { children: [
					jsx(primitives.Button, {
						variant: 'outline',
						disabled: busy,
						onClick: close,
						children: t('delete.cancel'),
					}),
					jsx(primitives.Button, {
						variant: 'outline',
						disabled: busy,
						onClick: confirm,
						style: { color: 'var(--dsw-alias-state-error-primary)' },
						children: t('delete.action'),
					}),
				] }),
				children: [
					request.running === true && jsx('div', {
						style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '13px', lineHeight: '20px', marginBottom: '4px' },
						children: t('delete.running'),
					}),
					busy && jsx('div', { role: 'status', children: t('delete.pending') }),
					error !== null && jsx('div', {
						role: 'alert',
						style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '13px', lineHeight: '20px', marginTop: '8px' },
						children: error,
					}),
				],
			})
		}

		/**
		 * Build one page-local failure carrying a code this dialog maps to wording.
		 * @param code - the failure code.
		 * @param message - the developer diagnostic.
		 * @returns the error.
		 */
		function codedFailure(code, message) {
			const error = new Error(message)
			error.code = code
			return error
		}

		/**
		 * Turn one rejection into the wording this dialog shows.
		 * @param reason - the caught failure.
		 * @param t - dictionary lookup.
		 * @returns the message.
		 */
		function describeFailure(reason, t) {
			if (reason?.code === BUSY) return t('delete.running')
			if (reason?.code === NOT_STORED) return t('delete.notStored')
			if (reason?.code === NOT_MOUNTED) return t('delete.notMounted')
			if (reason?.code === 'session-delete/unknown') return t('delete.unknown')
			return reason instanceof Error ? reason.message : String(reason)
		}

		/** Required Client services for the half that mounts the namespace. */
		const inject = ['locale', 'remote']

		/**
		 * The UI half, as its own fiber.
		 *
		 * `ctx.remote.sessionDelete` is a nested service key: cordis routes that
		 * access to the service registry and refuses it unless the accessing
		 * Context declares the key in `inject`. The service does not exist until
		 * this package mounts it, so one fiber cannot both publish and require it.
		 * The namespace is therefore mounted by {@link apply}, and this child fiber
		 * declares it as a dependency: cordis parks the child until the mount
		 * publishes `remote.sessionDelete`, then activates it. The visible
		 * consequence is deliberate — the menu entry cannot appear without a
		 * reachable endpoint.
		 */
		const UI_PLUGIN = {
			name: 'session-delete/ui',
			inject: ['slots', 'locale', 'remote.sessionDelete'],
			apply: installUi,
		}

		/**
		 * Publish the Remote namespace and hand the UI to its own fiber.
		 * @param ctx - the client root Context.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-delete: dictionaries')

			const mounted = ctx.remote.$mount(CONTRIBUTION)
			mounted.catch((reason) => {
				console.warn('session-delete: remote namespace failed to mount', reason)
			})
			ctx.effect(() => async () => {
				const dispose = await mounted.catch(() => undefined)
				if (dispose !== undefined) await dispose()
			}, 'session-delete: remote namespace')

			ctx.plugin(UI_PLUGIN)
		}

		/**
		 * Register the Session delete row entry and its confirmation dialog.
		 * @param ctx - the UI fiber's Context, which carries `remote.sessionDelete`.
		 */
		function installUi(ctx) {
			const deleteRequest = createStore(null)

			/** Session summary for one id, read lazily so absent plugins degrade. */
			const summaryOf = (sessionId) => ctx.get('sessions')?.list?.getSnapshot()?.byId?.[sessionId]

			/**
			 * Delete one Session on the Host, then reconcile this page with the
			 * Host's new state.
			 * @param sessionId - Session to delete.
			 * @returns resolution after the row is gone and the list re-pulled.
			 */
			const confirmDelete = async (sessionId) => {
				// The declared dependency normally guarantees the namespace; a
				// namespace retired under a live page is reported in its own words
				// instead of as a proxy lookup failure.
				let namespace
				try {
					namespace = ctx.remote.sessionDelete
				} catch (reason) {
					throw codedFailure(NOT_MOUNTED, `the sessionDelete namespace is unavailable: ${String(reason?.message ?? reason)}`)
				}
				const summary = summaryOf(sessionId)
				const uiWorkspace = ctx.get('uiWorkspace')
				const workspaceId = ctx.get('workspaces')?.list?.getSnapshot()?.items
					?.find((workspace) => workspace.sessionIds.includes(sessionId))?.workspaceId
				// The session on screen is either the recorded selection or the row
				// retained by the conversation's main view.
				const wasCurrent = uiWorkspace?.selection?.getSnapshot?.()?.sessionId === sessionId
					|| (summary?.retainedBy?.mainView ?? 0) > 0
				const result = await namespace[METHOD]({ sessionId })
				if (!result.ok) throw result.error
				const outcome = result.value ?? {}
				if (outcome.deleted !== true && outcome.reason === 'unmaterialized') {
					throw codedFailure(NOT_STORED, 'the session has no stored log')
				}
				const sessions = ctx.get('sessions')
				await sessions?.refresh?.()
				if (wasCurrent) {
					try {
						uiWorkspace?.startSession?.(workspaceId)
					} catch (reason) {
						console.warn('session-delete: navigation after delete failed', reason)
					}
				}
				return outcome
			}

			/** Open the confirmation dialog for one Session. */
			const requestDelete = (sessionId) => {
				const summary = summaryOf(sessionId)
				deleteRequest.set({
					sessionId,
					displayTitle: summary?.displayTitle ?? sessionId,
					running: summary?.running === true,
				})
			}

			ctx.slots.inject(MENU_SLOT, function* () {
				yield ctx.slots.register({
					name: MENU_SLOT,
					id: 'delete',
					order: MENU_ORDER,
					locale: NS,
					inject: () => ({ requestDelete }),
				}, DeleteSessionMenuItem)
			})
			ctx.slots.inject(OVERLAY_SLOT, function* () {
				yield ctx.slots.register({
					name: OVERLAY_SLOT,
					id: 'session-delete.confirm',
					locale: NS,
					inject: () => ({
						hooks: { deleteRequest },
						settleDelete: () => { deleteRequest.set(null) },
						confirmDelete,
					}),
				}, DeleteSessionConfirmDialog)
			})
		}

		exports.apply = apply
		exports.inject = inject
		return module.exports
	},
})
