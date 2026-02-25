# copilot-proxy

> Use your GitHub Copilot subscription as the backend for [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

A zero-dependency localhost proxy that translates the Anthropic Messages API into the OpenAI Chat Completions format used by GitHub Copilot's API. This lets you run `claude` (Claude Code CLI) powered entirely by your existing Copilot Business/Enterprise subscription — no separate Anthropic API key required.

```
┌────────────┐     Anthropic API      ┌───────────────┐    OpenAI API     ┌─────────────────┐
│ Claude Code │ ──────────────────────▶│ copilot-proxy │ ────────────────▶│ GitHub Copilot  │
│    (CLI)    │◀────────────────────── │  :4141        │◀──────────────── │      API        │
└────────────┘  Anthropic SSE events  └───────────────┘  OpenAI SSE      └─────────────────┘
```

## Features

- **Full API translation** — Anthropic Messages API ↔ OpenAI Chat Completions, including streaming SSE
- **All Claude models** — Opus 4.6, Sonnet 4.6, Haiku 4.5 (and 4.5 variants)
- **Tool use / function calling** — Complete bidirectional translation of tool definitions and results
- **Streaming** — Real-time SSE event translation (OpenAI `data:` → Anthropic `event:` format)
- **Multi-modal** — Image content blocks translated to OpenAI `image_url` format
- **Zero dependencies** — Pure Node.js stdlib (`http`, `https`, `fs`, `os`, `path`, `child_process`)
- **Auto-authentication** — Discovers tokens from 5 sources with GitHub Device Flow fallback
- **Token refresh** — Automatic retry on 401/403 with token cache invalidation

## Quick Start

### One-command install

```bash
git clone https://github.com/schwarztim/copilot-proxy.git ~/.copilot-proxy
ln -sf ~/.copilot-proxy/claude-copilot ~/.local/bin/claude-copilot
```

Then just run:

```bash
claude-copilot
```

The launcher handles everything: starts the proxy, seeds the required config, and launches Claude Code.

### Manual setup

```bash
# 1. Start the proxy
node proxy.mjs

# 2. Point claude at it
export ANTHROPIC_BASE_URL=http://localhost:4141
export ANTHROPIC_API_KEY=sk-ant-copilot-proxy-not-a-real-key
claude
```

## How It Works

### Authentication Chain

The proxy discovers your GitHub Copilot token automatically, checking these sources in order:

| Priority | Source | Description |
|----------|--------|-------------|
| 1 | `COPILOT_GITHUB_TOKEN` | Environment variable override |
| 2 | OpenCode `auth.json` | `~/.local/share/opencode/auth.json` |
| 3 | macOS Keychain | Service: `copilot-cli` |
| 4 | GitHub CLI | `gh auth token` |
| 5 | Legacy config | `~/.config/github-copilot/apps.json` |
| 6 | **Device Flow** | Interactive GitHub OAuth (first-run only) |

If no token is found, the proxy starts an interactive [GitHub Device Flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow) to authenticate with the `copilot` scope.

### Model Mapping

Claude Code sends model IDs with dashes (e.g., `claude-sonnet-4-6`). The Copilot API expects dots (e.g., `claude-sonnet-4.6`). The proxy handles this automatically, including stripping date suffixes and version tags.

| Claude Code sends | Copilot receives |
|-------------------|------------------|
| `claude-sonnet-4-6` | `claude-sonnet-4.6` |
| `claude-opus-4-6` | `claude-opus-4.6` |
| `claude-haiku-4-5` | `claude-haiku-4.5` |
| `claude-sonnet-4-5-20250929` | `claude-sonnet-4.5` |
| `claude-opus-4-5-v1` | `claude-opus-4.5` |

Non-Claude models (GPT, Gemini) are passed through unchanged.

### API Translation

The proxy performs bidirectional translation between the two API formats:

**Request (Anthropic → OpenAI)**
- System prompts → `role: "system"` messages
- Content blocks → Concatenated text or multipart content
- `tool_use` blocks → `tool_calls` array
- `tool_result` blocks → `role: "tool"` messages
- Image blocks → `image_url` with data URI
- `stop_sequences` → `stop`
- `thinking` → `reasoning_effort`

**Response (OpenAI → Anthropic)**
- `choices[0].message` → Anthropic message envelope
- `finish_reason` mapping: `stop`→`end_turn`, `length`→`max_tokens`, `tool_calls`→`tool_use`
- Token usage translation with cache token fields

**Streaming (OpenAI SSE → Anthropic SSE)**
- `message_start` → `content_block_start` → `content_block_delta` → `content_block_stop` → `message_delta` → `message_stop`
- `delta.content` → `text_delta` events
- `delta.tool_calls` → `input_json_delta` events with proper block lifecycle

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `COPILOT_PROXY_PORT` | `4141` | Port the proxy listens on |
| `COPILOT_GITHUB_TOKEN` | — | Override the GitHub token |
| `ANTHROPIC_BASE_URL` | — | Set by launcher; points claude at proxy |
| `ANTHROPIC_API_KEY` | — | Set by launcher; `sk-ant-` prefixed key |

### Verbose logging

```bash
node proxy.mjs --verbose    # or -v
```

Logs model routing, message counts, and token usage to stderr.

## Architecture

```
proxy.mjs (804 lines, zero dependencies)
├── Token Management      — Multi-source token discovery + caching
├── GitHub Device Flow    — Interactive OAuth for first-run auth
├── Anthropic → OpenAI    — Request translation (messages, tools, images)
├── OpenAI → Anthropic    — Response translation (non-streaming)
├── Streaming Translator  — SSE event-by-event conversion
├── HTTP Server           — Routes: /v1/messages, /v1/models, /health
└── Helpers               — Logging, JSON parsing

claude-copilot (launcher script)
├── Proxy Lifecycle       — Auto-start with health check polling
├── Config Seeding        — Onboarding wizard bypass for claude-cli
└── Exec                  — Replaces process with claude binary
```

## Limitations

- **Copilot subscription required** — You need GitHub Copilot Business or Enterprise
- **Rate limits** — Subject to Copilot's rate limiting, not Anthropic's
- **Extended thinking** — Mapped to `reasoning_effort: "high"` (not native thinking blocks)
- **Caching** — Copilot doesn't support prompt caching; cache token fields are zeroed
- **Beta features** — Anthropic beta headers are not forwarded

## Troubleshooting

**Proxy won't start**
```bash
cat /tmp/copilot-proxy.log
# Check if port 4141 is in use
lsof -i :4141
```

**Authentication issues**
```bash
# Verify your token works
curl -s https://api.business.githubcopilot.com/models \
  -H "Authorization: Bearer $(gh auth token)" \
  -H "Copilot-Integration-Id: copilot-developer-cli"
```

**Claude shows onboarding wizard**
```bash
# The launcher seeds this automatically, but if needed manually:
claude-copilot --version  # Triggers config seeding without starting interactive mode
```

## Requirements

- **Node.js** ≥ 18
- **GitHub Copilot** Business or Enterprise subscription
- **Claude Code** CLI (`claude`) installed

## License

[MIT](LICENSE)
