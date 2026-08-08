import { discoverLiteLLMMcpServers } from '../utils/litellm-api'
import type { LiteLLMMcpServer } from '../types'

/** Prefix applied to injected `mcp` keys when none is configured. */
export const DEFAULT_MCP_PREFIX = 'litellm_'

/**
 * A discovered MCP server reduced to what the injector needs.
 * `alias` is the gateway path segment; `key` is the resulting
 * `config.mcp` entry name.
 */
interface ResolvedMcpServer {
  key: string
  alias: string
}

/**
 * Pick the gateway routing alias for a discovered server.
 *
 * LiteLLM resolves `/mcp/<segment>` against the server alias first and
 * the server name second, so prefer `alias` and fall back to
 * `server_name`. Entries carrying neither can't be routed to and are
 * dropped by the caller.
 */
function routingAlias(server: LiteLLMMcpServer): string | undefined {
  const alias = typeof server.alias === 'string' ? server.alias.trim() : ''
  if (alias) return alias
  const name = typeof server.server_name === 'string' ? server.server_name.trim() : ''
  return name || undefined
}

/**
 * Build the streamable-HTTP gateway URL for one server.
 *
 * The `/mcp/<alias>` form is preferred over the equivalent
 * `/<alias>/mcp` because it is namespaced under the gateway mount and
 * therefore cannot collide with the proxy's own top-level routes.
 */
export function mcpGatewayURL(baseURL: string, alias: string): string {
  return `${baseURL}/mcp/${alias.split('/').map(encodeURIComponent).join('/')}`
}

/**
 * Discover the MCP servers reachable with `apiKey` and inject one
 * `config.mcp` entry per server.
 *
 * Per-server entries (rather than a single aggregate `/mcp/` entry)
 * keep tool names unprefixed, let OpenCode report health per server,
 * and stop one unreachable upstream from taking down the rest.
 *
 * Returns a short summary for logging, or `null` when discovery failed.
 */
export async function injectMcpServers(options: {
  mcp: Record<string, unknown>
  baseURL: string
  apiKey?: string
  customHeaders?: Record<string, string>
  include: RegExp[]
  exclude: RegExp[]
  prefix: string
  enabled: boolean
}): Promise<{ added: number; total: number; filteredOut: number; skipped: number } | null> {
  const { mcp, baseURL, apiKey, customHeaders, include, exclude, prefix, enabled } = options

  let discovered: LiteLLMMcpServer[]
  try {
    discovered = await discoverLiteLLMMcpServers(baseURL, apiKey, customHeaders)
  } catch (error) {
    console.warn(
      '[opencode-litellm] MCP discovery failed:',
      error instanceof Error ? error.message : String(error),
    )
    return null
  }

  const resolved: ResolvedMcpServer[] = []
  let filteredOut = 0
  let skipped = 0

  for (const server of discovered) {
    const alias = routingAlias(server)
    if (!alias) {
      skipped++
      continue
    }
    // Globs match the routing alias, which is the stable id a user sees
    // in LiteLLM — not the prefixed OpenCode key.
    if (
      (include.length > 0 && !include.some((p) => p.test(alias))) ||
      exclude.some((p) => p.test(alias))
    ) {
      filteredOut++
      continue
    }
    resolved.push({ key: `${prefix}${alias.replace(/\//g, '_')}`, alias })
  }

  // Authenticate with `x-litellm-api-key` rather than `Authorization`
  // so the header is unambiguously the LiteLLM credential even when a
  // server delegates `Authorization` to its upstream. The `Bearer `
  // prefix is mandatory — LiteLLM rejects a bare key on this header.
  //
  // The value is the resolved secret, not a `{env:…}` placeholder:
  // OpenCode interpolates those at config load, which has already
  // happened by the time plugins run.
  const headers: Record<string, string> = {}
  if (apiKey) headers['x-litellm-api-key'] = `Bearer ${apiKey}`
  if (customHeaders) Object.assign(headers, customHeaders)

  let added = 0
  for (const server of resolved) {
    // Never clobber a hand-written entry — same precedence rule the
    // model injector uses for curated `models`.
    if (mcp[server.key]) continue
    const entry: Record<string, unknown> = {
      type: 'remote',
      url: mcpGatewayURL(baseURL, server.alias),
      enabled,
    }
    if (Object.keys(headers).length > 0) entry.headers = headers
    mcp[server.key] = entry
    added++
  }

  return { added, total: discovered.length, filteredOut, skipped }
}
