import { afterEach, describe, expect, it, vi } from 'vitest'
import plugin, { LiteLLMPlugin } from '../src'
import type { Context } from '@opencode/plugin/promise/plugin'
import { toProviderModels } from '../src/plugin/v2'

afterEach(() => vi.unstubAllGlobals())

function mockDiscovery() {
  vi.stubGlobal('fetch', vi.fn(async (input) => {
    const url = String(input)
    if (url.endsWith('/v1/model/info')) return Response.json({ data: [{
      model_name: 'team/chat', model_info: {
        mode: 'chat', max_input_tokens: 100000, max_output_tokens: 4000,
        supports_function_calling: true, supports_vision: true,
        input_cost_per_token: 0.000003,
      },
    }] })
    if (url.endsWith('/v1/mcp/server')) return Response.json([{ alias: 'test-tools' }])
    return Response.json({ data: [
      { id: 'team/chat' }, { id: 'team/embedding', mode: 'embedding' },
      { id: 'other/chat' }, { id: 'team/*' },
    ] })
  }))
}

describe('dual-version compatibility', () => {
  it('flattens Anthropic and Google provider options into native v2 model settings', () => {
    const models = toProviderModels('dr-anthropic', {
      claude: {
        options: { thinking: { type: 'adaptive' } },
        variants: { high: { options: { thinking: { type: 'adaptive' }, effort: 'high' } } },
      },
      gemini: {
        variants: { high: { options: { thinkingConfig: { thinkingLevel: 'high' } } } },
      },
    })
    expect(models[0].settings).toEqual({ thinking: { type: 'adaptive' } })
    expect(models[0].variants[0].settings).toEqual({ thinking: { type: 'adaptive' }, effort: 'high' })
    expect(models[1].variants[0].settings).toEqual({ thinkingConfig: { thinkingLevel: 'high' } })
  })
  it('keeps the v1 bridge and named legacy hooks', async () => {
    expect(plugin.id).toBe('opencode-litellm')
    expect(plugin.setup).toBeTypeOf('function')
    expect((await plugin.server({} as never)).config).toBeTypeOf('function')
    expect((await LiteLLMPlugin({} as never)).config).toBeTypeOf('function')
  })

  it('discovers and enriches the same filtered models on v1 and v2, preserving curated models', async () => {
    mockDiscovery()
    const settings = {
      baseURL: 'http://gateway.example/v1', apiKey: 'test-key', modelsDev: false,
      modelFilter: ['team/*'],
      litellmMcp: true, litellmMcpEnabled: false,
      modelDefaults: [{ match: ['team/*'], model: {
        variants: { high: { reasoningEffort: 'high' } },
      } }],
    }
    const legacy = await plugin.server({} as never)
    const config = { provider: { litellm: { options: settings, models: {} } } }
    await legacy.config!(config as never)
    expect(Object.keys(config.provider.litellm.models)).toEqual(['team/chat'])

    const provider = {
      id: 'litellm', name: 'Test LiteLLM', activation: 'enabled',
      package: '@opencode/ai/providers/openai-compatible', settings,
    }
    let models = new Map<string, any>([['curated', { id: 'curated', name: 'Curated' }]])
    const dispose = vi.fn(async () => {})
    const mcpSet = vi.fn()
    const context = {
      options: {},
      provider: {
        list: async () => ({ data: [provider] }),
        transform: async (transform: any) => {
          transform({
            get: () => ({ provider, models }),
            models: { set: (_id: string, entries: any[]) => {
              models = new Map(entries.map((model) => [model.id, model]))
            } },
          })
          return { dispose }
        },
        reload: vi.fn(async () => {}),
      },
      mcp: {
        transform: async (fn: any) => {
          fn({ get: () => undefined, set: mcpSet })
          return { dispose }
        },
        reload: vi.fn(async () => {}),
      },
      event: { subscribe: () => (async function* () {})() },
      session: { hook: async () => ({ dispose }) },
    } as unknown as Context
    const cleanup = await plugin.setup(context)
    expect([...models.keys()]).toEqual(['curated', 'team/chat'])
    expect(mcpSet).toHaveBeenCalledWith('litellm_test-tools', {
      type: 'remote', url: 'http://gateway.example/mcp/test-tools',
      disabled: true, headers: { 'x-litellm-api-key': 'Bearer test-key' },
    })
    expect(models.get('team/chat')).toMatchObject({
      name: 'team/chat', limit: { context: 100000, output: 4000 },
      capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
      cost: [{ input: 3, output: 0, cache: { read: 0, write: 0 } }],
      variants: [{ id: 'high', settings: { reasoningEffort: 'high' } }],
    })
    await cleanup?.()
    expect(dispose).toHaveBeenCalledTimes(3)
  })

  it('reconciles a provider registered after setup and retries a failed reload', async () => {
    mockDiscovery()
    let providers: any[] = []
    const registered: any[] = []
    let transform: any
    const editor = { get: () => undefined, add: (entry: any) => registered.push(entry) }
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const reload = vi.fn(async () => {
      if (reload.mock.calls.length === 1) throw new Error('temporary failure')
      transform(editor)
    })
    const context = {
      options: {},
      provider: {
        list: async () => ({ data: providers }),
        transform: async (fn: any) => { transform = fn; fn(editor); return { dispose: async () => {} } },
        reload,
      },
      mcp: { transform: async () => ({ dispose: async () => {} }), reload: async () => {} },
      event: { subscribe: () => (async function* () {
        await gate
        yield { type: 'provider.updated' }
        yield { type: 'provider.updated' }
      })() },
      session: { hook: async () => ({ dispose: async () => {} }) },
    } as unknown as Context
    const cleanup = await plugin.setup(context)
    providers = [{
      id: 'litellm', name: 'Late', activation: 'enabled',
      package: '@opencode/ai/providers/openai-compatible',
      settings: { baseURL: 'http://gateway.example/v1', modelsDev: false },
    }]
    release()
    await vi.waitFor(() => expect(registered).toHaveLength(1))
    expect(reload).toHaveBeenCalledTimes(2)
    expect(registered[0].models.map((model: any) => model.id)).toContain('team/chat')
    await cleanup?.()
  })
})
