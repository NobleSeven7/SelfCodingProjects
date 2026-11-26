export type Gauge = { percent: number | null; resetsAt: string | null }

export type Usage = {
  ctx: Gauge
  five: Gauge
  seven: Gauge
  /** When this reading (or the last minute tick) was taken, ms since epoch. */
  at: number
}

/** The prompt cache as the last main-thread reply left it. */
export type CacheReading = {
  /** Share of that reply's input served from the cache, 0-100. */
  percent: number
  /** When that reply arrived, ms since epoch. */
  lastAt: number
  /** How long the cache entry lives without being read: 5 minutes or 1 hour. */
  ttlMs: number
}

declare module 'claude-code' {
  interface PluginState {
    'usage-gauges': {
      usage: Usage | null
      cache: CacheReading | null
      /** A ✨ rewrite is running. */
      enhanceBusy: boolean
      /** The draft before the last rewrite, for Undo; null when there's nothing to undo. */
      enhanceUndo: string | null
      /** Which spinner frame ✨ shows while busy. */
      spinFrame: number
    }
  }
}
