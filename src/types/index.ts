// Core types for the LiteLLM OpenCode plugin

/**
 * A single model entry returned by LiteLLM's `/v1/models` endpoint.
 * LiteLLM follows the OpenAI-compatible schema.
 */
export interface LiteLLMModel {
  id: string
  object: string
  created?: number
  owned_by?: string
  /**
   * LiteLLM-specific extension. Some deployments include the underlying
   * provider (e.g. "openai", "anthropic", "bedrock") here.
   */
  litellm_provider?: string
  /**
   * Optional capability metadata. Present on `/v1/models` only for some
   * deployments; reliably available via `/v1/model/info` and merged onto
   * the discovered entry by the plugin.
   *
   * Newer LiteLLM versions may expose `'responses'` here for models
   * that must be routed through the OpenAI Responses API rather than
   * `/v1/chat/completions` (e.g. `gpt-5*`, `o1/o3/o4*` with reasoning).
   */
  mode?: string
  max_tokens?: number
  max_input_tokens?: number
  max_output_tokens?: number
  supports_function_calling?: boolean
  supports_vision?: boolean
  supports_reasoning?: boolean
  supports_pdf_input?: boolean
  supports_audio_input?: boolean
  input_cost_per_token?: number
  output_cost_per_token?: number
  cache_read_input_token_cost?: number
  cache_creation_input_token_cost?: number
}

export interface LiteLLMModelsResponse {
  object: string
  data: LiteLLMModel[]
}

/**
 * The `model_info` block of a `/v1/model/info` entry. This endpoint
 * reliably carries `mode` (and token limits) even for database-defined
 * models, where `/v1/models` only returns the lean OpenAI schema.
 */
export interface LiteLLMModelInfo {
  id?: string
  db_model?: boolean
  /** Alias LiteLLM assigns to the model; mirrors the `/v1/models` id. */
  key?: string
  mode?: string
  max_tokens?: number
  max_input_tokens?: number
  max_output_tokens?: number
  supports_function_calling?: boolean
  supports_vision?: boolean
  supports_reasoning?: boolean
  supports_pdf_input?: boolean
  supports_audio_input?: boolean
  /** USD per input token; converted to per-million for OpenCode `cost`. */
  input_cost_per_token?: number
  output_cost_per_token?: number
  cache_read_input_token_cost?: number
  cache_creation_input_token_cost?: number
}

/** A single entry returned by LiteLLM's `/v1/model/info` endpoint. */
export interface LiteLLMModelInfoEntry {
  model_name: string
  litellm_params?: Record<string, unknown>
  model_info?: LiteLLMModelInfo
}

export interface LiteLLMModelInfoResponse {
  data?: LiteLLMModelInfoEntry[]
}

/**
 * A single MCP server entry returned by LiteLLM's `/v1/mcp/server`
 * endpoint.
 *
 * Only the fields the plugin relies on are typed. Responses to virtual
 * keys restricted to `llm_api_routes` are sanitised by the proxy — most
 * notably `url` is stripped — so nothing beyond the name/alias can be
 * assumed present.
 */
export interface LiteLLMMcpServer {
  server_id?: string
  server_name?: string
  /** Routing alias; what the gateway path segment must be built from. */
  alias?: string
  description?: string
  /** `http`, `sse` or `stdio` — upstream transport, not the gateway's. */
  transport?: string
  auth_type?: string
}

/**
 * `/v1/mcp/server` returns a bare array. The envelope form is accepted
 * defensively in case a future LiteLLM version wraps it.
 */
export type LiteLLMMcpServerResponse = LiteLLMMcpServer[] | { data?: LiteLLMMcpServer[] }

export type ModelType = 'chat' | 'embedding' | 'image' | 'audio' | 'unknown'

/**
 * Which OpenAI-compatible HTTP surface a model should be invoked through.
 *
 * - `chat`      → `/v1/chat/completions` (most models)
 * - `responses` → `/v1/responses`        (gpt-5*, o-series with reasoning)
 */
export type Transport = 'chat' | 'responses'

/**
 * User-facing routing override. Defaults to `'auto'`.
 *
 * - `'auto'`      → use the heuristic + LiteLLM `mode` field
 * - `'chat'`      → force every discovered model into the chat-completions provider
 * - `'responses'` → force every discovered model into the responses provider
 */
export type TransportPolicy = 'auto' | Transport

/**
 * A single {@link LiteLLMOptions.modelDefaults} rule: a glob allowlist
 * over model ids and the partial config-level model entry to merge in
 * for matches.
 */
export interface ModelDefaultsRule {
  /** `*`-globs matched against the LiteLLM model id. */
  match: string[]
  /** `*`-globs excluded from this rule; evaluated after {@link match}. */
  exclude?: string[]
  /** Partial OpenCode model entry (`limit`, `cost`, `variants`, …). */
  model: Record<string, unknown>
}

