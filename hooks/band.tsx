import { atom, read, update } from 'claude-code'
import type { On } from 'claude-code'

import type { Reading } from '../types'

import { weatherLine } from './weather'

// What the watcher last noted, above the prompt: the person sees it as it lands, the
// way "You should know" shows its cards. The model has already read the same items
// as a note; the band is only the person's copy.
const cards = atom({ plugin: 'deepseek-supervisor', key: 'cards' } as const, null)
const isHidden = atom({ plugin: 'deepseek-supervisor', key: 'isHidden' } as const, false)
// The context window's last readings, taken in register.ts.
const readings = atom({ plugin: 'deepseek-supervisor', key: 'readings' } as const, [] as Reading[])

const hhmm = (ms: number) => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export const registerBand = (on: On) => {
  // One hook for the spot: the context line (weather.tsx) on top, the items below it
  // when there are any, else whatever other plugins draw there.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const history = await read($, readings)
    const shown = await read($, cards)
    if (shown === null || shown.items.length === 0 || (await read($, isHidden))) return weatherLine(history, e.props.bodyColumns, { Box, Text } as never, await next(e))

    return weatherLine(
      history,
      e.props.bodyColumns,
      { Box, Text } as never,
      <Box flexDirection="column">
        <Box>
          <Text bold>
            deepseek-supervisor · noted {shown.items.length} ({hhmm(shown.at)}){' '}
          </Text>
          <Button key="hide" label="Hide" onPress={() => update($, isHidden, () => true)} />
        </Box>
        {shown.items.map((f, i) => (
          <Text key={`item-${i}`} wrap="truncate-end">
            {i + 1}. {f.what}
          </Text>
        ))}
      </Box>,
    )
  })
}
