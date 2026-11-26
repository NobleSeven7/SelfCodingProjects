export type Gauge = { percent: number | null; resetsAt: string | null }

export type Usage = {
  ctx: Gauge
  five: Gauge
  seven: Gauge
  /** When this reading (or the last minute tick) was taken, ms since epoch. */
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'usage-gauges': { usage: Usage | null }
  }
}
