<div align="center">

<img src="https://raw.githubusercontent.com/yuseferi/opencode-litellm/main/assets/logo.svg" alt="opencode-litellm logo" width="128" height="128" />

# opencode-litellm

**Drop-in [LiteLLM](https://github.com/BerriAI/litellm) provider for [OpenCode](https://opencode.ai) with zero configuration.**

[![Works with OpenCode](https://img.shields.io/badge/works%20with-OpenCode-7C5CFF?style=flat-square)](https://opencode.ai)
[![Powered by LiteLLM](https://img.shields.io/badge/powered%20by-LiteLLM-22D3EE?style=flat-square)](https://github.com/BerriAI/litellm)

[![npm version](https://img.shields.io/npm/v/opencode-plugin-litellm.svg?style=flat-square&color=cb3837&logo=npm)](https://www.npmjs.com/package/opencode-plugin-litellm)
[![npm downloads](https://img.shields.io/npm/dm/opencode-plugin-litellm.svg?style=flat-square&color=cb3837)](https://www.npmjs.com/package/opencode-plugin-litellm)
[![CI](https://img.shields.io/github/actions/workflow/status/yuseferi/opencode-litellm/ci.yml?style=flat-square&label=CI&logo=github)](https://github.com/yuseferi/opencode-litellm/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white)](./tsconfig.json)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square)](./CONTRIBUTING.md)

Auto-detect a running LiteLLM proxy, pull every model from `/v1/models`, and register them in OpenCode.
**No model lists to hand-maintain. No restart loops. No surprises.**

[Quickstart](#-quickstart) · [Configuration](#%EF%B8%8F-configuration) · [How it works](#-how-it-works) · [FAQ](#-faq) · [Contributing](./CONTRIBUTING.md)

</div>

> **npm package:** `opencode-plugin-litellm` &nbsp;·&nbsp; **GitHub repo:** `yuseferi/opencode-litellm`
> The unscoped `opencode-litellm` npm name was already taken by another author.

---

## ✨ Why this plugin?

Maintaining a `models` block in `opencode.json` for every model your LiteLLM proxy exposes is a chore — every new entry in your `model_list` means a config edit, a restart, and a context-switch.

`opencode-litellm` removes that loop entirely. It hooks into OpenCode's `config` lifecycle, queries your LiteLLM proxy at startup, and merges the discovered models into your config in memory. The result: every model in `litellm config.yaml` shows up in OpenCode's picker the moment you start it — automatically.

## 🚀 Quickstart

```bash
# 1. Install
npm install opencode-plugin-litellm
# or: bun add opencode-plugin-litellm
```

```jsonc
// 2. Add to opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-plugin-litellm@latest"],
  "provider": {
    "litellm": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://localhost:4000/v1"
      }
    }
  }
}
```

```bash
# 3. Start LiteLLM (if it isn't already)
litellm --config config.yaml --port 4000

# 4. Run OpenCode — every model in your LiteLLM model_list is now available.
opencode
```

## 🎯 Features

| | |
|---|---|
| 🔍 **Auto-detection** | Probes `localhost:4000`, `:8000`, `:8080` and adopts the first responsive proxy. |
| 📡 **Dynamic discovery** | Queries `/v1/models` so your OpenCode model picker always reflects your live `model_list`. |
| 🏷️ **Exact model IDs** | Preserves LiteLLM IDs verbatim in the picker, including routing prefixes such as `omlx/Qwen3.6-27B` and `CLIProxy/gpt-5.6-sol`. |
| 🧠 **Modality-aware** | Enriches `/v1/models` entries with `/v1/model/info` (`mode`, token limits, capability flags) and hides embedding / image / audio models from the picker. |
| 🧪 **Reasoning-aware routing** | Auto-routes `gpt-5*` / `o1`/`o3`/`o4*` models through a sibling `litellm-responses` provider that uses `/v1/responses`, so tools + `reasoning_effort` actually work. Override per model via `responsesApiModels` / `chatApiModels`. |
| 🏢 **Provider extraction** | Pulls `litellm_provider` (or the `provider/model` prefix) into `organizationOwner` so models group correctly in the UI. |
| 🔐 **Auth-aware** | Honours `LITELLM_API_KEY` / `LITELLM_MASTER_KEY` env vars or `provider.litellm.options.apiKey`. |
| 🌐 **Gateway-friendly** | Supports `customHeaders` for proxies behind Cloudflare Access or other API gateways requiring extra HTTP headers. |
| ⏱️ **Non-blocking startup** | Health checks fail fast (3 s); discovery fetches are capped at **15 s** for slow remote proxies. Repeat config-hook invocations are a no-op. |
| 🤝 **Non-destructive merge** | Only adds models you don't already have configured. Hand-curated entries are preserved verbatim. |
| 🪶 **Zero runtime deps** | Only depends on `@opencode-ai/plugin`. No build step, no bundler. |
| 🔒 **TypeScript strict** | Strict-mode compiled, fully typed public API. |

## ⚙️ Configuration

### Minimal config (recommended)

Point at your LiteLLM proxy — the plugin discovers all models automatically:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-plugin-litellm@latest"],
  "provider": {
    "litellm": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://localhost:4000/v1"
      }
    }
  }
}
```

### Explicit provider (custom URL or auth)

You **do not need to list any models** — the plugin still discovers them from `/v1/models` automatically. Use this form only when you need to point at a non-default URL or pass an API key:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-plugin-litellm@latest"],
  "provider": {
    "litellm": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "LiteLLM (proxy)",
      "options": {
        "baseURL": "http://litellm.internal.example.com/v1",
        "apiKey": "{env:LITELLM_API_KEY}"
      }
    }
  }
}
```

That's the whole config — every model in your LiteLLM `model_list` will appear in the picker.

### Example: governed upstream route with Tuning Engines

If your team routes model traffic through Tuning Engines for policy, traces,
approvals, and usage visibility, add it as an OpenAI-compatible upstream in
your LiteLLM config. The plugin will discover the alias from LiteLLM just like
any other `model_list` entry:

```yaml
model_list:
  - model_name: te-gpt-5.4-mini
    litellm_params:
      model: openai/gpt-5.4-mini
      api_key: os.environ/TUNING_ENGINES_API_KEY
      api_base: https://api.tuningengines.com/v1
```

Then expose the key to LiteLLM and keep your OpenCode config pointed at the
same LiteLLM proxy:

```bash
export TUNING_ENGINES_API_KEY=sk-te-...
litellm --config config.yaml --port 4000
opencode
```

OpenCode and this plugin still own model discovery and picker wiring. Tuning
Engines sits on the upstream model route as the governed control plane.

### Overriding or curating individual models (optional)

If you want to rename a model in the picker, pin its `organizationOwner`, or otherwise hand-curate metadata, add it under `models`. The plugin **preserves your entries verbatim** and only injects discovered models whose key isn't already defined:

```jsonc
{
  "provider": {
    "litellm": {
      "options": {
        "baseURL": "http://litellm.internal.example.com/v1",
        "apiKey": "{env:LITELLM_API_KEY}"
      },
      "models": {
        "openai/gpt-4o": {
          "name": "GPT-4o (curated)",
          "organizationOwner": "openai"
        }
      }
    }
  }
}
```

Here, `openai/gpt-4o` keeps your custom name; every other model from the proxy is still discovered and added automatically.

### Multiple providers sharing one proxy (mixed adapters, per-provider filtering)

One LiteLLM proxy can back **several OpenCode providers**, each using a
different AI SDK adapter and receiving a different slice of the model
catalog. Opt a provider in with `"litellm": true` (any provider id works;
ids starting with `litellm` are matched automatically), and slice the
catalog with `modelFilter` / `excludeModels` globs:

```jsonc
{
  "provider": {
    "my-openai": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://litellm.example.com/",
        "apiKey": "{env:LITELLM_API_KEY}",
        "litellm": true,
        "modelFilter": ["zai/*", "azure/*"],       // only these families
        "excludeModels": ["azure/*-preview"]       // …minus these
      }
    },
    "my-anthropic": {
      "npm": "@ai-sdk/anthropic",                  // adapter is preserved
      "options": {
        "baseURL": "https://litellm.example.com/v1",
        "apiKey": "{env:LITELLM_API_KEY}",
        "litellm": true,
        "modelFilter": ["anthropic/*"]
      }
    },
    "my-google": {
      "npm": "@ai-sdk/google",
      "options": {
        // Adapter path — not a valid discovery root, so point
        // discovery at the proxy root explicitly:
        "baseURL": "https://litellm.example.com/v1beta/models",
        "discoveryBaseURL": "https://litellm.example.com",
        "apiKey": "{env:LITELLM_API_KEY}",
        "litellm": true,
        "modelFilter": ["gemini/*"]
      }
    }
  }
}
```

Notes:

- The plugin never changes a provider's `npm` adapter — it only fills it
  in (as `@ai-sdk/openai-compatible`) when missing. Anthropic / Google /
  any other adapter configs are injected into as-is.
- `modelFilter` is an allowlist (default: everything); `excludeModels`
  is applied after it. `*` matches any characters, everything else is
  literal.
- Common adapter path suffixes (`/v1`, `/v1beta`, `/v1beta/models`) are
  stripped automatically when deriving the discovery URL, so
  `discoveryBaseURL` is only needed for unusual layouts.
- When `/v1/model/info` is reachable, per-model pricing
  (`input_cost_per_token` etc.) is converted to OpenCode's per-million
  `cost` block automatically. Keys restricted to `llm_api_routes` can't
  read that endpoint; discovery still works, just without pricing/mode
  metadata.

### Automatic variants / thinking control via models.dev

Discovered models are enriched from the [models.dev](https://models.dev)
catalog (the same dataset OpenCode uses for its built-in providers).
Matching strips route prefixes (`CLIProxyAnthropic/claude-opus-5` →
`claude-opus-5`) and common alias suffixes (`gemini-3.5-flash-low` →
`gemini-3.5-flash`), then fills in:

- **`variants`** generated from the catalog's `reasoning_options`,
  shaped per adapter — `effort` levels become `reasoningEffort`
  (openai-compatible), `thinking: adaptive` + `effort`
  (`@ai-sdk/anthropic`, gated on models that support it), or
  `thinkingConfig.thinkingLevel` (`@ai-sdk/google`); `budget_tokens`
  becomes `high`/`max` thinking-budget variants; `toggle` becomes a
  `none` variant that disables reasoning.
- **`cost`** (models.dev list prices, per-million) when LiteLLM didn't
  provide pricing. If your proxy bills custom rates, hand-curate those
  entries — curated entries are always preserved verbatim.
- **`limit`**, **`modalities`**, `attachment`, `tool_call`, `reasoning`
  flags when missing.

Disable with `"modelsDev": false` in the provider options. The catalog
fetch is memoized per process, capped at 10 s, and failures degrade to
plain discovery.

### Fallback metadata for uncatalogued models (`modelDefaults`)

Self-hosted builds rarely appear in models.dev — ids like
`omlx/Qwen3.6-27B-oQ8-fp16-mtp` carry quantization suffixes that match
nothing, so they arrive with no `variants`, no `limit`, and no
reasoning flag. `modelDefaults` supplies that metadata by glob:

```json
"options": {
  "litellm": true,
  "modelDefaults": [
    {
      "match": ["omlx/*"],
      "exclude": ["omlx/*ASR*", "omlx/whisper*"],
      "model": {
        "reasoning": true,
        "tool_call": true,
        "limit": { "context": 131072, "output": 131072 },
        "cost": { "input": 0, "output": 0 },
        "variants": {
          "none": { "reasoningEffort": "none" },
          "low": { "reasoningEffort": "low" },
          "high": { "reasoningEffort": "high" }
        }
      }
    }
  ]
}
```

- Applied **after** discovery and models.dev enrichment, and **fills
  gaps only** — real catalog data always wins. A model the catalog does
  know keeps its own `limit`/`cost` and only picks up the missing
  fields.
- Merging is recursive for plain objects, so a rule can add a missing
  variant without clobbering discovered ones.
- Rules are evaluated in declaration order; every match contributes, and
  an earlier rule's value is never overwritten by a later one.
- Hand-curated `models` entries are untouched, as always.

### MCP server discovery (`litellmMcp`)

LiteLLM can also act as an [MCP](https://modelcontextprotocol.io) gateway,
fronting a set of MCP servers behind the same key you already use for
models. Set `litellmMcp: true` and the plugin discovers them from
`/v1/mcp/server` and injects one OpenCode `mcp` entry per server:

```json
"options": {
  "litellm": true,
  "litellmMcp": true,
  "litellmMcpEnabled": false,
  "mcpFilter": ["zread", "web_*"],
  "excludeMcpServers": ["web_search_prime"]
}
```

A proxy exposing `zread` and `web_reader` yields:

```json
"mcp": {
  "litellm_zread": {
    "type": "remote",
    "url": "https://your-proxy/mcp/zread",
    "enabled": false,
    "headers": { "x-litellm-api-key": "Bearer sk-…" }
  },
  "litellm_web_reader": { "…": "…" }
}
```

- **Opt-in**, unlike model discovery, because it writes to the
  **top-level `mcp` section** rather than a single provider. When
  several providers share one proxy, enable it on just one — the plugin
  injects a given proxy's servers only once either way.
- Discovered servers are enabled by default. Set
  `litellmMcpEnabled: false` to register every server disabled; OpenCode
  still lists them, and you can turn individual servers on at runtime
  from the MCP dialog (`mod+;` or the `/mcp` command, `space` to toggle).
- Keys are prefixed **`litellm_`** so injected entries can't be confused
  with hand-written ones. Override with `litellmMcpPrefix` (`""` for
  bare aliases).
- **One entry per server**, not a single aggregate `/mcp/` entry: tool
  names stay unprefixed, OpenCode reports health per server, and one
  unreachable upstream doesn't take down the rest.
- `mcpFilter` / `excludeMcpServers` are `*`-globs mirroring
  `modelFilter` / `excludeModels`. They match the **LiteLLM routing
  alias** (`zread`), not the prefixed key. `excludeMcpServers` is the
  way to suppress a server that's registered but exposes no usable
  tools.
- Hand-written `mcp` entries always win — an existing key is never
  overwritten, exactly like curated `models`.
- Auth uses `x-litellm-api-key: Bearer <key>`, leaving `Authorization`
  free for servers that delegate it upstream. The `Bearer ` prefix is
  required by LiteLLM on this header.

Requires a key permitted to `GET /v1/mcp/server`. Keys restricted to
`llm_api_routes` qualify via LiteLLM's GET-only carve-out for the MCP
discovery routes, so the credential used for model discovery normally
works unchanged.

### Reasoning models (gpt-5, o1/o3/o4)

OpenAI's reasoning-tier models reject requests that combine `reasoning_effort`
with function tools when sent to `/v1/chat/completions`. The OpenAI Responses
API (`/v1/responses`) has no such restriction, so the plugin routes those
models through a **second provider entry** named `litellm-responses` that
uses an SDK speaking the Responses API.

You don't need to do anything for the default behaviour — the plugin
detects reasoning-tier models from their id (`gpt-5*`, `o1*`, `o3*`,
`o4*`) and from LiteLLM's `mode === 'responses'` field, and creates the
sibling provider lazily.

To override the routing per model:

```jsonc
{
  "provider": {
    "litellm": {
      "options": {
        "baseURL": "http://localhost:4000/v1",

        // "auto" (default) | "chat" | "responses"
        "transport": "auto",

        // Force these into /v1/responses (highest precedence)
        "responsesApiModels": ["gpt-5-4-high", "my-custom-reasoning-model"],

        // Force these into /v1/chat/completions
        "chatApiModels": ["o1-mini-cheap"]
      }
    }
  }
}
```

The two providers share `baseURL` and `apiKey`. Models curated by hand
under either provider's `models` block are preserved verbatim, and a
discovered model is skipped if its key already exists under **either**
provider.

> **Note**: this requires LiteLLM ≥ 1.40 (which proxies `/v1/responses`)
> and an `@ai-sdk/openai` version that supports the Responses API. Older
> AI SDKs may silently fall back to chat-completions, in which case set
> `responsesApiModels` to an empty list and fix the upstream LiteLLM
> config instead (e.g. `use_responses_api: true` per model).

### Authentication

If your LiteLLM proxy requires a master key, expose it via either approach:

| Method | Example |
|---|---|
| Env var | `export LITELLM_API_KEY=sk-...` |
| Env var (alias) | `export LITELLM_MASTER_KEY=sk-...` |
| Config | `"options": { "apiKey": "{env:LITELLM_API_KEY}" }` |

The env var path lets you commit `opencode.json` without leaking secrets.

### Custom headers (Cloudflare Access, API gateways)

If your LiteLLM proxy is behind Cloudflare Access or another gateway that requires extra HTTP headers, use the `customHeaders` option:

```jsonc
{
  "provider": {
    "litellm": {
      "options": {
        "baseURL": "https://litellm.internal.example.com/v1",
        "apiKey": "{env:LITELLM_API_KEY}",
        "customHeaders": {
          "CF-Access-Client-Id": "{env:CF_ACCESS_CLIENT_ID}",
          "CF-Access-Client-Secret": "{env:CF_ACCESS_CLIENT_SECRET}"
        }
      }
    }
  }
}
```

These headers are included in every request the plugin makes during model discovery (health check and `/v1/models`). To obtain a Cloudflare Access Service Token, follow the [Cloudflare docs](https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/).

## 🔧 How it works

```mermaid
sequenceDiagram
    participant OC as OpenCode
    participant Plugin as opencode-litellm
    participant LL as LiteLLM proxy

    OC->>Plugin: config(initial)
    alt provider.litellm configured
        Plugin->>LL: GET /v1/models @ baseURL
    else not configured
        Plugin->>LL: probe :4000, :8000, :8080
        LL-->>Plugin: 200 OK on one
        Plugin->>Plugin: auto-create provider entry
    end
    Plugin->>LL: GET /v1/models (with auth if set)
    Plugin->>LL: GET /v1/model/info (best-effort, for `mode` + limits)
    LL-->>Plugin: { data: [...models] } + per-model info
    Plugin->>Plugin: enrich models, hide non-chat (embedding/image/audio)
    Plugin->>Plugin: preserve model IDs and infer modalities
    Plugin->>Plugin: bucket each model by transport (chat vs responses)
    Plugin->>OC: merge chat-completions models into provider.litellm
    Plugin->>OC: merge responses models into provider.litellm-responses (lazy)
    OC->>OC: render model picker with all eligible discovered chat models
```

1. On OpenCode startup the `config` lifecycle hook fires.
2. If `provider.litellm` exists, its `baseURL` is used. Otherwise common ports are probed.
3. A health check (`GET /v1/models`) verifies the proxy is reachable and authorized.
4. Models from the response are enriched with `/v1/model/info` metadata (`mode`, token limits, capability flags — `/v1/models` omits these for database-defined models) and converted into OpenCode model entries keyed and displayed by their exact LiteLLM `id`, with inferred `modalities`. Non-chat models (embedding / image / audio) are excluded from the picker.
5. Each model is bucketed by transport — reasoning-tier models (`gpt-5*`, `o1`/`o3`/`o4*`, or anything with `mode === 'responses'`) go into the `litellm-responses` provider; everything else goes into `litellm`. Per-model overrides via `responsesApiModels` / `chatApiModels` win.
6. Discovered models are merged on top of any user-defined ones — never overwriting them. A model is skipped if its key already exists under **either** provider.
7. The whole flow is wrapped in a `Promise.race` against a 20 s timeout so a slow proxy never blocks boot.

## 📋 Requirements

- [OpenCode](https://opencode.ai) ≥ 0.1.x with plugin support (`@opencode-ai/plugin ^1.0.166`)
- A running [LiteLLM](https://github.com/BerriAI/litellm) proxy:
  ```bash
  pip install 'litellm[proxy]'
  litellm --config config.yaml --port 4000
  ```
- Node.js ≥ 20 (or Bun ≥ 1.0)

## 📦 Compatibility matrix

| LiteLLM version | OpenCode version | Status |
|---|---|---|
| ≥ 1.40 | ≥ 0.1.x | ✅ Tested |
| 1.30 – 1.39 | ≥ 0.1.x | ⚠️ Should work (older `/v1/models` schema) |
| < 1.30 | any | ❌ Unsupported |

## ❓ FAQ

<details>
<summary><b>Why doesn't a model appear in OpenCode after I add it to LiteLLM?</b></summary>

OpenCode reads the plugin output once at startup. After updating `litellm config.yaml`, restart **both** LiteLLM and OpenCode to refresh the model list.
</details>

<details>
<summary><b>Can I use this with a remote LiteLLM proxy?</b></summary>

Yes. Set `provider.litellm.options.baseURL` to your remote URL and (optionally) `apiKey`. Auto-detection only probes `localhost`, but explicit configuration works against any URL.
</details>

<details>
<summary><b>What happens if LiteLLM is offline at startup?</b></summary>

The plugin logs a warning and is a no-op. OpenCode starts normally; you just won't see LiteLLM-discovered models until you restart with the proxy up.
</details>

<details>
<summary><b>Will my hand-curated model entries be overwritten?</b></summary>

No. The merge is additive: anything you've already defined under `provider.litellm.models` is preserved exactly as-is. Discovered models are only added if their key isn't already present.
</details>

<details>
<summary><b>Why is the npm name <code>opencode-plugin-litellm</code> and not <code>opencode-litellm</code>?</b></summary>

The unscoped `opencode-litellm` was already published by another author when this project was started. The GitHub repo and exported plugin symbol still use the cleaner `opencode-litellm` name.
</details>

<details>
<summary><b>Does this work with Ollama through LiteLLM?</b></summary>

Yes — anything in your LiteLLM `model_list` shows up, including Ollama, Bedrock, Azure, OpenAI, Anthropic, Google, etc. That's the whole point of LiteLLM.
</details>

<details>
<summary><b>My LiteLLM proxy is behind Cloudflare Access — how do I authenticate?</b></summary>

Cloudflare Access intercepts requests before they reach LiteLLM, so a plain `Authorization: Bearer` header isn't enough. Create a [Cloudflare Access Service Token](https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/) and pass the credentials via `customHeaders`:

```jsonc
{
  "provider": {
    "litellm": {
      "options": {
        "baseURL": "https://litellm.your-company.com/v1",
        "customHeaders": {
          "CF-Access-Client-Id": "{env:CF_ACCESS_CLIENT_ID}",
          "CF-Access-Client-Secret": "{env:CF_ACCESS_CLIENT_SECRET}"
        }
      }
    }
  }
}
```

The `customHeaders` map works for any gateway that requires extra HTTP headers — not just Cloudflare.
</details>

<details>
<summary><b>I get <code>Function tools with reasoning_effort are not supported … in /v1/chat/completions</code> — what do I do?</b></summary>

This error comes from OpenAI: their reasoning-tier models (gpt-5, o1, o3, o4) refuse function-tool calls on `/v1/chat/completions` when `reasoning_effort` is set. They require `/v1/responses` instead.

As of `0.2.0`, `opencode-litellm` automatically routes those models through a sibling `litellm-responses` provider that uses the Responses API. If your model id doesn't match the heuristic (e.g. you renamed it in LiteLLM), add it explicitly:

```jsonc
"provider": {
  "litellm": {
    "options": {
      "responsesApiModels": ["my-renamed-gpt-5-high"]
    }
  }
}
```

The model will appear under the **LiteLLM (responses)** provider in the picker; pick it from there and tool-calling will work.
</details>

<details>
<summary><b>Why are there suddenly two providers (<code>litellm</code> and <code>litellm-responses</code>) in the picker?</b></summary>

Same LiteLLM proxy, different transport. `litellm` talks to `/v1/chat/completions`; `litellm-responses` talks to `/v1/responses`. The split is required for OpenAI reasoning models — see the FAQ entry above.

The responses provider is created lazily and only appears if at least one discovered model needs it. To collapse everything back into a single provider, set `"transport": "chat"` in `provider.litellm.options` (you'll lose tool-calling on reasoning models in exchange).
</details>

## 🛠️ Development

```bash
git clone https://github.com/yuseferi/opencode-litellm.git
cd opencode-litellm
npm install
npm run typecheck
```

The project is intentionally tiny:

```
src/
├── index.ts                    # Public exports
├── types/index.ts              # LiteLLM API types
├── utils/
│   ├── litellm-api.ts          # health check, discovery (/v1/models + /v1/model/info), auto-detect
│   └── format-model-name.ts    # owner extraction, name formatting, categorization
└── plugin/
    ├── index.ts                # LiteLLMPlugin entry (config hook, enrichment, filtering)
    ├── discover.ts             # V2 Model bucketing (unused by the config hook)
    └── build-model.ts          # V2 Model entry builder
```

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the full contributor workflow.

## 🗺️ Roadmap

- [ ] Optional cost/latency overlay using LiteLLM's `/spend` and `/health` endpoints
- [ ] In-memory cache with TTL to avoid re-querying on rapid restarts
- [ ] Model categorization based on `litellm.proxy.config.model_list[].model_info`
- [ ] Tests with [vitest](https://vitest.dev/)
- [ ] `chat.params` hook for injecting LiteLLM routing tags / fallbacks

Have an idea? [Open an issue](https://github.com/yuseferi/opencode-litellm/issues/new).

## 🙏 Acknowledgements

Inspired by [`opencode-lmstudio`](https://github.com/agustif/opencode-lmstudio) by [@agustif](https://github.com/agustif) — the architectural blueprint for OpenCode model-discovery plugins.

Built on top of [LiteLLM](https://github.com/BerriAI/litellm) by the [BerriAI](https://github.com/BerriAI) team and [OpenCode](https://opencode.ai) by the OpenCode contributors.

## 📄 License

[MIT](./LICENSE) © [Yusef Mohamadi](https://github.com/yuseferi)

---

<div align="center">

If this project saved you time, consider giving it a ⭐ on [GitHub](https://github.com/yuseferi/opencode-litellm).

</div>
