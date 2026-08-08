import type { Plugin, PluginInput } from '@opencode-ai/plugin'
import {
  autoDetectLiteLLM,
  checkLiteLLMHealth,
  discoverLiteLLMModelInfo,
  discoverLiteLLMModels,
  normalizeBaseURL,
} from '../utils/litellm-api'
import { categorizeModel } from '../utils/format-model-name'
import {
  applyModelsDevMetadata,
  loadModelsDevIndex,
  matchModelsDev,
} from '../utils/models-dev'
import { DEFAULT_MCP_PREFIX, injectMcpServers } from './mcp'
import type { LiteLLMModel, LiteLLMModelInfo } from '../types'

const CHAT_PROVIDER_ID = 'litellm'
// Covers the sequential 3 s health check plus the parallel 15 s
// models/model-info fetch phase, with headroom.
const DISCOVERY_TIMEOUT_MS = 20000

/**
 * OpenCode invokes the `config` hook several times per run with a
 * cumulative config object. Track which model ids we already injected
 * per baseURL so repeat invocations can return early instead of
 * re-querying the proxy.
 */
const injectedModelIds = new Map<string, Set<string>>()

/**
 * MCP servers belong to the proxy, not to a provider, so several
 * providers pointing at one proxy must not each inject the same set.
 * Keyed by discovery baseURL, for the same repeat-invocation reason as
 * {@link injectedModelIds}.
 */
const injectedMcpBaseURLs = new Set<string>()

/**
 * Helper to determine if a provider ID or its configured options indicate
 * compatibility with LiteLLM.
 */
function isLiteLLMProvider(
  providerId: string,
  options: Record<string, unknown>,
): boolean {
  if (providerId === CHAT_PROVIDER_ID) return true
  if (providerId.startsWith('litellm-') || providerId.startsWith('litellm_')) return true
  if (options.litellm === true) return true
  if (options.litellmCompatible === true) return true
  if (options['litellm-compatible'] === true) return true
  if (options.litellm_compatible === true) return true
  return false
}

/**
 * Compile a `*`-glob pattern (e.g. `CLIProxyAnthropic/*`) into an
 * anchored RegExp. Everything except `*` is matched literally.
 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`)
}

/**
 * Read a string-array option (`modelFilter` / `excludeModels` /
 * `mcpFilter` / `excludeMcpServers`) off the provider options block and
 * compile each entry as a glob.
 */
function readModelPatterns(
  options: Record<string, unknown>,
  key: 'modelFilter' | 'excludeModels' | 'mcpFilter' | 'excludeMcpServers',
): RegExp[] {
  const raw = options[key]
  if (!Array.isArray(raw)) return []
  return raw
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .map(globToRegExp)
}

/**
 * Read and compile `modelDefaults` rules off a provider options block.
 * Malformed entries are ignored rather than failing discovery.
 */
function readModelDefaults(
  options: Record<string, unknown>,
): Array<{ match: RegExp[]; exclude: RegExp[]; model: Record<string, unknown> }> {
  const raw = options.modelDefaults
  if (!Array.isArray(raw)) return []
  const compile = (v: unknown): RegExp[] =>
    Array.isArray(v)
      ? v.filter((p): p is string => typeof p === 'string' && p.length > 0).map(globToRegExp)
      : []
  const rules = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const rule = item as Record<string, unknown>
    const match = compile(rule.match)
    const model = rule.model
    if (match.length === 0) continue
    if (!model || typeof model !== 'object' || Array.isArray(model)) continue
    rules.push({
      match,
      exclude: compile(rule.exclude),
      model: model as Record<string, unknown>,
    })
  }
  return rules
}

/**
 * Recursively fill gaps in `target` from `defaults`. Existing values
 * always win; plain objects are merged key-by-key so a rule can add a
 * single missing variant without clobbering the discovered set.
 */
function fillDefaults(
  target: Record<string, unknown>,
  defaults: Record<string, unknown>,
): void {
  const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v)

  for (const [key, value] of Object.entries(defaults)) {
    const current = target[key]
    if (current === undefined) {
      target[key] = isPlainObject(value) ? structuredClone(value) : value
    } else if (isPlainObject(current) && isPlainObject(value)) {
      fillDefaults(current, value)
    }
  }
}

