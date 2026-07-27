/**
 * models.dev enrichment.
 *
 * LiteLLM's `/v1/models` is lean (and `/v1/model/info` is often blocked
 * for restricted virtual keys), so discovered entries lack pricing,
 * reasoning metadata, and modality info. The community catalog at
 * https://models.dev/api.json carries all of it — including
 * `reasoning_options`, the same metadata OpenCode uses internally to
 * build variant pickers for providers it knows.
 *
 * This module fetches the catalog once per process, indexes every model
 * by id, matches discovered LiteLLM ids against it (stripping route
 * prefixes like `CLIProxyAnthropic/` and alias suffixes like `-low`),
 * and converts `reasoning_options` into config-level `variants` shaped
 * for the provider's AI SDK adapter — mirroring OpenCode's own
 * effort/budget/toggle → payload mapping.
 */

const MODELS_DEV_URL = 'https://models.dev/api.json'
const FETCH_TIMEOUT_MS = 10000
/** OpenCode's default ceiling for thinking-budget variants. */
const MAX_THINKING_BUDGET = 32000

export interface ModelsDevReasoningOption {
  type?: string
  values?: Array<string | null>
  min?: number
  max?: number
}

export interface ModelsDevModel {
  id?: string
  name?: string
  reasoning?: boolean
  reasoning_options?: ModelsDevReasoningOption[]
  tool_call?: boolean
  attachment?: boolean
  modalities?: { input?: string[]; output?: string[] }
  limit?: { context?: number; output?: number }
  cost?: {
    input?: number
    output?: number
    cache_read?: number
    cache_write?: number
  }
}

interface ModelsDevProvider {
  models?: Record<string, ModelsDevModel>
}

/**
 * Several catalog providers can list the same model id; prefer the
 * entry that actually carries the metadata we enrich with.
 */
function metadataScore(m: ModelsDevModel): number {
  return (m.reasoning_options?.length ? 2 : 0) + (m.cost ? 1 : 0)
}

let catalogPromise: Promise<Map<string, ModelsDevModel> | null> | null = null

async function fetchCatalog(): Promise<Map<string, ModelsDevModel> | null> {
  try {
    const response = await fetch(MODELS_DEV_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) return null
    const data = (await response.json()) as Record<string, ModelsDevProvider>
    const index = new Map<string, ModelsDevModel>()
    for (const provider of Object.values(data)) {
      for (const model of Object.values(provider?.models ?? {})) {
        if (!model || typeof model !== 'object' || !model.id) continue
        const key = model.id.toLowerCase()
        const existing = index.get(key)
        if (!existing || metadataScore(model) > metadataScore(existing)) {
          index.set(key, model)
        }
      }
    }
    return index
  } catch {
    return null
  }
}

/** Fetch + index the catalog, memoized per process. Never throws. */
export function loadModelsDevIndex(): Promise<Map<string, ModelsDevModel> | null> {
  if (!catalogPromise) catalogPromise = fetchCatalog()
  return catalogPromise
}

/**
 * Route-alias suffixes proxies commonly append to upstream model names
 * (`gemini-3.5-flash-low`, `gpt-oss-120b-medium`). Stripped iteratively
 * as a fallback when the raw id has no catalog entry.
 */
const ALIAS_SUFFIX = /-(extra-low|minimal|none|low|medium|high|xhigh|max)$/

/**
 * Match a LiteLLM model id against the catalog index. Tries, in order:
 * the raw id, the id after the first `/` route segment, after the last
 * `/`, then each of those with `:tag` and alias suffixes stripped.
 */
export function matchModelsDev(
  index: Map<string, ModelsDevModel>,
  id: string,
): ModelsDevModel | undefined {
  const lower = id.toLowerCase()
  const candidates: string[] = [lower]
  if (lower.includes('/')) {
    candidates.push(lower.slice(lower.indexOf('/') + 1))
    candidates.push(lower.slice(lower.lastIndexOf('/') + 1))
  }
  for (const base of candidates.slice()) {
    let current = base.replace(/:[a-z0-9_-]+$/, '')
    candidates.push(current)
    while (ALIAS_SUFFIX.test(current)) {
      current = current.replace(ALIAS_SUFFIX, '')
      candidates.push(current)
    }
  }
  for (const candidate of candidates) {
    const hit = index.get(candidate)
    if (hit) return hit
  }
  return undefined
}

