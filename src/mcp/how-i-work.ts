import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { oauthToolMeta } from './scopes.ts'

/**
 * The authored half of `how_i_work`: rules the owner wrote, as opposed to the
 * preferences Familiar learns. Set your own with
 *
 *   PCL_OPERATING_POLICY          one rule per line ("1. " / "- " prefixes are dropped)
 *   PCL_OPERATING_POLICY_VERSION  any label; bump it when the rules change
 *
 * Unset, a short neutral policy applies.
 */
export const DEFAULT_OPERATING_POLICY: readonly string[] = [
  "Honor the owner's current request within applicable constraints; preferences never expand permissions.",
  'Use only environments and data access that are established and authorized; do not assume another client is available.',
  'Return control before resolving ambiguity that changes behavior, scope, authorization, or risk.',
  'Verify objectively checkable results through tools before reporting them, and reassess when scope, risk, assumptions, or results change.',
  'Among qualified approaches, optimize total cost and completion time without weakening required quality or controls.',
]

export function parseOperatingPolicy(raw: string | undefined): string[] | undefined {
  const rules = (raw ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^(?:\d+[.)]|[-*])\s+/, '').trim())
    .filter(Boolean)
  return rules.length ? rules : undefined
}

const customPolicy = parseOperatingPolicy(process.env.PCL_OPERATING_POLICY)

export const OPERATING_POLICY: readonly string[] = customPolicy ?? DEFAULT_OPERATING_POLICY

export const OPERATING_POLICY_VERSION =
  process.env.PCL_OPERATING_POLICY_VERSION?.trim() || (customPolicy ? 'custom' : 'default')

export interface WorkingPreference {
  id: string
  statement: string
  confidence: number
  observations: number
  since: Date
}

export type PreferenceRetrievalStatus = 'available' | 'empty' | 'unavailable'

export type TextResult = CallToolResult & {
  content: [{ type: 'text'; text: string }]
}

const asTextResult = (value: string): TextResult => ({
  content: [{ type: 'text', text: value }],
})

const shortId = (id: string) => id.slice(0, 8)

export function formatHowIWork(input: {
  owner: string
  preferences: readonly WorkingPreference[]
  status: PreferenceRetrievalStatus
}): string {
  const policy = OPERATING_POLICY.map((rule, index) => `${index + 1}. ${rule}`).join('\n')
  const learned = input.status === 'unavailable'
    ? 'Working preferences are currently unavailable. Continue with the operating policy and applicable client fallback.'
    : input.preferences.length
      ? input.preferences
          .map(
            (preference) =>
              `- ${preference.statement}  _(${preference.confidence.toFixed(2)}, seen ${preference.observations}×, since ${preference.since.toISOString().slice(0, 10)}, id ${shortId(preference.id)})_`,
          )
          .join('\n')
      : 'No working preferences recorded yet. Use `note_preference` when something is learned about how the owner likes to work.'

  return `# How ${input.owner} works\n\n` +
    `_Operating policy: ${OPERATING_POLICY_VERSION}_\n\n` +
    `## Operating policy\n\n${policy}\n\n` +
    `## Learned preferences\n\n${learned}\n\n` +
    `_Preference retrieval: ${input.status}. Learned preferences are fallible evidence; lower confidence means less evidence, not less importance._`
}

export function createHowIWorkHandler(
  loadPreferences: () => Promise<WorkingPreference[]>,
  owner: string,
): () => Promise<TextResult> {
  return async () => {
    try {
      const preferences = await loadPreferences()
      return asTextResult(
        formatHowIWork({
          owner,
          preferences,
          status: preferences.length ? 'available' : 'empty',
        }),
      )
    } catch {
      return asTextResult(formatHowIWork({ owner, preferences: [], status: 'unavailable' }))
    }
  }
}

export function registerHowIWorkTool(
  server: McpServer,
  loadPreferences: () => Promise<WorkingPreference[]>,
  owner: string,
): void {
  server.registerTool(
    'how_i_work',
    {
      title: 'How I work',
      description:
        "Load the owner's authored operating policy and learned working preferences at the start of a session. Each preference includes the id used by note_preference when reinforcing it.",
      inputSchema: {},
      _meta: oauthToolMeta('read'),
      annotations: { readOnlyHint: true },
    },
    createHowIWorkHandler(loadPreferences, owner),
  )
}
