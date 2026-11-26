import { expect, test } from 'claude-code/testing'

test('each tool call raises the count in the status bar', async ($, on) => {
  const shown: (string | undefined)[] = []
  let saved: unknown = 5
  on('ui.status', (_, e) => {
    shown.push(e.text)
    return { value: undefined }
  })
  on('store.get', () => ({ value: saved }))
  on('store.set', (_, e) => {
    saved = (e as { value: unknown }).value
    return { value: undefined }
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  on('clock.every', () => ({ value: { cancel: () => undefined } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.tool.call({ tool: 'Bash', command: 'pwd' })

  expect(shown).toContain('tools: 5')
  expect(shown.at(-1)).toBe('tools: 7')
  expect(saved).toBe(7)
})
