import { afterEach, describe, expect, it, vi } from 'vitest'
import plugin from '../src'
import type { Context } from '@opencode/plugin/promise/plugin'
import { toProviderModels } from '../src/plugin/v2'
import { applyModelsDevMetadata } from '../src/utils/models-dev'

afterEach(() => vi.unstubAllGlobals())

function discovery(models: Array<Record<string, unknown>>) {
  vi.stubGlobal('fetch', vi.fn(async (input) => {
    if (String(input).endsWith('/v1/model/info')) {
      return Response.json({ data: models.map(({ id, ...model_info }) => ({ model_name: id, model_info })) })
    }
    return Response.json({ data: models.map(({ id }) => ({ id })) })
  }))
}

function host(settings: Record<string, unknown>) {
  const provider = {
    id: 'litellm', name: 'LiteLLM', activation: 'enabled',
    package: '@opencode/ai/providers/openai-compatible', settings,
  }
  let providers = [provider]
  let promptHook: (() => Promise<void>) | undefined
  // OpenCode replays transforms onto fresh source definitions on every rebuild.
  const curated = new Map<string, any>()
  let published = new Map<string, any>()
  let transform: any
  const replay = () => transform({
    get: () => ({ provider, models: new Map(curated) }),
    models: { set: (_id: string, models: any[]) => { published = new Map(models.map(model => [model.id, model])) } },
  })
  const events: any[] = []
  let wake: (() => void) | undefined
  const context = {
    options: {},
    location: { directory: '/workspace' },
    provider: {
      list: async () => ({ data: providers }),
      transform: async (fn: any) => { transform = fn; replay(); return { dispose: async () => {} } },
      reload: vi.fn(async () => replay()),
    },
    mcp: { transform: async () => ({ dispose: async () => {} }), reload: vi.fn(async () => {}) },
    session: { hook: async (_name: string, hook: () => Promise<void>) => {
      promptHook = hook
      return { dispose: async () => {} }
    } },
    event: { subscribe: ({ signal }: { signal: AbortSignal }) => (async function* () {
      signal.addEventListener('abort', () => wake?.(), { once: true })
      while (!signal.aborted) {
        if (!events.length) await new Promise<void>(resolve => { wake = resolve })
        if (events.length) yield events.shift()
      }
    })() },
  } as unknown as Context
  return {
    context, curated, replay,
    models: () => published,
    providers: (value: typeof providers) => { providers = value },
    provider,
    prompt: async () => promptHook?.(),
    emit: (type: string, location?: { directory: string }) => { events.push({ type, location }); wake?.() },
  }
}

const settings = { baseURL: 'http://proxy.example/v1', apiKey: 'test-key', modelsDev: false }