export interface LiteLLMOptions {
  baseURL?: string
  apiKey?: string
  /**
   * Mark a provider with any id (e.g. `my-proxy`) as LiteLLM-backed so
   * the plugin discovers models for it. Providers whose id is `litellm`
   * or starts with `litellm-`/`litellm_` are matched automatically.
   */
  litellm?: boolean
  /**
   * Base URL used ONLY for model discovery (`/v1/models`,
   * `/v1/model/info`). Set this when the provider's `baseURL` points at
   * an adapter-specific path that isn't the proxy root — e.g. the
   * `@ai-sdk/google` adapter needs `…/v1beta/models`, which is not a
   * valid discovery root. Defaults to `baseURL`.
   */
  discoveryBaseURL?: string
  /**
   * Glob allowlist applied to discovered model ids (`*` matches any
   * characters). When set, ONLY matching models are injected into this
   * provider. Essential when several providers share one LiteLLM proxy
   * and each should receive a different slice of the catalog, e.g.
   * `["CLIProxyAnthropic/*"]` for an `@ai-sdk/anthropic` provider.
   * Defaults to all models.
   */
  modelFilter?: string[]
  /**
   * Glob denylist applied after {@link modelFilter}. Matching models
   * are never injected. Hand-curated `models` entries are unaffected.
   */
  excludeModels?: string[]
  /**
   * Enrich discovered models with metadata from https://models.dev
   * (pricing, limits, modalities, and `reasoning_options`-derived
   * `variants` for thinking/effort control). Defaults to `true`; set to
   * `false` to disable the catalog fetch.
   */
  modelsDev?: boolean
  /**
   * Fallback metadata for discovered models the models.dev catalog does
   * not know — typically self-hosted builds whose ids carry quantization
   * suffixes (`omlx/Qwen3.6-27B-oQ8-fp16-mtp`).
   *
   * Each rule is a `*`-glob over the LiteLLM model id plus a partial
   * model entry. Rules are evaluated in order and applied AFTER
   * discovery and models.dev enrichment, filling only fields that are
   * still missing — real catalog data always wins, and a later rule
   * never overwrites an earlier one.
   *
   * ```json
   * "modelDefaults": [
   *   {
   *     "match": ["omlx/*"],
   *     "model": {
   *       "reasoning": true,
   *       "variants": { "low": { "reasoningEffort": "low" } }
   *     }
   *   }
   * ]
   * ```
   */
  modelDefaults?: ModelDefaultsRule[]
  /**
   * Discover the MCP servers exposed by the proxy (`/v1/mcp/server`)
   * and inject one `mcp` entry per server into the OpenCode config,
   * pointing at the proxy's MCP gateway.
   *
   * Opt-in (defaults to `false`) because — unlike model discovery,
   * which only touches this provider — it writes to the top-level
   * `mcp` section. When several providers share one proxy, enable it
   * on exactly one of them; the plugin injects a given proxy's servers
   * only once regardless.
   *
   * Requires a key allowed to GET `/v1/mcp/server`. Keys restricted to
   * `llm_api_routes` qualify via LiteLLM's GET-only carve-out.
   */
  litellmMcp?: boolean
  /**
   * Initial enabled state for discovered MCP servers. Defaults to
   * `true`. Set to `false` to register servers without starting them,
   * so they can be enabled on demand in OpenCode.
   */
  litellmMcpEnabled?: boolean
  /**
   * Prefix for injected `mcp` keys, keeping them distinct from
   * hand-written entries. Defaults to `"litellm_"`, so a LiteLLM server
   * aliased `zread` becomes `litellm_zread`.
   *
   * Set to `""` to inject under the bare alias — only safe if no
   * hand-written entry can collide.
   */
  litellmMcpPrefix?: string
  /**
   * Glob allowlist applied to discovered MCP servers (`*` matches any
   * characters). When set, ONLY matching servers are injected.
   * Defaults to all servers.
   *
   * Globs match the LiteLLM routing alias (e.g. `zread`), NOT the
   * prefixed OpenCode key.
   */
  mcpFilter?: string[]
  /**
   * Glob denylist applied after {@link mcpFilter}. Matching servers are
   * never injected. Hand-written `mcp` entries are unaffected.
   *
   * Useful for suppressing servers the proxy registers but that expose
   * no usable tools.
   */
  excludeMcpServers?: string[]
  /**
   * Routing policy for discovered models. See {@link TransportPolicy}.
   * Defaults to `'auto'`.
   */
  transport?: TransportPolicy
  /**
   * Explicit allowlist of model ids that MUST be routed through the
   * OpenAI Responses API (`/v1/responses`). Takes priority over the
   * heuristic and over the `transport` policy.
   *
   * Match is exact against the LiteLLM model id (e.g. `"gpt-5-4-high"`).
   */
  responsesApiModels?: string[]
  /**
   * Explicit denylist of model ids that MUST be routed through chat
   * completions (`/v1/chat/completions`), even if the heuristic would
   * otherwise put them in the responses bucket. Takes priority over
   * the heuristic but is overridden by `responsesApiModels`.
   */
  chatApiModels?: string[]
  /**
   * Arbitrary HTTP headers to include in every request to the LiteLLM
   * proxy during model discovery (health check + `/v1/models`).
   *
   * Useful for proxies behind Cloudflare Access or other gateways that
   * require extra authentication headers beyond the standard
   * `Authorization: Bearer` token.
   *
   * Example (Cloudflare Access Service Token):
   * ```json
   * {
   *   "customHeaders": {
   *     "CF-Access-Client-Id": "{env:CF_ACCESS_CLIENT_ID}",
   *     "CF-Access-Client-Secret": "{env:CF_ACCESS_CLIENT_SECRET}"
   *   }
   * }
   * ```
   */
  customHeaders?: Record<string, string>
}