/**
 * Apply the first matching `modelDefaults` rule set to a model entry.
 * Every matching rule contributes, in declaration order, but only for
 * fields still missing after discovery + models.dev enrichment.
 */
function applyModelDefaults(
  entry: Record<string, unknown>,
  modelId: string,
  rules: Array<{ match: RegExp[]; exclude: RegExp[]; model: Record<string, unknown> }>,
): boolean {
  let applied = false
  for (const rule of rules) {
    if (!rule.match.some((p) => p.test(modelId))) continue
    if (rule.exclude.some((p) => p.test(modelId))) continue
    fillDefaults(entry, rule.model)
    applied = true
  }
  return applied
}

/**
 * Read `customHeaders` from a provider options block.
 */
function readCustomHeaders(
  options: Record<string, unknown>,
): Record<string, string> | undefined {
  const raw = options.customHeaders
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v
    }
    return Object.keys(out).length > 0 ? out : undefined
  }
  return undefined
}

/**
 * Overlay metadata from `/v1/model/info` onto a `/v1/models` entry.
 * Fields already present on the lean entry win; the info block only
 * fills gaps (notably `mode`, which `/v1/models` omits for
 * database-defined models).
 */
function enrichModel(model: LiteLLMModel, info: LiteLLMModelInfo): LiteLLMModel {
  return {
    ...model,
    mode: model.mode ?? info.mode,
    max_tokens: model.max_tokens ?? info.max_tokens,
    max_input_tokens: model.max_input_tokens ?? info.max_input_tokens,
    max_output_tokens: model.max_output_tokens ?? info.max_output_tokens,
    supports_function_calling: model.supports_function_calling ?? info.supports_function_calling,
    supports_vision: model.supports_vision ?? info.supports_vision,
    supports_reasoning: model.supports_reasoning ?? info.supports_reasoning,
    supports_pdf_input: model.supports_pdf_input ?? info.supports_pdf_input,
    supports_audio_input: model.supports_audio_input ?? info.supports_audio_input,
    input_cost_per_token: model.input_cost_per_token ?? info.input_cost_per_token,
    output_cost_per_token: model.output_cost_per_token ?? info.output_cost_per_token,
    cache_read_input_token_cost: model.cache_read_input_token_cost ?? info.cache_read_input_token_cost,
    cache_creation_input_token_cost: model.cache_creation_input_token_cost ?? info.cache_creation_input_token_cost,
  }
}

/** Convert LiteLLM's USD-per-token pricing to OpenCode's USD-per-million. */
function toPerMillion(costPerToken: number): number {
  return Math.round(costPerToken * 1e6 * 1e4) / 1e4
}

/**
 * Convert a discovered LiteLLM model into an OpenCode config-level
 * model entry (the shape used in `provider.*.models` inside
 * `opencode.json`). Returns `null` for non-chat models (embedding,
 * image, audio) — they can't be used as primary chat models and would
 * clutter the picker.
 */
function toConfigModel(model: LiteLLMModel): Record<string, unknown> | null {
  const type = categorizeModel(model)
  if (type === 'embedding' || type === 'image' || type === 'audio') {
    return null
  }
  const entry: Record<string, unknown> = {
    name: model.id,
  }
  if (model.max_input_tokens || model.max_output_tokens) {
    entry.limit = {
      context: model.max_input_tokens ?? 0,
      output: model.max_output_tokens ?? 0,
    }
  }
  if (model.supports_function_calling) {
    entry.tool_call = true
  }
  if (model.supports_reasoning) {
    entry.reasoning = true
  }
  if (model.supports_vision) {
    entry.attachment = true
  }
  const input: Array<'text' | 'image' | 'pdf' | 'audio'> = ['text']
  if (model.supports_vision) input.push('image')
  if (model.supports_pdf_input) input.push('pdf')
  if (model.supports_audio_input) input.push('audio')
  if (input.length > 1) {
    entry.modalities = { input, output: ['text'] }
  }
  if (model.input_cost_per_token != null || model.output_cost_per_token != null) {
    const cost: Record<string, number> = {
      input: toPerMillion(model.input_cost_per_token ?? 0),
      output: toPerMillion(model.output_cost_per_token ?? 0),
    }
    if (model.cache_read_input_token_cost != null) {
      cost.cache_read = toPerMillion(model.cache_read_input_token_cost)
    }
    if (model.cache_creation_input_token_cost != null) {
      cost.cache_write = toPerMillion(model.cache_creation_input_token_cost)
    }
    entry.cost = cost
  }
  return entry
}

