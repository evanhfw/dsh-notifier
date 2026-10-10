import test from 'node:test'
import assert from 'node:assert/strict'
import { createControlSurfaceService } from '../src/control-surface/service.mjs'
import { createSurfaceRevision } from '../src/control-surface/revision.mjs'
import { createSurfaceActivity } from '../src/control-surface/activity.mjs'
import { createSurfaceHealth } from '../src/control-surface/health.mjs'
import { createChannelProjection } from '../src/control-surface/channels.mjs'
import { healthState } from '../src/control-surface/health.mjs'

test('home projection is compact and questions settle maps through one service', async () => {
  const revision = createSurfaceRevision()
  const activity = createSurfaceActivity()
  const health = createSurfaceHealth()
  let settled = 0
  const service = createControlSurfaceService({
    revision,
    channels: {
      list: () => [{
        type: 'telegram',
        notify: { configured: true },
        control: null,
        health: { state: 'ready' },
      }],
      get: () => null,
    },
    outboundConfig: {},
    channelTest: async () => ({ ok: true }),
    tasks: { list: () => [{ taskRef: 'a', status: 'running', attention: false, boundChannels: [] }] },
    questions: {
      list: () => [{ ref: 'q1', question: 'Continue?', multiple: false, options: [{ value: '0', label: 'Yes' }], status: 'pending' }],
      settle: () => { settled += 1; return { settled: true, alreadyHandled: false } },
    },
    activity,
    health,
    launchTickets: { mint: () => ({ ticket: 'x', expiresAt: 1 }) },
    adminLocation: () => null,
  })

  const home = await service.call('surface.home', {})
  assert.equal(home.ok, true)
  assert.equal(home.value.tasks.length, 1)
  assert.equal(home.value.questions.length, 1)
  assert.equal(home.value.channels.length, 1)
  assert.equal(home.value.summary.status, 'attention')

  const result = await service.call('questions.settle', { ref: 'q1', action: 'choose', options: ['0'] })
  assert.equal(result.ok, true)
  assert.equal(result.value.settled, true)
  assert.equal(settled, 1)
})

test('channel test distinguishes provider acceptance from explicit delivery receipt', async () => {
  const revision = createSurfaceRevision()
  const activity = createSurfaceActivity()
  const health = createSurfaceHealth()
  let testResult = { ok: true, detail: 'provider accepted request' }
  const service = createControlSurfaceService({
    revision,
    channels: { list: () => [], get: () => null },
    outboundConfig: { raw: () => ({ token: 'configured' }) },
    channelTest: async () => testResult,
    tasks: { list: () => [] },
    questions: { list: () => [], settle: () => ({ settled: false }) },
    activity,
    health,
    launchTickets: { mint: () => ({ ticket: 'x', expiresAt: 1 }) },
    adminLocation: () => null,
  })

  const accepted = await service.call('channels.test', { type: 'telegram' })
  assert.equal(accepted.ok, true)
  assert.equal(accepted.value.status, 'accepted')
  assert.equal(accepted.value.delivered, false)
  assert.equal(accepted.value.detail, 'provider accepted request')
  assert.equal(accepted.value.providerDetail, 'provider accepted request')
  assert.equal(activity.list()[0].title.zh, '测试消息已发送 · telegram')

  testResult = { ok: true, confirmed: true }
  const delivered = await service.call('channels.test', { type: 'telegram' })
  assert.equal(delivered.value.status, 'delivered')
  assert.equal(delivered.value.delivered, true)
})

