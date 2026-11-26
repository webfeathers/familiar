import assert from 'node:assert/strict'
import test from 'node:test'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  createHowIWorkHandler,
  DEFAULT_OPERATING_POLICY,
  OPERATING_POLICY,
  OPERATING_POLICY_VERSION,
  parseOperatingPolicy,
  registerHowIWorkTool,
} from '../src/mcp/how-i-work.ts'
import type { TextResult } from '../src/mcp/how-i-work.ts'

const preferences = [
  {
    id: '12345678-aaaa-bbbb-cccc-1234567890ab',
    statement: 'Prefers conclusions first',
    confidence: 0.91,
    observations: 4,
    since: new Date('2026-01-01'),
  },
  {
    id: '87654321-aaaa-bbbb-cccc-1234567890ab',
    statement: 'Prefers concise updates',
    confidence: 0.67,
    observations: 1,
    since: new Date('2026-02-01'),
  },
]

test('returns versioned policy before learned preferences without task input', async () => {
  const handler = createHowIWorkHandler(async () => preferences, 'Test Owner')
  assert.equal(handler.length, 0)

  const result = await handler()
  const body = result.content[0].text

  assert.match(body, new RegExp(`Operating policy: ${OPERATING_POLICY_VERSION}`))
  assert.ok(body.indexOf('## Operating policy') < body.indexOf('## Learned preferences'))
  assert.match(
    body,
    /- Prefers conclusions first  _\(0\.91, seen 4×, since 2026-01-01, id 12345678\)_/,
  )
  assert.match(
    body,
    /- Prefers concise updates  _\(0\.67, seen 1×, since 2026-02-01, id 87654321\)_/,
  )
  assert.ok(body.indexOf('Prefers conclusions first') < body.indexOf('Prefers concise updates'))
  assert.match(body, /Preference retrieval: available/)
})

test('returns policy and an empty retrieval status when no preferences exist', async () => {
  const handler = createHowIWorkHandler(async () => [], 'Test Owner')
  const body = (await handler()).content[0].text

  assert.match(body, /## Operating policy/)
  assert.match(body, /No working preferences recorded yet/)
  assert.match(body, /Preference retrieval: empty/)
})

test('returns policy and an unavailable status when preference retrieval fails', async () => {
  const handler = createHowIWorkHandler(async () => {
    throw new Error('database unavailable')
  }, 'Test Owner')
  const body = (await handler()).content[0].text

  assert.match(body, /## Operating policy/)
  assert.match(body, /Working preferences are currently unavailable/)
  assert.match(body, /Preference retrieval: unavailable/)
  assert.doesNotMatch(body, /No working preferences recorded yet/)
})

test('authored policy is vendor independent', () => {
  const policy = OPERATING_POLICY.join('\n')
  assert.doesNotMatch(policy, /Claude|OpenAI|GPT|Sonnet|Opus|Haiku|Fable|Gemini/i)
})

test('an unset policy falls back to the neutral default', () => {
  assert.equal(parseOperatingPolicy(undefined), undefined)
  assert.equal(parseOperatingPolicy('  \n \n'), undefined)
  assert.doesNotMatch(DEFAULT_OPERATING_POLICY.join('\n'), /Claude|OpenAI|GPT|Sonnet|Opus|Haiku|Fable|Gemini/i)
})

test('a configured policy is one rule per line, list markers dropped', () => {
  assert.deepEqual(parseOperatingPolicy('1. First rule\r\n\n- Second rule\n  3) Third rule  \nFourth'), [
    'First rule',
    'Second rule',
    'Third rule',
    'Fourth',
  ])
})

test('how_i_work MCP registration uses the policy handler', async () => {
  let captured: {
    name: string
    description: string
    handler: () => Promise<TextResult>
  } | undefined
  const server = {
    registerTool(
      name: string,
      config: { description: string },
      handler: () => Promise<TextResult>,
    ) {
      captured = { name, description: config.description, handler }
    },
  } as unknown as McpServer

  registerHowIWorkTool(server, async () => preferences, 'Test Owner')

  assert.equal(captured?.name, 'how_i_work')
  assert.match(
    captured?.description ?? '',
    /authored operating policy and learned working preferences/,
  )
  assert.match((await captured!.handler()).content[0].text, /## Operating policy/)
})
