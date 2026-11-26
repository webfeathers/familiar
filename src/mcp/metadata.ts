/**
 * RFC 9728 protected-resource metadata and RFC 8414 authorization-server
 * metadata — the two documents Claude fetches before it will ever attempt a
 * sign-in.
 *
 * Every field below is required for a reason.
 */
import { ISSUER, RESOURCE, SCOPES } from './config.ts'

/**
 * RFC 9728. `resource` must equal the MCP URL as discovered, including path.
 *
 * `authorization_servers` lists exactly one entry: Claude uses only the first,
 * so a second would be silently ignored and is pure misdirection for a reader.
 */
export const protectedResourceMetadata = {
  resource: RESOURCE,
  authorization_servers: [ISSUER],
  bearer_methods_supported: ['header'],
  scopes_supported: [...SCOPES],
} as const

/**
 * RFC 8414.
 *
 * `token_endpoint_auth_methods_supported: ["none"]` AND
 * `client_id_metadata_document_supported: true` must BOTH be present, or Claude
 * falls back to Dynamic Client Registration — which we deliberately do not
 * implement — and the connection fails.
 *
 * `code_challenge_methods_supported` must advertise S256: clients are required
 * to refuse to proceed if it is absent.
 */
export const authorizationServerMetadata = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  revocation_endpoint: `${ISSUER}/revoke`,
  scopes_supported: [...SCOPES],
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  token_endpoint_auth_methods_supported: ['none'],
  code_challenge_methods_supported: ['S256'],
  client_id_metadata_document_supported: true,
  /**
   * RFC 9207. SHOULD in the current revision, MUST in 2026-07-28 — cheap to
   * emit now so that migration is a no-op.
   */
  authorization_response_iss_parameter_supported: true,
} as const

/**
 * The 401 challenge. Claude will NOT honour a `WWW-Authenticate` header on a
 * 200 response — returning 200 with an error body produces no sign-in prompt at
 * all, which presents as a connector that silently does nothing.
 */
export function wwwAuthenticate(error?: string, description?: string): string {
  const parts = [
    `Bearer error="${error ?? 'invalid_token'}"`,
    ...(description ? [`error_description="${description}"`] : []),
    `resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp"`,
    `scope="${SCOPES.join(' ')}"`,
  ]
  return parts.join(', ')
}
