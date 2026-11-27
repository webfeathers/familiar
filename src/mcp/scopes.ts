/** OAuth grants apply to Grimalkin context, not the upstream Google APIs. */
export const SCOPES = ['context:read', 'context:write'] as const
export const DEFAULT_SCOPE = SCOPES.join(' ')
export type ContextScope = (typeof SCOPES)[number]

/** Read access is the baseline; write access must be explicitly in the grant. */
export function normalizeScope(requested: unknown = DEFAULT_SCOPE): string | null {
  if (typeof requested !== 'string') return null
  const scopes = requested.trim().split(/\s+/)
  if (!scopes.includes('context:read') ||
      scopes.some((scope) => !SCOPES.includes(scope as ContextScope))) return null
  return SCOPES.filter((scope) => scopes.includes(scope)).join(' ')
}

export function hasScope(granted: unknown, required: ContextScope): boolean {
  return typeof granted === 'string' && granted.split(/\s+/).includes(required)
}

export function consentDescription(scope: string): string {
  return hasScope(scope, 'context:write')
    ? 'It will be able to read your context, add and correct remembered facts, forget facts, and record working preferences.'
    : 'It will be able to read your context. It will not be able to change remembered facts or working preferences.'
}

/** SDK 1.x preserves per-tool OAuth declarations through this supported metadata surface. */
export function oauthToolMeta(access: 'read' | 'write') {
  return { securitySchemes: [{ type: 'oauth2', scopes: access === 'write' ? [...SCOPES] : ['context:read'] }] }
}

/** Check before any mutation, including writes hidden in a tool's helpers.
 * The HTTP entry point supplies the resource-specific challenge. The fallback is
 * also a valid Bearer scope challenge for already-discovered/in-process clients.
 */
export function writeDenied(scope: unknown, challenge =
  'Bearer error="insufficient_scope", error_description="context:write is required", scope="context:read context:write"') {
  if (hasScope(scope, 'context:read') && hasScope(scope, 'context:write')) return null
  return {
    isError: true,
    _meta: { 'mcp/www_authenticate': [challenge] },
    content: [{ type: 'text' as const, text: 'Insufficient scope: context:write is required. Reconnect and approve read/write access.' }],
  }
}