test('v0.13：accepted 只记 accepted，configured 但 inactive 进入 degraded/attention', async () => {
  const health = createSurfaceHealth()
  health.recordTest('telegram', { ok: true })
  assert.equal(health.snapshot('telegram').accepted, 1)
  assert.equal(health.snapshot('telegram').delivered, 0)
  assert.equal(healthState({ configured: true, active: false, health: health.snapshot('telegram') }), 'degraded')

  const revision = createSurfaceRevision()
  const activity = createSurfaceActivity()
  const service = createControlSurfaceService({
    revision,
    channels: {
      list: () => [{ type: 'telegram', notify: { configured: true, active: false }, control: null, health: { state: 'degraded' } }],
      get: () => null,
    },
    outboundConfig: {},
    tasks: { list: () => [] },
    questions: { list: () => [], settle: () => ({ settled: false }) },
    activity,
    health,
    storageStatus: () => ({ readFailed: false }),
    launchTickets: { mint: () => ({ ticket: 'x', expiresAt: 1 }) },
    adminLocation: () => null,
  })
  const home = await service.call('surface.home')
  assert.equal(home.value.summary.status, 'attention')
  assert.match(home.value.summary.detail.zh, /未激活/)
})

test('v0.13：surface.wait capacity 保留退避信息，inbound saved=false 返回 structured failure', async () => {
  const revision = createSurfaceRevision({ maxWaiters: 1 })
  const activity = createSurfaceActivity()
  const makeService = () => createControlSurfaceService({
    revision,
    channels: { list: () => [], get: () => null },
    outboundConfig: {},
    saveInbound: async () => ({ saved: false }),
    tasks: { list: () => [] },
    questions: { list: () => [], settle: () => ({ settled: false }) },
    activity,
    health: createSurfaceHealth(),
    launchTickets: { mint: () => ({ ticket: 'x', expiresAt: 1 }) },
    adminLocation: () => null,
  })
  const service = makeService()
  const first = service.call('surface.wait', { after: revision.current().revision, timeoutMs: 30_000 })
  const capacity = await service.call('surface.wait', { after: revision.current().revision, timeoutMs: 30_000 })
  assert.equal(capacity.ok, true)
  assert.equal(capacity.value.capacity, true)
  assert.ok(capacity.value.retryAfterMs >= 500)

  const before = revision.current().revision
  const failed = await service.call('channels.save', { type: 'telegram', direction: 'inbound', patch: { botToken: 'x' } })
  assert.equal(failed.ok, false)
  assert.equal(failed.error.code, 'dsh-notifier/storage-failed')
  assert.equal(revision.current().revision, before)
  assert.deepEqual(activity.list(), [])
  revision.dispose()
  await first
})

test('v0.13：Native projection 默认不返回未声明字段或入站 secret', () => {
  const projection = createChannelProjection({
    outboundConfig: {
      raw: () => ({ token: 'outbound-secret', accountId: 'acct' }),
      describe: () => ({
        configured: true,
        active: true,
        fields: { token: { required: true }, accountId: { secret: false } },
        configRevision: 1,
      }),
    },
    inboundConfig: { version: 7 },
    adminApi: {
      getChannels: () => [{
        type: 'telegram', direction: 'inbound', configured: true, enabled: true,
        fields: { botToken: { required: true } }, config: { botToken: 'inbound-secret' },
      }],
    },
    health: createSurfaceHealth(),
  })
  const row = projection.get('telegram')
  assert.equal(row.notify.fields.token.secret, true)
  assert.equal(row.notify.editableValues.token, undefined)
  assert.equal(row.notify.editableValues.accountId, 'acct')
  assert.equal(row.control.fields.botToken.secret, true)
  assert.equal(row.control.configRevision, 7)
  assert.deepEqual(row.control.editableValues, {})
  assert.doesNotMatch(JSON.stringify(row), /outbound-secret|inbound-secret/)
})

