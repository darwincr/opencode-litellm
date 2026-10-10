import { Model, Plugin, Provider } from '@opencode/plugin'
import type { Context } from '@opencode/plugin/promise/plugin'
import type { PluginInput } from '@opencode-ai/plugin'
import { isLiteLLMProvider, LiteLLMPlugin } from './index'

type ProviderInfo = Awaited<ReturnType<Context['provider']['list']>>['data'][number]
type MCPConfig = Parameters<Parameters<Context['mcp']['transform']>[0]>[0] extends {
  set(name: string, config: infer Config): void
} ? Config : never

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any> : {}
}

function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/** Translate the fork's enriched v1 config models into native v2 models. */
export function toProviderModels(providerID: string, entries: Record<string, unknown>): Model.Info[] {
  return Object.entries(entries).map(([id, value]) => {
    const entry = record(value)
    const defaults = Model.Info.default(Provider.ID.make(providerID), Model.ID.make(id))
    const limit = record(entry.limit)
    const modalities = record(entry.modalities)
    const cost = record(entry.cost)
    return {
      ...defaults,
      name: typeof entry.name === 'string' ? entry.name : id,
      limit: {
        context: positive(limit.context, defaults.limit.context),
        output: positive(limit.output, defaults.limit.output),
      },
      capabilities: {
        tools: entry.tool_call === undefined ? defaults.capabilities.tools : entry.tool_call === true,
        input: modalities.input ?? defaults.capabilities.input,
        output: modalities.output ?? defaults.capabilities.output,
      },
      cost: Object.keys(cost).length ? [{
        input: cost.input ?? 0,
        output: cost.output ?? 0,
        cache: { read: cost.cache_read ?? 0, write: cost.cache_write ?? 0 },
      }] : [],
      settings: record(entry.options),
      variants: Object.entries(record(entry.variants)).map(([id, settings]) => ({
        id: id as Model.VariantID,
        settings: { ...record(record(settings).options), ...Object.fromEntries(
          Object.entries(record(settings)).filter(([key]) => key !== 'options'),
        ) },
      })),
    } as Model.Info
  })
}

const pluginKeys = [
  'litellm', 'litellmCompatible', 'litellm-compatible', 'litellm_compatible',
  'discoveryBaseURL', 'customHeaders', 'modelFilter', 'excludeModels',
  'modelDefaults', 'modelsDev', 'litellmMcp', 'litellmMcpPrefix',
  'litellmMcpEnabled', 'mcpFilter', 'excludeMcpServers', 'providerID',
]

interface Source {
  provider: ProviderInfo
  models: Model.Info[]
  settings: Record<string, unknown>
  mcp: Record<string, unknown>
  owned: Set<string>
}

