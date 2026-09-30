// Runs the host plugin inside a real Cordis tree and checks the registration the
// Gateway's source-mode discovery depends on, using the real protocol package.
//
// Needs the devDependencies (`pnpm install`); it skips itself when they are
// absent so `npm test` still works in a bare checkout.
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
const protocol = await optionalImport('@deepseek-ai/dsh-typert-protocol')
if (cordis === undefined || protocol === undefined) {
  console.log('SKIP  cordis-registration: @deepseek-ai/cordis or @deepseek-ai/dsh-typert-protocol is not installed (run `pnpm install` first)')
  process.exit(0)
}

const { Context } = cordis
const { remoteMethods } = protocol
const plugin = await import('../lib/index.js')

const root = new Context()
const registered = []
root.on('internal/service', (name) => { registered.push(name) })

const fiber = root.plugin(plugin)
await fiber

const service = root.get('sessionDelete')
check('cordis registered the service', service !== undefined)
check('the service is a reflect "service" prop', root.reflect.props.sessionDelete?.type === 'service', JSON.stringify(root.reflect.props.sessionDelete))
check('plugin name is exported', plugin.name === 'session-delete', String(plugin.name))

const binding = service?.typertRemote
check('typertRemote.service is the receiver itself', binding?.service === service)
check('typertRemote.serviceKey matches the service key', binding?.serviceKey === 'sessionDelete', String(binding?.serviceKey))
check('typertRemote.namespace matches the wire namespace', binding?.namespace === 'sessionDelete', String(binding?.namespace))

const markers = remoteMethods(service)
check('the prototype carries one Remote marker', markers.length === 1, JSON.stringify(markers))
check('the marker names the delete method', markers[0]?.method === 'deleteSession', String(markers[0]?.method))
check('the marker is a direct invocation', markers[0]?.invocation?.kind === 'direct', JSON.stringify(markers[0]?.invocation))
check('the marker exposes its export name', (markers[0]?.exportName ?? markers[0]?.method) === 'deleteSession')

// The SRC descriptor builder reads parameter names off the method source.
const source = Function.prototype.toString.call(service.deleteSession)
const params = source.slice(source.indexOf('(') + 1, source.indexOf(')')).trim()
check('the method signature is one plain identifier', /^[A-Za-z_$][\w$]*$/u.test(params), params)

// With no persistence service composed, the call refuses structurally.
let refusal
try { await service.deleteSession({ sessionId: 'session-x' }) } catch (error) { refusal = error }
check('missing persistence refuses', refusal !== undefined, String(refusal?.code))
check('refusal is structurally identifiable', refusal?.isDSHRemoteError === true && refusal?.code === 'gateway/internal', String(refusal?.code))

// Disposal removes the registration with the fiber.
await fiber.dispose()
check('disposal drops the service', root.get('sessionDelete') === undefined)

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