test('v0.13：surface home exposes safe epoch/revision and migration diagnostics', async () => {
  const revision = createSurfaceRevision({ epoch: 'epoch-a' })
  const service = createControlSurfaceService({
    revision,
    channels: { list: () => [], get: () => null },
    outboundConfig: {},
    tasks: { list: () => [] },
    questions: { list: () => [], settle: () => ({ settled: false }) },
    activity: createSurfaceActivity(),
    health: createSurfaceHealth(),
    storageStatus: () => ({
      readFailed: false,
      migration: { status: 'complete', migratedCount: 2, backupCreated: true },
    }),
    launchTickets: { mint: () => ({ ticket: 'x', expiresAt: 1 }) },
    adminLocation: () => null,
  })
  const result = await service.call('surface.home')
  assert.equal(result.ok, true)
  assert.equal(result.value.epoch, 'epoch-a')
  assert.equal(result.value.revision, 1)
  assert.deepEqual(result.value.storage.migration, { status: 'complete', migratedCount: 2, backupCreated: true })
  assert.equal(JSON.stringify(result.value).includes('backupPath'), false)
  revision.dispose()
})

test('R3：storage 损坏（corrupt）时 surface.home 报 attention 且明确 storage degraded', async () => {
  const service = createControlSurfaceService({
    revision: createSurfaceRevision(),
    channels: { list: () => [{
      type: 'telegram',
      notify: { configured: true, active: true },
      control: null,
      health: { state: 'ready' },
    }], get: () => null },
    outboundConfig: {},
    tasks: { list: () => [] },
    questions: { list: () => [], settle: () => ({ settled: false }) },
    activity: createSurfaceActivity(),
    health: createSurfaceHealth(),
    storageStatus: () => ({ status: 'corrupt', readFailed: false, corrupt: true }),
    launchTickets: { mint: () => ({ ticket: 'x', expiresAt: 1 }) },
    adminLocation: () => null,
  })

  const home = await service.call('surface.home', {})
  assert.equal(home.value.summary.status, 'attention', '损坏不得报告健康')
  assert.match(home.value.summary.detail.zh, /损坏/, '必须明确说明 storage degraded，而不是伪装正常')
  assert.equal(home.value.storage.corrupt, true)
})

// v0.13.2 反代接入：standalone.createLaunch 的基址解析。
// 反代部署下回环地址对远端浏览器无意义（指向用户自己的机器），故 publicUrl 优先；
// 未配置时保持存量回环行为。管理台未就绪（adminLocation 空）一律 disabled，绝不产出死链。
test('standalone.createLaunch：publicUrl 优先，未配置回落回环，管理台未就绪一律 disabled', async () => {
  const build = (adminPublicUrl, adminLocation = () => ({ port: 8104, address: '127.0.0.1' })) => createControlSurfaceService({
    revision: createSurfaceRevision(),
    channels: { list: () => [] },
    tasks: { list: () => [] },
    questions: { list: () => [] },
    activity: createSurfaceActivity(),
    health: createSurfaceHealth(),
    storageStatus: {},
    launchTickets: { mint: () => ({ ticket: 'TK' }) },
    adminLocation,
    ...(adminPublicUrl === undefined ? {} : { adminPublicUrl }),
  })

  const proxied = await build(() => 'https://notifier.ehw.my.id').call('standalone.createLaunch')
  assert.equal(proxied.value.url, 'https://notifier.ehw.my.id/#ticket=TK', '反代基址优先')

  const subpath = await build(() => 'https://x.example.com/notifier').call('standalone.createLaunch')
  assert.equal(subpath.value.url, 'https://x.example.com/notifier/#ticket=TK', '支持反代子路径')

  const legacy = await build(() => '').call('standalone.createLaunch')
  assert.equal(legacy.value.url, 'http://127.0.0.1:8104/#ticket=TK', '空 publicUrl → 存量回环行为')

  const absent = await build(undefined).call('standalone.createLaunch')
  assert.equal(absent.value.url, 'http://127.0.0.1:8104/#ticket=TK', '未注入 accessor → 存量行为')

  const disabled = await build(() => 'https://notifier.ehw.my.id', () => null).call('standalone.createLaunch')
  assert.equal(disabled.value.available, false, '管理台未就绪 → disabled（绝不产出打不开的链接）')
  assert.equal(disabled.value.reason, 'disabled')
})