/** Claude Opus ≥ 4.7 (adaptive thinking, summarized display). */
function isOpus47Plus(id: string): boolean {
  // Single version number (`claude-opus-5`) — major-only ids ≥ 5.
  const single = /opus-(\d+)(?:[.@-]|$)/i.exec(id)
  const m = /opus-(\d+)[.-](\d+)(?:[.@-]|$)|claude-(\d+)[.-](\d+)-opus(?:[.@-]|$)/i.exec(id)
  if (m) {
    const major = Number(m[1] ?? m[3])
    const minor = Number(m[2] ?? m[4])
    return major > 4 || (major === 4 && minor >= 7)
  }
  if (single) return Number(single[1]) >= 5
  return false
}

/** Claude Sonnet ≥ 5 (adaptive thinking, summarized display). */
function isSonnet5Plus(id: string): boolean {
  const m = /sonnet-(\d+)(?:[.@-]|$)|claude-(\d+)-sonnet(?:[.@-]|$)/i.exec(id)
  if (!m) return false
  return Number(m[1] ?? m[2]) >= 5
}

/** Models whose adaptive thinking traces render as summaries. */
function claudeSummarized(id: string): boolean {
  return isOpus47Plus(id) || isSonnet5Plus(id) || id.includes('fable-5')
}

/** Models that accept `thinking: {type: "adaptive"}` + `effort`. */
function claudeAdaptiveCapable(id: string): boolean {
  if (claudeSummarized(id)) return true
  return ['opus-4-6', 'opus-4.6', 'sonnet-4-6', 'sonnet-4.6'].some((v) =>
    id.includes(v),
  )
}

/**
 * Build the variant payload for one effort level, shaped for the
 * provider's npm adapter. Returns `null` when the adapter/model can't
 * express effort (the caller then falls back to budget/toggle).
 *
 * The shapes mirror both OpenCode's internal generator and the
 * config-level layout OpenCode accepts (`options` nesting for adapters
 * that pass reasoning config through provider options).
 */
function effortVariant(
  npm: string | undefined,
  modelId: string,
  level: string,
): Record<string, unknown> | null {
  switch (npm) {
    case '@ai-sdk/anthropic': {
      const id = modelId.toLowerCase()
      // Opus 4.5 takes a bare `effort` without a thinking block.
      if (id.includes('opus-4-5') || id.includes('opus-4.5')) {
        return { options: { effort: level } }
      }
      if (!claudeAdaptiveCapable(id)) return null
      return {
        options: {
          thinking: {
            type: 'adaptive',
            ...(claudeSummarized(id) ? { display: 'summarized' } : {}),
          },
          effort: level,
        },
      }
    }
    case '@ai-sdk/google':
      return {
        options: {
          thinkingConfig: { includeThoughts: true, thinkingLevel: level },
        },
      }
    default:
      // openai-compatible and friends: LiteLLM maps `reasoning_effort`
      // onto whatever the upstream understands.
      return { reasoningEffort: level }
  }
}

