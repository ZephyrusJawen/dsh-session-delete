// Browser-half wiring: the module-row contract, the slot registrations, the
// Remote contribution, and the delete -> refresh -> navigate flow. React and the
// UI primitives are stubbed, so this file needs nothing beyond the Node runtime.
const registrations = []
globalThis.window = {
  __ModuleLoader__: {
    load: (registration) => { registrations.push(registration) },
  },
}

let failures = 0
function check(label, condition, extra = '') {
  const mark = condition ? 'PASS' : 'FAIL'
  if (!condition) failures += 1
  console.log(`${mark}  ${label}${extra ? ` :: ${extra}` : ''}`)
}

// Minimal module stubs. The components only need to be callable values.
const jsxRuntime = {
  Fragment: Symbol('Fragment'),
  jsx: (type, props, key) => ({ type, props: props ?? {}, key }),
  jsxs: (type, props, key) => ({ type, props: props ?? {}, key }),
}
const reactStub = { useState: (initial) => [initial, () => {}] }
const primitivesStub = {
  MenuItemButton: function MenuItemButton() {},
  IconTrashOutlineRegular: function IconTrashOutlineRegular() {},
  Button: function Button() {},
  Modal: function Modal() {},
}
const requireStub = (specifier) => {
  if (specifier === 'react') return reactStub
  if (specifier === 'react/jsx-runtime') return jsxRuntime
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
  throw new Error(`unexpected require(${JSON.stringify(specifier)})`)
}

await import('../lib/client.js')
check('registers exactly one bundle', registrations.length === 1, String(registrations.length))
const registration = registrations[0]
check('bundle id is the package name', registration?.id === 'dsh-session-delete', String(registration?.id))
const clientModule = registration.factory(requireStub)
check('exports apply', typeof clientModule.apply === 'function')
check('exports inject', JSON.stringify(clientModule.inject) === JSON.stringify(['locale', 'remote']), JSON.stringify(clientModule.inject))

// --- fake client context ----------------------------------------------------
const slots = new Map()
const mountCalls = []
const localeCalls = []
const disposed = []
const sessionService = {
  refreshed: 0,
  list: { getSnapshot: () => ({ byId: {} }) },
  refresh() { this.refreshed += 1; return Promise.resolve() },
}
const startedSessions = []
const pluginCalls = []
const fakeCtx = {
  effect: (run) => { disposed.push(run()) },
  // The UI lives in a child fiber; this harness stands in for the scheduling
  // cordis performs once the injected namespace exists.
  plugin: (child) => { pluginCalls.push(child); child.apply(fakeCtx) },
  locale: { register: (ns, dict) => { localeCalls.push({ ns, dict }) } },
  slots: {
    inject: (slot, generator) => {
      const iterator = generator()
      let step = iterator.next()
      while (!step.done) step = iterator.next()
    },
    register: (options, component) => { slots.set(`${options.name}#${options.id}`, { options, component }) },
  },
  remote: {
    $mount: (contribution) => { mountCalls.push(contribution); return Promise.resolve(async () => {}) },
    sessionDelete: {
      removed: [],
      async deleteSession(payload) { this.removed.push(payload); return { ok: true, value: { deleted: true } } },
    },
  },
  get: (key) => {
    if (key === 'sessions') return sessionService
    if (key === 'workspaces') return { list: { getSnapshot: () => ({ items: [{ workspaceId: 'w1', sessionIds: ['s1'] }] }) } }
    if (key === 'uiWorkspace') return { startSession: (id) => startedSessions.push(id) }
    return undefined
  },
}

clientModule.apply(fakeCtx)

check('starts exactly one UI fiber', pluginCalls.length === 1, String(pluginCalls.length))
// Regression: `ctx.remote.sessionDelete` is a nested service key, and cordis
// refuses that access unless the accessing fiber declares it.
check('the UI fiber declares the namespace dependency', pluginCalls[0]?.inject?.includes('remote.sessionDelete') === true, JSON.stringify(pluginCalls[0]?.inject))
check('the UI fiber keeps the slot and locale dependencies', pluginCalls[0]?.inject?.includes('slots') === true && pluginCalls[0]?.inject?.includes('locale') === true, JSON.stringify(pluginCalls[0]?.inject))

