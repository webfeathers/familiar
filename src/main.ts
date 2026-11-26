/**
 * Single entrypoint, role-selected.
 *
 * One image, two deployments: the MCP service and the worker run the same
 * build and differ only by PCL_ROLE. That keeps the start command identical
 * across services — the role lives in version-controlled config rather than in
 * a dashboard field nobody remembers is set.
 */
const role = process.env.PCL_ROLE ?? 'mcp'

switch (role) {
  case 'mcp':
    await import('./mcp/server.ts')
    break
  case 'worker':
    await import('./worker/index.ts')
    break
  default:
    console.error(`unknown PCL_ROLE "${role}" — expected "mcp" or "worker"`)
    process.exit(1)
}