const definition = Plugin.define({
  id: 'opencode-litellm',
  async setup(context) {
    const sources = new Map<string, Source>()
    const options = record(context.options)
    const controller = new AbortController()
    let stopped = false

    async function discover(provider: ProviderInfo): Promise<Source> {
      const settings = { ...options, ...record(provider.settings) }
      let connectionKey: string | undefined
      if (provider.integrationID && !settings.apiKey) {
        const connection = await context.integration.connection.active(provider.integrationID)
        const credential = connection ? await context.integration.connection.resolve(connection) : undefined
        if (credential?.type === 'key') connectionKey = credential.key
      }
      // Reuse all fork-specific discovery/enrichment/filter/MCP behavior.
      // A fresh hook isolates the injection cache from previous refreshes.
      const hooks = await LiteLLMPlugin({} as PluginInput)
      const config = {
        provider: {
          [provider.id]: {
            npm: provider.package === '@opencode/ai/providers/anthropic' ? '@ai-sdk/anthropic'
              : provider.package === '@opencode/ai/providers/google' ? '@ai-sdk/google'
              : '@ai-sdk/openai-compatible',
            options: {
              ...settings,
              ...(connectionKey ? { apiKey: connectionKey } : {}),
              customHeaders: { ...record(settings.customHeaders), ...record(provider.headers) },
            },
            models: {},
          },
        },
        mcp: {},
      }
      await hooks.config!(config as never)
      const runtimeSettings = { ...settings }
      for (const key of pluginKeys) delete runtimeSettings[key]
      return {
        provider,
        settings: runtimeSettings,
        models: toProviderModels(provider.id, config.provider[provider.id].models),
        mcp: config.mcp,
        owned: sources.get(provider.id)?.owned ?? new Set(),
      }
    }

    // Providers may be registered after plugin setup in OpenCode v2.
    // Serialize reconciliation so provider.updated bursts cannot race.
    async function reconcile(refresh = false): Promise<boolean> {
      const providers = (await context.provider.list()).data.filter((provider) =>
        isLiteLLMProvider(provider.id, record(provider.settings)),
      )
      const fallbackBaseURL = options.baseURL ?? process.env.LITELLM_BASE_URL
      if (!providers.length && typeof fallbackBaseURL === 'string') {
        providers.push({
          ...Provider.Info.empty(Provider.ID.make(options.providerID ?? 'litellm')),
          name: 'LiteLLM (proxy)', activation: 'enabled',
          package: '@opencode/ai/providers/openai-compatible',
          settings: { ...options, baseURL: fallbackBaseURL },
        })
      }
      let changed = false
      for (const provider of providers) {
        const previous = sources.get(provider.id)
        if (!refresh && previous && JSON.stringify(previous.provider) === JSON.stringify(provider)) continue
        const source = await discover(provider)
        if (stopped) break
        // Failed discovery must not remove a previously working inventory.
        if (!source.models.length && previous) continue
        sources.set(provider.id, source)
        changed = true
      }
      return changed
    }

    await reconcile()
    const registration = await context.provider.transform((editor) => {
      for (const [id, source] of sources) {
        const current = editor.get(id)
        if (current) {
          // Curated host models win. Plugin-owned entries can refresh/disappear.
          const models = new Map([...current.models].filter(([id]) => !source.owned.has(id)))
          source.owned = new Set()
          for (const model of source.models) {
            if (models.has(model.id)) continue
            models.set(model.id, model)
            source.owned.add(model.id)
          }
          editor.models.set(id, [...models.values()])
        } else {
          source.owned = new Set(source.models.map((model) => model.id))
          editor.add({
            info: {
              ...Provider.Info.empty(Provider.ID.make(id)),
              name: source.provider.name,
              activation: source.provider.activation,
              package: source.provider.package,
              settings: source.settings,
              headers: source.provider.headers,
              integrationID: source.provider.integrationID as Provider.Info['integrationID'],
            },
            models: source.models,
          })
        }
      }
    })
    const mcpRegistration = await context.mcp.transform((editor) => {
      for (const source of sources.values()) {
        for (const [name, value] of Object.entries(source.mcp)) {
          if (!editor.get(name)) {
            const { enabled, ...config } = record(value)
            editor.set(name, { ...config, disabled: enabled === false } as MCPConfig)
          }
        }
      }
    })
    let pendingPublication = false
    let queue = Promise.resolve()
    function schedule(refresh = false): Promise<void> {
      queue = queue.then(async () => {
        if (stopped) return
        if (await reconcile(refresh)) pendingPublication = true
        if (!pendingPublication || stopped) return
        await context.provider.reload()
        await context.mcp.reload()
        pendingPublication = false
      }).catch((error) => {
        console.warn('[opencode-litellm] Provider reconciliation failed:', error instanceof Error ? error.message : String(error))
      })
      return queue
    }
    void (async () => {
      try {
        for await (const event of context.event.subscribe({ signal: controller.signal })) {
          if (event.type === 'provider.updated') void schedule()
          if (event.type === 'session.created' || event.type === 'credential.switched') void schedule(true)
        }
      } catch (error) {
        if (!stopped) console.warn('[opencode-litellm] Event subscription failed:', error instanceof Error ? error.message : String(error))
      }
    })()
    void schedule()
    return async () => {
      stopped = true
      controller.abort()
      await queue
      await mcpRegistration.dispose()
      await registration.dispose()
    }
  },
})

export default {
  ...definition,
  // OpenCode v1 object-form plugin bridge; named legacy exports remain available.
  server: (input: PluginInput) => LiteLLMPlugin(input),
}
