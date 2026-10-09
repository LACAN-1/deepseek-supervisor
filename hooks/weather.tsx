import type { Reading } from '../types'

// Token Weather, from "Getting started with Claude Code mods" (Anthropic,
// 2026-10-01): a live forecast of the context window, above the prompt. A
// third-party endpoint shows no usage of its own, so it rides along with the
// supervisor. Readings are taken in register.ts and the line is drawn in band.tsx
// (a plugin registers each event once, and $ never crosses an import); here are
// only the parts that need no $. Unlike the original, the line stacks over whatever
// is drawn beneath it: this plugin's band of items, or another plugin's.

export const HISTORY = 12
const BARS = '▁▂▃▄▅▆▇█'
const FORECAST = [
  { upTo: 25, icon: '☀', word: 'Clear', color: 'yellow' },
  { upTo: 50, icon: '☁', word: 'Cloudy', color: 'cyan' },
  { upTo: 75, icon: '☂', word: 'Showers', color: 'blue' },
  { upTo: 90, icon: '☇', word: 'Storm', color: 'magenta' },
  { upTo: Infinity, icon: '↯', word: 'Compact soon', color: 'red' },
] as const

const short = (n: number) => {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${+(n / 1_000).toFixed(1)}k`
  return String(n)
}

const sparkline = (history: readonly Reading[]) => {
  const top = Math.max(...history.map(r => r.tokens), 1)
  return history.map(r => BARS[Math.floor((r.tokens / top) * (BARS.length - 1))]).join('')
}

const trend = (history: readonly Reading[]) => {
  const delta = (history.at(-1)?.tokens ?? 0) - (history.at(-2)?.tokens ?? 0)
  if (delta === 0) return '  steady'
  return delta > 0 ? `  ▲ +${short(delta)} last turn` : `  ▼ ${short(-delta)} last turn`
}

/** The reading a usage report gives, or none when the host reports no window. */
export const readingOf = (context: { tokens?: number | null; window?: number | null; percent?: number | null } | null | undefined): Reading | undefined => {
  if (!context?.window) return undefined
  const tokens = context.tokens ?? 0
  return { tokens, window: context.window, percent: context.percent ?? Math.round((tokens / context.window) * 100) }
}

// The components come from $.ui.resolve in band.tsx.
type Parts = { Box: (p: Record<string, unknown>) => unknown; Text: (p: Record<string, unknown>) => unknown }

/** The forecast line over `below`; `below` alone when there is no reading yet. */
export const weatherLine = (history: readonly Reading[], columns: number, { Box, Text }: Parts, below: unknown) => {
  const now = history.at(-1)
  if (now === undefined) return below
  const f = FORECAST.find(b => now.percent < b.upTo) ?? FORECAST[4]
  const wide = columns >= 60
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" paddingX={1}>
        <Text color={f.color} bold>
          {`${f.icon}  ${f.word}`}
        </Text>
        <Text>{`  ${now.percent}% of context`}</Text>
        <Text dimColor>{`  ${short(now.tokens)} / ${short(now.window)}`}</Text>
        {wide && <Text dimColor>{'   last turns '}</Text>}
        {wide && <Text color={f.color}>{sparkline(history)}</Text>}
        {wide && history.length > 1 && <Text dimColor>{trend(history)}</Text>}
      </Box>
      {below}
    </Box>
  )
}