/**
 * LiteLLM Plugin for OpenCode.
 *
 * Uses the `config` hook to discover models from a LiteLLM proxy and
 * inject them into the provider's `models` map at startup. This is the
 * only reliable way to dynamically populate a provider — the
 * `provider.models` hook is not called by OpenCode for custom providers.
 *
 * Configure the provider in your `opencode.json`:
 *
 * {
 *   "plugin": ["opencode-plugin-litellm@latest"],
 *   "provider": {
 *     "litellm": {
 *       "npm": "@ai-sdk/openai-compatible",
 *       "name": "LiteLLM (proxy)",
 *       "options": {
 *         "baseURL": "http://localhost:4000/v1",
 *         "apiKey": "{env:LITELLM_API_KEY}"
 *       }
 *     }
 *   }
 * }
 */
export const LiteLLMPlugin: Plugin = async (_input: PluginInput) => {
  return {
    config: async (config: any) => {
      // Ensure the provider entry exists
      if (!config.provider) config.provider = {}

      // Find all matching LiteLLM providers
      const providerIds = Object.keys(config.provider)
      const liteLLMProviders: Array<{ id: string; provider: Record<string, unknown> }> = []

      for (const id of providerIds) {
        const provider = config.provider[id]
        if (provider && typeof provider === 'object') {
          const options = (provider.options ?? {}) as Record<string, unknown>
          if (isLiteLLMProvider(id, options)) {
            liteLLMProviders.push({ id, provider })
          }
        }
      }

      // If no providers are matched (e.g., zero-config auto-detection),
      // fall back to default 'litellm' provider to ensure backwards compatibility.
      if (liteLLMProviders.length === 0) {
        const id = CHAT_PROVIDER_ID
        let provider = config.provider[id] as Record<string, unknown> | undefined
        if (!provider) {
          provider = {
            npm: '@ai-sdk/openai-compatible',
            name: 'LiteLLM (proxy)',
            options: {},
            models: {},
          }
        }
        liteLLMProviders.push({ id, provider })
      }

      // Process each matched provider
      for (const { id: providerId, provider } of liteLLMProviders) {
        const options = (provider.options ?? {}) as Record<string, unknown>
        const configuredBase =
          typeof options.baseURL === 'string' ? options.baseURL : undefined
        // `discoveryBaseURL` decouples discovery from adapter-specific
        // baseURL paths (e.g. @ai-sdk/google's `…/v1beta/models`).
        const discoveryBase =
          typeof options.discoveryBaseURL === 'string'
            ? options.discoveryBaseURL
            : configuredBase
        // Ignore an apiKey that still contains an unresolved `{env:…}`
        // placeholder — sending it verbatim would 401 against the proxy.
        // Fall back to the env vars instead.
        const configuredKey =
          typeof options.apiKey === 'string' &&
          options.apiKey &&
          !options.apiKey.includes('{env:')
            ? options.apiKey
            : undefined
        const envKey =
          process.env.LITELLM_API_KEY ?? process.env.LITELLM_MASTER_KEY
        const apiKey = configuredKey ?? envKey
        const customHeaders = readCustomHeaders(options)
        const includePatterns = readModelPatterns(options, 'modelFilter')
        const excludePatterns = readModelPatterns(options, 'excludeModels')
        const modelDefaults = readModelDefaults(options)
        const useModelsDev = options.modelsDev !== false
        // MCP discovery is opt-in: it injects top-level `config.mcp`
        // entries, which is a broader side effect than populating one
        // provider's model map.
        const useMcp = options.litellmMcp === true

        // Resolve base URL
        let baseURL: string | null = null
        if (discoveryBase) {
          baseURL = normalizeBaseURL(discoveryBase)
        } else {
          baseURL = await autoDetectLiteLLM(apiKey, customHeaders)
        }

        if (!baseURL) {
          console.warn(
            `[opencode-litellm] No LiteLLM proxy found for provider "${providerId}". Configure options.baseURL or start LiteLLM on port 4000/8000/8080.`,
          )
          continue
        }

        // Discover MCP servers off the same proxy. Independent of model
        // discovery: it targets a different endpoint and writes to
        // top-level `config.mcp`, so it runs even if models fail.
        if (useMcp && !injectedMcpBaseURLs.has(baseURL)) {
          injectedMcpBaseURLs.add(baseURL)
          if (!config.mcp) config.mcp = {}
          const prefix =
            typeof options.litellmMcpPrefix === 'string'
              ? options.litellmMcpPrefix
              : DEFAULT_MCP_PREFIX
          const summary = await injectMcpServers({
            mcp: config.mcp as Record<string, unknown>,
            baseURL,
            apiKey,
            customHeaders,
            include: readModelPatterns(options, 'mcpFilter'),
            exclude: readModelPatterns(options, 'excludeMcpServers'),
            prefix,
            enabled: options.litellmMcpEnabled !== false,
          })
          if (summary) {
            console.log(
              `[opencode-litellm] Discovered ${summary.total} MCP server(s) from ${baseURL} ` +
                `(${summary.added} added` +
                (summary.filteredOut > 0 ? `, ${summary.filteredOut} filtered out` : '') +
                (summary.skipped > 0 ? `, ${summary.skipped} unroutable` : '') +
                ')',
            )
          }
        }

        // Initialize/Update the provider entry in config
        if (!config.provider[providerId]) {
          config.provider[providerId] = provider
        }
        const actualProvider = config.provider[providerId] as Record<string, unknown>

        if (!actualProvider.npm) {
          actualProvider.npm = '@ai-sdk/openai-compatible'
        }

        if (!actualProvider.options) {
          actualProvider.options = { baseURL: `${baseURL}/v1` }
        } else {
          const actualOptions = actualProvider.options as Record<string, unknown>
          if (!actualOptions.baseURL) {
            actualOptions.baseURL = `${baseURL}/v1`
          }
        }

        if (!actualProvider.models) {
          actualProvider.models = {}
        }

        const models = actualProvider.models as Record<string, unknown>

        // Several providers can share one proxy baseURL with different
        // filters, so the repeat-invocation cache is keyed per provider.
        const cacheKey = `${providerId}::${baseURL}`

        // Discover models with timeout
        const work = async () => {
          const alreadyInjected = injectedModelIds.get(cacheKey)
          if (
            alreadyInjected &&
            [...alreadyInjected].every((id) => models[id])
          ) {
            return
          }

          // Kick off the (memoized) models.dev fetch so it overlaps the
          // health check and discovery round-trips.
          const modelsDevPromise = useModelsDev
            ? loadModelsDevIndex()
            : Promise.resolve(null)

          if (!(await checkLiteLLMHealth(baseURL!, apiKey, customHeaders))) {
            console.warn(
              `[opencode-litellm] LiteLLM appears offline or unauthorized for provider "${providerId}" at ${baseURL}`,
            )
            return
          }

          // `/v1/models` omits `mode` and capability metadata for
          // database-defined models, so fetch `/v1/model/info` alongside
          // it. The info call is best-effort: without it, classification
          // falls back to id heuristics.
          const [modelsResult, infoResult] = await Promise.allSettled([
            discoverLiteLLMModels(baseURL!, apiKey, customHeaders),
            discoverLiteLLMModelInfo(baseURL!, apiKey, customHeaders),
          ])

          if (modelsResult.status === 'rejected') {
            const error = modelsResult.reason
            console.warn(
              `[opencode-litellm] Model discovery failed for provider "${providerId}":`,
              error instanceof Error ? error.message : String(error),
            )
            return
          }

          const discovered = modelsResult.value
          let infoByName: Map<string, LiteLLMModelInfo> | null = null
          if (infoResult.status === 'fulfilled') {
            infoByName = infoResult.value
          } else {
            const reason = infoResult.reason
            console.warn(
              `[opencode-litellm] /v1/model/info unavailable for provider "${providerId}"; non-chat model filtering will use id heuristics only:`,
              reason instanceof Error ? reason.message : String(reason),
            )
          }

          if (discovered.length === 0) {
            console.warn(
              `[opencode-litellm] LiteLLM responded for provider "${providerId}" but exposed zero models.`,
            )
            return
          }

          const modelsDevIndex = await modelsDevPromise
          if (useModelsDev && !modelsDevIndex) {
            console.warn(
              `[opencode-litellm] models.dev catalog unavailable; injecting provider "${providerId}" without variants/cost enrichment`,
            )
          }
          const npm =
            typeof actualProvider.npm === 'string' ? actualProvider.npm : undefined

          let added = 0
          let skipped = 0
          let wildcards = 0
          let filteredOut = 0
          let enriched = 0
          let defaulted = 0
          const unmatched: string[] = []
          for (const model of discovered) {
            // Wildcard entries (`deepseek/*`) are access rules, not
            // callable models — invoking one sends a literal `*` upstream.
            if (model.id.includes('*')) {
              wildcards++
              continue
            }
            // Per-provider allow/deny globs
            if (
              (includePatterns.length > 0 &&
                !includePatterns.some((p) => p.test(model.id))) ||
              excludePatterns.some((p) => p.test(model.id))
            ) {
              filteredOut++
              continue
            }
            // Don't overwrite user-curated entries
            if (models[model.id]) continue
            const info = infoByName?.get(model.id)
            if (infoByName && !info) unmatched.push(model.id)
            const entry = toConfigModel(info ? enrichModel(model, info) : model)
            if (!entry) {
              skipped++
              continue
            }
            if (modelsDevIndex) {
              const catalogEntry = matchModelsDev(modelsDevIndex, model.id)
              if (catalogEntry) {
                applyModelsDevMetadata(entry, catalogEntry, npm, model.id)
                enriched++
              }
            }
            // Fallback metadata for ids the catalog doesn't cover
            // (self-hosted builds, quantized variants). Fills gaps only.
            if (modelDefaults.length > 0 && applyModelDefaults(entry, model.id, modelDefaults)) {
              defaulted++
            }
            models[model.id] = entry
            added++
          }

          if (unmatched.length > 0) {
            console.warn(
              `[opencode-litellm] /v1/model/info has no entry for ${unmatched.length} model(s) on provider "${providerId}"; ` +
                `classification uses id heuristics for: ${unmatched.slice(0, 5).join(', ')}` +
                (unmatched.length > 5 ? `, +${unmatched.length - 5} more` : ''),
            )
          }

          // Remove the seed placeholder if real models were discovered
          if (models['_'] && Object.keys(models).length > 1) {
            delete models['_']
          }

          injectedModelIds.set(cacheKey, new Set(Object.keys(models)))

          console.log(
            `[opencode-litellm] Discovered ${discovered.length} models for provider "${providerId}" from ${baseURL} ` +
              `(${added} added` +
              (enriched > 0 ? `, ${enriched} enriched via models.dev` : '') +
              (defaulted > 0 ? `, ${defaulted} via modelDefaults` : '') +
              (filteredOut > 0 ? `, ${filteredOut} filtered out` : '') +
              (skipped > 0 ? `, ${skipped} non-chat hidden` : '') +
              (wildcards > 0 ? `, ${wildcards} wildcard ignored` : '') +
              ')',
          )
        }

        await Promise.race([
          work(),
          new Promise<void>((resolve) =>
            setTimeout(resolve, DISCOVERY_TIMEOUT_MS),
          ),
        ])
      }
    },
  }
}

// Re-export the responses plugin for backwards compat, but it's now a no-op.
// The config hook approach handles all models in a single provider.
export const LiteLLMResponsesPlugin: Plugin = async (_input: PluginInput) => {
  return {}
}
