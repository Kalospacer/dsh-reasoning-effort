import React from 'react'
import { createRoot } from 'react-dom/client'
import { EffortSlider } from '../../.client-build/slider-under-test'
import { CSS } from '../../src/client/styles'

const style = document.createElement('style')
style.textContent = CSS
document.head.appendChild(style)
const root = createRoot(document.getElementById('app')!)
const target = (reasoningEffort: string, model = 'm') => ({ provider: 'p', model, reasoningEffort })
const state = (ids: string[], effort: string, model = 'm') => ({
  current: target(effort, model),
  groups: [{ id: 'p', name: 'p', models: [{ id: model, name: model, reasoning: {
    efforts: ids.map(id => ({ id, name: id })), defaultEffort: 'high',
  } }] }],
  failures: [], status: 'ready', routable: true, pending: null, error: null,
})
let mountId = 0
const fixture = {
  calls: [] as ReturnType<typeof target>[],
  current: null as any,
  mount(ids: string[], initial: string, mode = 'normal') {
    const calls: ReturnType<typeof target>[] = []
    const listeners = new Set<() => void>()
    let snapshot = state(ids, initial)
    let loads = 0
    const publish = (next: ReturnType<typeof state>) => {
      snapshot = next
      for (const listener of [...listeners]) listener()
    }
    const directory = {
      store: {
        getSnapshot: () => snapshot,
        subscribe: (listener: () => void) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
      load: async () => {
        loads++
        if (loads > 1 && mode === 'expand') publish(state(['off', 'low', 'high', 'max'], initial))
        if (loads > 1 && mode === 'remove-max') publish(state(['off', 'low', 'high'], 'high'))
        if (loads > 1 && mode === 'slow') await new Promise(resolve => setTimeout(resolve, 100))
        return snapshot
      },
      select: async (selection: ReturnType<typeof target>) => {
        calls.push(selection)
        const next = { ...snapshot, current: selection }
        if (mode === 'lag') setTimeout(() => publish(next), 150)
        else publish(next)
        return { ok: true, value: undefined }
      },
    }
    fixture.calls = calls
    fixture.current = { publish, state, listeners }
    root.render(<EffortSlider key={++mountId} directory={directory as any} t={((key: string, values: any = {}) => key + (values.effort ? ':' + values.effort : '')) as any} />)
  },
  changeModel(ids: string[], effort = 'high') {
    fixture.current.publish(state(ids, effort, 'other'))
  },
  unmount() { root.unmount() },
}
;(window as any).fixture = fixture