/** Build `high`/`max` thinking-budget variants (Anthropic/Google only). */
function budgetVariants(
  npm: string | undefined,
  option: ModelsDevReasoningOption,
  outputLimit: number | undefined,
): Record<string, unknown> {
  const payload = (budget: number): Record<string, unknown> | null => {
    switch (npm) {
      case '@ai-sdk/anthropic':
        return { options: { thinking: { type: 'enabled', budgetTokens: budget } } }
      case '@ai-sdk/google':
        return {
          options: {
            thinkingConfig: { includeThoughts: true, thinkingBudget: budget },
          },
        }
      default:
        return null
    }
  }
  const cap = Math.min(
    option.max ?? MAX_THINKING_BUDGET - 1,
    outputLimit ? outputLimit - 1 : MAX_THINKING_BUDGET - 1,
    MAX_THINKING_BUDGET - 1,
  )
  if (cap <= 0) return {}
  const high = Math.min(
    Math.max(option.min ?? 0, Math.floor((cap + 1) / 2)),
    cap,
  )
  const out: Record<string, unknown> = {}
  const highPayload = payload(high)
  const maxPayload = payload(cap)
  if (highPayload) out.high = highPayload
  if (maxPayload) out.max = maxPayload
  return out
}

/**
 * Overlay models.dev metadata onto a config-level model entry built
 * from LiteLLM discovery. Only fills gaps for scalar metadata; always
 * generates `variants` (discovered entries never have any — hand-curated
 * entries are skipped upstream and never reach this function).
 */
export function applyModelsDevMetadata(
  entry: Record<string, unknown>,
  catalog: ModelsDevModel,
  npm: string | undefined,
  modelId: string,
): void {
  if (!entry.cost && catalog.cost) {
    const cost: Record<string, number> = {
      input: catalog.cost.input ?? 0,
      output: catalog.cost.output ?? 0,
    }
    if (catalog.cost.cache_read != null) cost.cache_read = catalog.cost.cache_read
    if (catalog.cost.cache_write != null) cost.cache_write = catalog.cost.cache_write
    entry.cost = cost
  }
  if (!entry.limit && catalog.limit?.context) {
    entry.limit = {
      context: catalog.limit.context,
      output: catalog.limit.output ?? 0,
    }
  }
  if (catalog.tool_call) entry.tool_call = true
  if (catalog.reasoning) entry.reasoning = true
  if (entry.attachment == null && catalog.modalities?.input?.includes('image')) {
    entry.attachment = true
  }
  if (!entry.modalities && catalog.modalities?.input && catalog.modalities.input.length > 1) {
    entry.modalities = {
      input: catalog.modalities.input,
      output: catalog.modalities.output ?? ['text'],
    }
  }

  const reasoningOptions = catalog.reasoning_options ?? []
  if (entry.variants || reasoningOptions.length === 0) return

  const effort = reasoningOptions.find(
    (o) => o.type === 'effort' && Array.isArray(o.values) && o.values.length > 0,
  )
  const budget = reasoningOptions.find((o) => o.type === 'budget_tokens')
  const toggle = reasoningOptions.some((o) => o.type === 'toggle')

  const variants: Record<string, unknown> = {}
  if (effort) {
    for (const value of effort.values!) {
      const level = value === null ? 'none' : String(value)
      const payload = effortVariant(npm, modelId, level)
      if (payload) variants[level] = payload
    }
  }
  if (Object.keys(variants).length === 0 && budget) {
    Object.assign(
      variants,
      budgetVariants(npm, budget, (catalog.limit?.output ?? undefined)),
    )
  }
  if (Object.keys(variants).length === 0 && toggle) {
    // Mirror the common LiteLLM convention: reasoning is on by default,
    // a `none` variant turns it off. Only meaningful for adapters that
    // send `reasoning_effort`.
    if (npm !== '@ai-sdk/anthropic' && npm !== '@ai-sdk/google') {
      variants.none = { reasoningEffort: 'none' }
    }
  }

  if (Object.keys(variants).length > 0) {
    entry.variants = variants
    // Adapters that thread reasoning through provider options also want
    // a sane default for the variant-less selection.
    if (effort && npm === '@ai-sdk/google') {
      entry.options ??= { thinkingConfig: { includeThoughts: true } }
    }
    if (effort && npm === '@ai-sdk/anthropic' && claudeAdaptiveCapable(modelId.toLowerCase())) {
      entry.options ??= {
        thinking: {
          type: 'adaptive',
          ...(claudeSummarized(modelId.toLowerCase()) ? { display: 'summarized' } : {}),
        },
      }
    }
  }
}
