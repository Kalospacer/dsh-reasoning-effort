import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  clampIndex,
  currentModel,
  effectiveEffortIndex,
  effortIndex,
  selectEffort,
  sliderLevels,
} from '../src/client/effort-selection.ts'

const t = (key, values = {}) => `${key}${values.effort ? `: ${values.effort}` : ''}`
const target = (effort, provider = 'p', model = 'm') => ({ provider, model, reasoningEffort: effort })
const state = (ids, effort = 'high', provider = 'p', model = 'm') => ({
  current: target(effort, provider, model),
  routable: true,
  groups: [{ id: provider, name: provider, models: [{ id: model, name: model, reasoning: {
    efforts: ids.map(id => ({ id, name: id })), defaultEffort: 'high',
  } }] }],
  failures: [], status: 'ready', pending: null, error: null,
})

function directory(initial, overrides = {}) {
  let snapshot = initial
  const listeners = new Set()
  const calls = []
  const publish = (next) => {
    snapshot = next
    for (const listener of [...listeners]) listener()
  }
  const api = {
    store: {
      getSnapshot: () => snapshot,
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    },
    load: async () => snapshot,
    select: async selection => {
      publish({ ...snapshot, current: selection })
      return { ok: true, value: undefined }
    },
    ...overrides,
  }
  const select = api.select
  api.select = async selection => { calls.push(selection); return select(selection) }
  return { api, calls, publish, listeners }
}
const tick = () => new Promise(resolve => setImmediate(resolve))
const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const select = (d, effort, signal = new AbortController().signal, timeout = 1000) => selectEffort(d.api, target(effort), signal, t, timeout)

for (const effort of levels) {
  test(`submits exact ${effort} ID and confirms it`, async () => {
    const d = directory(state(levels))
    const confirmed = await select(d, effort)
    assert.deepEqual(d.calls, [target(effort)])
    assert.equal(confirmed.current.reasoningEffort, effort)
    assert.equal(d.listeners.size, 0)
  })
}

test('low never becomes off when a refreshed catalog adds a lower level', async () => {
  const d = directory(state(['off', 'low', 'high', 'max']))
  const rendered = state(['low', 'high', 'max'])
  const selectedId = sliderLevels(rendered)[clampIndex(0, 3)].id
  await select(d, selectedId)
  assert.deepEqual(d.calls, [target('low')])
})

test('reordering catalog levels preserves the selected ID', async () => {
  const d = directory(state(['max', 'off', 'high', 'low']))
  await select(d, 'max')
  assert.equal(d.calls[0].reasoningEffort, 'max')
})

test('removing max reports an error without submitting high', async () => {
  const d = directory(state(['off', 'low', 'medium', 'high']))
  await assert.rejects(select(d, 'max'), /effort\.unsupported: max/)
  assert.equal(d.calls.length, 0)
})

test('model change while loading cannot retarget the gesture to another model', async () => {
  const d = directory(state(levels), { load: async () => state(levels, 'high', 'p', 'other') })
  await assert.rejects(select(d, 'max'), /effort\.modelChanged/)
  assert.equal(d.calls.length, 0)
})

test('provider change while loading cannot select a same-named model on another route', async () => {
  const d = directory(state(levels), { load: async () => state(levels, 'high', 'other', 'm') })
  await assert.rejects(select(d, 'low'), /effort\.modelChanged/)
  assert.equal(d.calls.length, 0)
})

test('missing current model is rejected before selecting', async () => {
  const d = directory({ ...state(levels), current: null })
  await assert.rejects(select(d, 'low'), /effort\.modelChanged/)
  assert.equal(d.calls.length, 0)
})

for (const [previous, requested] of [['high', 'max'], ['off', 'low']]) {
  test(`RPC success with stale ${previous} is not accepted as ${requested}`, async () => {
    const d = directory(state(levels, previous), { select: async () => ({ ok: true, value: undefined }) })
    let settled = false
    const pending = select(d, requested).then(s => { settled = true; return s })
    await tick()
    assert.deepEqual(d.calls, [target(requested)])
    assert.equal(settled, false)
    assert.equal(d.listeners.size, 1)
    d.publish({ ...state(levels, previous), status: 'loading' })
    d.publish(state(levels, previous))
    await tick()
    assert.equal(settled, false)
    d.publish(state(levels, requested))
    const confirmed = await pending
    assert.equal(confirmed.current.reasoningEffort, requested)
    assert.equal(d.listeners.size, 0)
  })
}

test('projection received before a delayed RPC acknowledgement is confirmed only after success', async () => {
  let acknowledge
  const d = directory(state(levels), { select: () => new Promise(resolve => { acknowledge = resolve }) })
  let settled = false
  const pending = select(d, 'max').then(s => { settled = true; return s })
  await tick()
  d.publish(state(levels, 'max'))
  await tick()
  assert.equal(settled, false)
  acknowledge({ ok: true, value: undefined })
  assert.equal((await pending).current.reasoningEffort, 'max')
  assert.equal(d.listeners.size, 0)
})

test('structured Remote error surfaces code and message without waiting', async () => {
  const d = directory(state(levels), { select: async () => ({ ok: false, error: { code: 'UNSUPPORTED_REASONING_EFFORT', message: 'max unavailable' } }) })
  await assert.rejects(select(d, 'max'), /UNSUPPORTED_REASONING_EFFORT: max unavailable/)
  assert.equal(d.listeners.size, 0)
})