check('registers a dictionary', localeCalls.length === 1 && localeCalls[0].ns === 'sessionDelete')
check('mounts one Remote contribution', mountCalls.length === 1)
const contribution = mountCalls[0]
const descriptor = contribution?.descriptors?.[0]
check('contribution names the package', contribution?.package === 'dsh-session-delete', String(contribution?.package))
check('descriptor endpoints match the host method', descriptor?.namespace === 'sessionDelete' && descriptor?.method === 'deleteSession', `${descriptor?.namespace}/${descriptor?.method}`)
check('descriptor service matches the host service key', descriptor?.service === 'sessionDelete', String(descriptor?.service))
check('every parameter carries a strict codec', descriptor?.parameters?.every((p) => p.codec?.mode === 'strict') === true)
check('result stays src-json', descriptor?.result?.mode === 'src-json', String(descriptor?.result?.mode))
// Regression: the Client's own namespace service owns these members, and a
// contribution whose method shadows one is rejected at mount time.
const NAMESPACE_SERVICE_MEMBERS = [
  'ctx', 'empty', 'invokeRemote', 'methods', 'name', 'namespace', 'constructor',
  'assertMethodAvailable', 'has', 'install', 'installDirect', 'installScoped', 'remove',
]
check('method name avoids namespace-service members', !NAMESPACE_SERVICE_MEMBERS.includes(descriptor?.method), String(descriptor?.method))
check('registers the row menu entry', slots.has('sidebar.workspaces.session.menu.item#delete'))
check('registers the confirm dialog', slots.has('shell.overlay#session-delete.confirm'))

const menu = slots.get('sidebar.workspaces.session.menu.item#delete')
check('menu row sorts after archive', menu.options.order === 500, String(menu.options.order))
check('menu row is locale-scoped', menu.options.locale === 'sessionDelete')

// --- drive the menu row -----------------------------------------------------
const injected = menu.options.inject()
let menuOpen = true
const menuTree = menu.component({
  sessionId: 's1',
  useMenuOpenState: () => [menuOpen, (next) => { menuOpen = next }],
  t: (key) => key,
  ...injected,
})
check('menu row renders a menu item', menuTree?.type === primitivesStub.MenuItemButton)
check('menu row is a danger entry', menuTree?.props?.danger === true)
menuTree.props.onSelect()
check('selecting closes the menu', menuOpen === false)

// --- drive the confirm dialog ----------------------------------------------
const dialog = slots.get('shell.overlay#session-delete.confirm')
const dialogInjected = dialog.options.inject()
check('dialog injects a request hook', typeof dialogInjected.hooks?.deleteRequest?.getSnapshot === 'function')
const pending = dialogInjected.hooks.deleteRequest.getSnapshot()
check('pending request carries the session', pending?.sessionId === 's1', JSON.stringify(pending))

// The slot framework flattens `hooks: { deleteRequest }` into `useDeleteRequest`.
const flattened = { ...dialogInjected }
delete flattened.hooks
flattened.useDeleteRequest = (selector) => {
  const value = dialogInjected.hooks.deleteRequest.getSnapshot()
  return selector === undefined ? value : selector(value)
}
const dialogTree = dialog.component({ ...flattened, t: (key) => key })
check('dialog renders while a request is pending', dialogTree?.type !== undefined)

// A session list where the target is the current main view.
sessionService.list.getSnapshot = () => ({ byId: { s1: { retainedBy: { mainView: 1 }, displayTitle: 'One' } } })
await dialogInjected.confirmDelete('s1')
check('calls the host delete method with the session', fakeCtx.remote.sessionDelete.removed.length === 1 && fakeCtx.remote.sessionDelete.removed[0].sessionId === 's1', JSON.stringify(fakeCtx.remote.sessionDelete.removed))
check('re-pulls the session list', sessionService.refreshed === 1, String(sessionService.refreshed))
check('navigates away from the deleted current session', startedSessions[0] === 'w1', JSON.stringify(startedSessions))

// --- failure mapping --------------------------------------------------------
fakeCtx.remote.sessionDelete.deleteSession = async () => ({ ok: false, error: Object.assign(new Error('busy!'), { code: 'session-delete/busy' }) })
let rejected
try { await dialogInjected.confirmDelete('s1') } catch (error) { rejected = error }
check('propagates a host refusal', rejected?.code === 'session-delete/busy', String(rejected?.code))

// --- a retired namespace reports itself instead of a proxy failure ----------
{
  const failingSlots = new Map()
  const calls = []
  const failingCtx = {
    effect: (run) => { run() },
    plugin: (child) => { child.apply(failingCtx) },
    locale: { register: () => {} },
    slots: {
      inject: (_slot, generator) => { const iterator = generator(); while (!iterator.next().done) {} },
      register: (options, component) => { failingSlots.set(`${options.name}#${options.id}`, { options, component }) },
    },
    remote: {
      $mount: () => Promise.resolve(async () => {}),
      // Mimics cordis refusing the nested-key access for an inactive service.
      get sessionDelete() { throw new Error('cannot get required service "remote.sessionDelete" in inactive context') },
      deleteSession: async (payload) => { calls.push(payload); return { ok: true, value: { deleted: true } } },
    },
    get: () => undefined,
  }
  clientModule.apply(failingCtx)
  const failingInjected = failingSlots.get('shell.overlay#session-delete.confirm').options.inject()
  let notMounted
  try { await failingInjected.confirmDelete('s1') } catch (error) { notMounted = error }
  check('a retired namespace reports itself', notMounted?.code === 'session-delete/not-mounted', String(notMounted?.code))
  check('no host call happens without the namespace', calls.length === 0, JSON.stringify(calls))
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