describe('model discovery reliability', () => {
  it('waits for late provider discovery before admitting the first prompt', async () => {
    discovery([{ id: 'ready', mode: 'chat' }])
    const app = host(settings)
    app.providers([])
    const cleanup = await plugin.setup(app.context)
    app.providers([app.provider])
    await app.prompt()
    expect([...app.models().keys()]).toEqual(['ready'])
    await cleanup?.()
  })

  it('uses catalog metadata to fill gaps without overriding explicit proxy capabilities', () => {
    const model: Record<string, unknown> = {
      tool_call: false, reasoning: false, attachment: false,
      modalities: { input: ['text'], output: ['text'] },
    }
    applyModelsDevMetadata(model, {
      tool_call: true, reasoning: true, attachment: true,
      modalities: { input: ['text', 'image'], output: ['text'] },
      reasoning_options: [{ type: 'effort', values: ['high'] }],
    }, '@ai-sdk/openai-compatible', 'chat')
    expect(model).toEqual({
      tool_call: false, reasoning: false, attachment: false,
      modalities: { input: ['text'], output: ['text'] },
    })
    const missing: Record<string, unknown> = {}
    applyModelsDevMetadata(missing, {
      tool_call: false, reasoning: false, attachment: false,
      modalities: { input: ['text'], output: ['text'] },
    }, '@ai-sdk/openai-compatible', 'text-only')
    expect(toProviderModels('litellm', { 'text-only': missing })[0].capabilities)
      .toEqual({ tools: false, input: ['text'], output: ['text'] })
  })

  it('preserves explicit false capabilities from LiteLLM metadata on both versions', async () => {
    discovery([{
      id: 'text-only', mode: 'chat', supports_function_calling: false,
      supports_vision: false, supports_reasoning: false,
    }])
    const legacy = await plugin.server({} as never)
    const config = { provider: { litellm: { options: settings, models: {} } } }
    await legacy.config!(config as never)
    expect(config.provider.litellm.models).toMatchObject({ 'text-only': {
      tool_call: false, attachment: false, reasoning: false,
      modalities: { input: ['text'], output: ['text'] },
    } })
    expect(toProviderModels('litellm', config.provider.litellm.models)[0].capabilities)
      .toEqual({ tools: false, input: ['text'], output: ['text'] })
  })

  it('keeps video and rerank endpoints out of the chat model picker', async () => {
    discovery([
      { id: 'chat', mode: 'chat' }, { id: 'response-model', mode: 'responses' },
      { id: 'minimax/MiniMax-H3', mode: 'video' },
      { id: 'ranker', mode: 'rerank' },
    ])
    const legacy = await plugin.server({} as never)
    const config = { provider: { litellm: { options: settings, models: {} } } }
    await legacy.config!(config as never)
    expect(Object.keys(config.provider.litellm.models)).toEqual(['chat', 'response-model'])
  })

  it('preserves newly curated overrides of previously discovered models on replay', async () => {
    discovery([{ id: 'chat', mode: 'chat' }])
    const app = host(settings)
    const cleanup = await plugin.setup(app.context)
    expect(app.models().get('chat').name).toBe('chat')
    app.curated.set('chat', { id: 'chat', name: 'My curated name', limit: { context: 8192, output: 1024 } })
    app.replay()
    expect(app.models().get('chat')).toEqual(app.curated.get('chat'))
    await cleanup?.()
  })

  it('refreshes the inventory on a new session and drops removed proxy models', async () => {
    discovery([{ id: 'old', mode: 'chat' }])
    const app = host(settings)
    app.curated.set('manual', { id: 'manual', name: 'Manual' })
    const cleanup = await plugin.setup(app.context)
    discovery([{ id: 'new', mode: 'chat' }])
    app.emit('session.created')
    await vi.waitFor(() => expect([...app.models().keys()]).toEqual(['manual', 'new']))
    await cleanup?.()
  })

  it('ignores session and provider events from other workspace locations', async () => {
    discovery([{ id: 'working', mode: 'chat' }])
    const app = host(settings)
    const cleanup = await plugin.setup(app.context)
    const fetcher = vi.mocked(fetch)
    fetcher.mockClear()
    app.emit('session.created', { directory: '/another-workspace' })
    app.emit('provider.updated', { directory: '/another-workspace' })
    // Flush the event iterator and any queued reconciliation without timers.
    for (let turn = 0; turn < 20; turn++) await Promise.resolve()
    expect(fetcher).not.toHaveBeenCalled()
    discovery([{ id: 'refreshed', mode: 'chat' }])
    app.emit('session.created', { directory: '/workspace' })
    await vi.waitFor(() => expect([...app.models().keys()]).toEqual(['refreshed']))
    await cleanup?.()
  })

  it('retains the last working inventory when the proxy is temporarily unavailable', async () => {
    discovery([{ id: 'working', mode: 'chat' }])
    const app = host(settings)
    const cleanup = await plugin.setup(app.context)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('proxy offline') }))
    app.emit('session.created')
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
    expect([...app.models().keys()]).toEqual(['working'])
    discovery([{ id: 'recovered', mode: 'chat' }])
    app.emit('session.created')
    await vi.waitFor(() => expect([...app.models().keys()]).toEqual(['recovered']))
    await cleanup?.()
  })
})