test('directory load failure never submits a selection', async () => {
  const d = directory(state(levels), { load: async () => { throw new Error('catalog unavailable') } })
  await assert.rejects(select(d, 'low'), /catalog unavailable/)
  assert.equal(d.calls.length, 0)
})

test('acknowledgement timeout reports failure and removes subscription', async () => {
  const d = directory(state(levels), { select: async () => ({ ok: true, value: undefined }) })
  await assert.rejects(select(d, 'max', undefined, 15), /effort\.unconfirmed/)
  assert.equal(d.listeners.size, 0)
})

test('cancel before loading prevents any RPC', async () => {
  const d = directory(state(levels))
  const controller = new AbortController()
  controller.abort(new Error('unmounted'))
  await assert.rejects(select(d, 'max', controller.signal), /unmounted/)
  assert.equal(d.calls.length, 0)
})

test('cancel during catalog loading prevents selecting after the load resolves', async () => {
  let resolveLoad
  const d = directory(state(levels), { load: () => new Promise(resolve => { resolveLoad = resolve }) })
  const controller = new AbortController()
  const pending = select(d, 'max', controller.signal)
  controller.abort(new Error('route changed'))
  await assert.rejects(pending, /route changed/)
  assert.equal(d.calls.length, 0)
  resolveLoad(state(levels))
  await tick()
  assert.equal(d.calls.length, 0)
})

test('cancel while an RPC is pending rejects immediately and ignores its late acknowledgement', async () => {
  let acknowledge
  const d = directory(state(levels), { select: () => new Promise(resolve => { acknowledge = resolve }) })
  const controller = new AbortController()
  const pending = select(d, 'max', controller.signal)
  await tick()
  assert.equal(d.calls.length, 1)
  controller.abort(new Error('unmounted'))
  await assert.rejects(pending, /unmounted/)
  assert.equal(d.listeners.size, 0)
  acknowledge({ ok: true, value: undefined })
  d.publish(state(levels, 'max'))
  await tick()
  assert.equal(d.listeners.size, 0)
})

test('cancel while awaiting projection releases subscription and timeout', async () => {
  const d = directory(state(levels), { select: async () => ({ ok: true, value: undefined }) })
  const controller = new AbortController()
  const pending = select(d, 'max', controller.signal)
  await tick()
  controller.abort(new Error('unmounted'))
  await assert.rejects(pending, /unmounted/)
  assert.equal(d.listeners.size, 0)
  d.publish(state(levels, 'max'))
  assert.equal(d.listeners.size, 0)
})

test('another model using the same effort cannot acknowledge the original selection', async () => {
  const d = directory(state(levels), { select: async () => ({ ok: true, value: undefined }) })
  const pending = select(d, 'max')
  await tick()
  d.publish(state(levels, 'max', 'p', 'other'))
  await assert.rejects(pending, /effort\.modelChanged/)
  assert.equal(d.listeners.size, 0)
})

test('target level removed during acknowledgement is rejected without downgrade', async () => {
  const d = directory(state(levels), { select: async () => ({ ok: true, value: undefined }) })
  const pending = select(d, 'max')
  await tick()
  d.publish(state(['off', 'low', 'high'], 'max'))
  await assert.rejects(pending, /effort\.unsupported: max/)
  assert.equal(d.calls.length, 1)
  assert.equal(d.calls[0].reasoningEffort, 'max')
  assert.equal(d.listeners.size, 0)
})

test('directory error while awaiting confirmation is surfaced', async () => {
  const d = directory(state(levels), { select: async () => ({ ok: true, value: undefined }) })
  const pending = select(d, 'max')
  await tick()
  d.publish({ ...state(levels), status: 'error', error: 'connection lost' })
  await assert.rejects(pending, /connection lost/)
  assert.equal(d.listeners.size, 0)
})

test('slider metadata remains adapter-owned, including custom IDs and order', async () => {
  const custom = ['disabled', 'balanced', 'deep']
  const d = directory(state(custom, 'balanced'))
  assert.deepEqual(sliderLevels(d.api.store.getSnapshot()).map(l => l.id), custom)
  assert.equal(currentModel(d.api.store.getSnapshot()).id, 'm')
  await select(d, 'deep')
  assert.equal(d.calls[0].reasoningEffort, 'deep')
})

test('slider fallback prefers selected ID, then adapter default, then midpoint', () => {
  const s = state(levels, 'max')
  const l = sliderLevels(s)
  assert.equal(effectiveEffortIndex(l, s), 6)
  assert.equal(effectiveEffortIndex(l, { ...s, current: target(undefined) }), 4)
  const withoutDefault = state(levels, undefined)
  withoutDefault.current.reasoningEffort = undefined
  withoutDefault.groups[0].models[0].reasoning.defaultEffort = undefined
  assert.equal(effectiveEffortIndex(l, withoutDefault), 3)
  assert.equal(effortIndex(l, 'nonexistent'), -1)
  assert.equal(sliderLevels(state(['high'])).length, 0)
  assert.equal(clampIndex(-2, 7), 0)
  assert.equal(clampIndex(99, 7), 6)
  assert.equal(clampIndex(2.6, 7), 3)
})
