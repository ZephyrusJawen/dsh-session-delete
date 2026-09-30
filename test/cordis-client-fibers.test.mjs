// Runs the browser half inside a real Cordis tree, with a stand-in for the
// Gateway's Remote service, and checks the two framework rules this plugin has
// to satisfy:
//   1. a nested service key (`remote.sessionDelete`) is only readable by a
//      Context that declares it in `inject`;
//   2. the fiber that declares it therefore cannot be the fiber that publishes
//      it, so the UI lives in a child fiber that Cordis parks until then.
//
// Needs the `@deepseek-ai/cordis` devDependency; it skips itself when absent.
const registrations = []
globalThis.window = { __ModuleLoader__: { load: (registration) => { registrations.push(registration) } } }

let failures = 0
function check(label, condition, extra = '') {
  const mark = condition ? 'PASS' : 'FAIL'
  if (!condition) failures += 1
  console.log(`${mark}  ${label}${extra ? ` :: ${extra}` : ''}`)
}
async function optionalImport(specifier) {
  try { return await import(specifier) } catch { return undefined }
}

const cordis = await optionalImport('@deepseek-ai/cordis')
if (cordis === undefined) {
  console.log('SKIP  cordis-client-fibers: @deepseek-ai/cordis is not installed (run `pnpm install` first)')
  process.exit(0)
}
const { Context, Service } = cordis

const settle = async () => { for (let i = 0; i < 40; i += 1) await Promise.resolve() }

const jsxRuntime = {
  Fragment: Symbol('Fragment'),
  jsx: (type, props, key) => ({ type, props: props ?? {}, key }),
  jsxs: (type, props, key) => ({ type, props: props ?? {}, key }),
}
const requireStub = (specifier) => {
  if (specifier === 'react') return { useState: (initial) => [initial, () => {}] }
  if (specifier === 'react/jsx-runtime') return jsxRuntime
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') {
    return {
      MenuItemButton: function MenuItemButton() {},
      IconTrashOutlineRegular: function IconTrashOutlineRegular() {},
      Button: function Button() {},
      Modal: function Modal() {},
    }
  }
  throw new Error(`unexpected require(${JSON.stringify(specifier)})`)
}

await import('../lib/client.js')
const clientModule = registrations[0].factory(requireStub)

// --- the real tree ----------------------------------------------------------
const root = new Context()
const registeredSlots = []
const hostCalls = []
let probeFailure
let releaseMount
const mountGate = new Promise((resolve) => { releaseMount = resolve })

root.provide('slots', {
  inject: (_slot, generator) => { const iterator = generator(); while (!iterator.next().done) {} },
  register: (options) => { registeredSlots.push(options); return () => {} },
})
root.provide('locale', { register: () => () => {} })

/** Stand-in for the Gateway's client Remote service (a real Service, so the
 * nested-key routing through `tracker.associate` is exercised). Its mount is
 * held open until the test releases it, so the parked window is observable. */
class FakeRemote extends Service {
  constructor(ctx) {
    super(ctx, 'remote')
  }
  async $mount(contribution) {
    const namespace = contribution.descriptors[0].namespace
    await mountGate
    const fiber = this.ctx.plugin({
      name: `remote.${namespace}`,
      apply: (ctx) => {
        const service = new Service(ctx, `remote.${namespace}`)
        service.deleteSession = async (payload) => {
          hostCalls.push(payload)
          return { ok: true, value: { deleted: true } }
        }
      },
    })
    await fiber
    return async () => { await fiber.dispose() }
  }
}

root.plugin(FakeRemote)
root.plugin(clientModule)
await settle()

check('the UI fiber is parked while the namespace is unpublished', registeredSlots.length === 0, JSON.stringify(registeredSlots.map((o) => o.id)))

releaseMount()
await settle()
check('the UI fiber activates once the namespace exists', registeredSlots.length === 2, JSON.stringify(registeredSlots.map((o) => o.id)))

// Proof the declared dependency is what makes the access legal: a sibling fiber
// that injects `remote` but not the nested key is refused.
const probe = root.plugin({
  name: 'probe',
  inject: ['remote'],
  apply: (ctx) => {
    try { void ctx.remote.sessionDelete } catch (error) { probeFailure = error }
  },
})
await probe
check('a context without the nested inject is refused', probeFailure !== undefined, String(probeFailure?.message))
check('the refusal names the nested key', String(probeFailure?.message).includes('remote.sessionDelete'), String(probeFailure?.message))

const menu = registeredSlots.find((options) => options.id === 'delete')
const dialog = registeredSlots.find((options) => options.id === 'session-delete.confirm')
check('the row entry and the dialog both arrive', menu !== undefined && dialog !== undefined)
check('the row entry keeps its order seat', menu?.order === 500, String(menu?.order))
check('the row entry is locale-scoped', menu?.locale === 'sessionDelete', String(menu?.locale))

const injected = dialog.inject()
const pending = injected.hooks.deleteRequest
check('the dialog injects its request hook', typeof pending?.getSnapshot === 'function')
await injected.confirmDelete('session-x')
check('the nested-key call reaches the host', hostCalls.length === 1 && hostCalls[0].sessionId === 'session-x', JSON.stringify(hostCalls))

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
