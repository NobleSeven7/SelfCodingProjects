import { expect, test } from 'claude-code/testing'

import { sharedPathFrom } from '../hooks/register'

// The test harness has no plugin data folder, so here the mod keeps its count
// in its own store; it re-reads the total before every call the same way it
// re-reads the shared file in a real session.
function engine(on: any, store: Map<string, unknown>, shown: (string | undefined)[]) {
  on('ui.status', (_: unknown, e: { text?: string }) => {
    shown.push(e.text)
    return { value: undefined }
  })
  on('store.get', (_: unknown, e: { key: string }) => ({ value: store.get(e.key) }))
  on('store.set', (_: unknown, e: { key: string; value: unknown }) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  on('clock.every', () => ({ value: { cancel: () => undefined } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
}

test('every copy of the mod finds the same shared file', async () => {
  const dev = sharedPathFrom('D:\\ClaudeCode\\plugins\\data\\usage-gauges-inline-2bc0097be09e')
  const installed = sharedPathFrom('D:\\ClaudeCode\\plugins\\data\\usage-gauges-selfcodingprojects\\')
  expect(dev).toBe('D:\\ClaudeCode\\plugins\\data/usage-gauges-shared/tool-count.json')
  expect(installed).toBe(dev)
  expect(sharedPathFrom(undefined)).toBe(null)
})

test('the count picks up where it left off, and simultaneous calls each add 1', async ($, on) => {
  const store = new Map<string, unknown>([['toolCount', 94]])
  const shown: (string | undefined)[] = []
  engine(on, store, shown)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await Promise.all([
    $.tool.call({ tool: 'Bash', command: 'ls' }),
    $.tool.call({ tool: 'Bash', command: 'pwd' }),
  ])

  expect(shown).toContain('tools: 94')
  expect(shown.at(-1)).toBe('tools: 96')
  expect(store.get('toolCount')).toBe(96)
})

test('calls made in another session are kept', async ($, on) => {
  const store = new Map<string, unknown>([['toolCount', 120]])
  const shown: (string | undefined)[] = []
  engine(on, store, shown)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(shown.at(-1)).toBe('tools: 120')

  await $.tool.call({ tool: 'Bash', command: 'ls' })
  // Meanwhile another session adds 5 more.
  store.set('toolCount', 126)
  await $.tool.call({ tool: 'Bash', command: 'pwd' })

  expect(shown.at(-1)).toBe('tools: 127')
})
