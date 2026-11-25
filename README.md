# BetterAgent

BetterAgent is a fork of Claudian, focused on unrestricted file context and a cleaner user experience.

BetterAgent is maintained by Jovlang. The original [Claudian](https://github.com/YishenTu/claudian) plugin was created by Yishen Tu. BetterAgent disables spellcheck in the chat composer and lets new chats automatically link active non-Markdown files, such as PDFs and Canvas files. Existing tag exclusions still apply.

Some screenshots still show the upstream Claudian interface.

![Preview](assets/Preview.png)

An Obsidian plugin that embeds AI coding agents (Claude Code, Codex, Grok Build, Antigravity CLI, OpenCode, Pi, DeepSeek Harness, and more to come) in your vault. Your vault becomes the agent's working directory — file read/write, search, bash, and multi-step workflows all work out of the box.

## Features & Usage

Open the BetterAgent interface from the ribbon icon or command palette. Everything works like your familiar coding agent, Claude Code, Codex, Grok Build, Antigravity CLI, OpenCode, Pi, and DeepSeek Harness — talk to the agent, and it reads, writes, edits, searches and run commands in your vault.

**Inline Edit** — Select text or start at the cursor position + hotkey to edit directly in notes with word-level diff preview.

**Projects** — Group sessions that work toward a shared goal. Every member shares the project's instructions and a memory file that the agents keep current, and the agents can cooperate by finding, reading and messaging each other. See the [Projects guide](docs/projects.md).

**Zen Mode** — Collapse the sidebar holding BetterAgent and the chat moves to a [compact composer](assets/zen-mode-collapsed.png) at the bottom of your notes, with a one-line activity preview and [the conversation one click away](assets/zen-mode-expanded.png).

**Slash Commands & Skills** — Type `/` or `$` for reusable prompt templates or Skills from user- and vault-level scopes.

**@mention** — Type `@` to reference vault files, folders and other BetterAgent sessions.

**Cross-Session Messaging** — Let agents read, message, steer or interrupt other BetterAgent sessions, or start new ones on any provider. See the [Cross-session messaging guide](docs/cross-session-messaging.md).

**Side Chat (`/side` or `/btw`)** — Explore a separate, temporary conversation with follow-ups and tools while keeping the main chat unchanged.

**MCP Servers** — Connect external tools through each coding agent's native CLI-managed MCP configuration.

**Tabs & Session Management** — Use multiple tabs in [single-pane mode](assets/main-chat-single-pane.png) or a persistent session manager beside the chat in [dual-pane mode](assets/main-chat-dual-pane.png).

**Plugin API (experimental)** — Let other Obsidian plugins send prompts to sessions, stop them and read their replies. See the [Plugin API guide](docs/plugin-api.md).

**Collaboration** — Collab is now a standalone plugin. See [Claudian Collab](https://github.com/YishenTu/claudian-collab).

## Requirements

- At least one of the following harnesses:
  - [Antigravity CLI](https://antigravity.google/product/antigravity-cli)
  - [Claude Code](https://code.claude.com/docs/en/overview)
  - [Codex](https://github.com/openai/codex)
  - [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
  - [Grok Build](https://github.com/xai-org/grok-build)
  - [OpenCode V2](https://github.com/anomalyco/opencode)
  - [Pi](https://github.com/earendil-works/pi)
- A compatible subscription or API provider
- Obsidian v1.13.0+
- Desktop only (macOS, Linux, Windows)

## Installation

### With BRAT

1. Install and enable [Obsidian42 - BRAT](https://github.com/TfTHacker/obsidian42-brat) in Obsidian.
2. If Claudian or the earlier BetterAgent build is enabled, disable it in **Settings → Community plugins**. BetterAgent now has its own plugin ID (`betteragent`), but still uses Claudian's vault data and chat view, so don't enable both in the same vault.
3. Run **BRAT: Add a beta plugin for testing**, enter `Jovlang/BetterAgent`, and choose **Latest Version** or version `2.3.48` or newer.
4. If BRAT did not enable BetterAgent, enable it under **Settings → Community plugins**.

### From source (development)

1. Clone this repository into your vault's plugins folder:
   ```bash
   cd /path/to/vault/.obsidian/plugins
   git clone https://github.com/Jovlang/BetterAgent.git betteragent
   cd betteragent
   ```

2. Install dependencies and build:
   ```bash
   npm install
   npm run build
   ```

3. Enable the plugin in Obsidian:
   - Settings → Community plugins → Enable "BetterAgent"

### Development

```bash
# Watch mode
npm run dev

# Production build
npm run build
```

## Privacy & Data Use

- **Sent to API**: Your input, attached files, images, and tool call outputs. Depending on the selected provider, data is sent to Anthropic (Claude), OpenAI (Codex), xAI (Grok), Google (Antigravity), or the providers configured in OpenCode, Pi, or DeepSeek Harness. The destination can be configured through provider settings and environment variables.
- **No telemetry or unsolicited background activity**: BetterAgent does not run telemetry beacons. UI polling timers read local Obsidian/editor selection state only. Network activity is limited to explicit provider runtime work, configured MCP endpoints, a 127.0.0.1-only listener that OpenCode, DeepSeek and Grok sessions use for BetterAgent's session tools, provider SDK/CLI calls needed to answer your requests, and their configured services.

## Troubleshooting

See the [Troubleshooting guide](docs/troubleshooting.md) for a provider CLI or Node.js that isn't found, a newly released model that is missing, and authentication that fails while the CLI subscription works. If you have a feature request or run into a bug, please [submit a GitHub issue](https://github.com/Jovlang/BetterAgent/issues).

## Architecture

```
src/
├── main.ts                      # Plugin entry point and sole composition root
├── composition/                 # Host objects and view wiring shared by app and features
├── app/                         # Startup, conversations, settings, and storage
├── core/                        # Provider-neutral execution, registry, and type contracts
│   ├── execution/               # Run, session snapshot, and interaction primitives
│   ├── providers/               # Provider registry and workspace services
│   ├── process/                 # CLI discovery and managed child processes
│   ├── prompt/                  # Prompt and context encoding
│   ├── auxiliary/               # Shared provider auxiliary services
│   └── ...                      # bootstrap, commands, rpc, security, storage, tools, types
├── providers/
│   ├── antigravity/             # Antigravity CLI ACP adaptor, transcript history, models
│   ├── claude/                  # Claude Agent SDK adaptor, native history, plugins
│   ├── codex/                   # Codex shared app-server adaptor, JSON-RPC, JSONL history
│   ├── deepseek/                # DeepSeek Harness native Remote adaptor, presets, and history
│   ├── grok/                    # Grok Build ACP adaptor, native history, models, and tools
│   ├── opencode/                # OpenCode HTTP adaptor, shared server
│   ├── pi/                      # Pi RPC adaptor, model discovery, JSONL history
│   └── acp/                     # Agent Client Protocol shared mechanics
├── features/
│   ├── agent-skills/            # Vault skill and Claude command management
│   ├── chat/                    # Sidebar chat: tabs, workspace lifecycle, controllers, renderers
│   ├── inline-edit/             # Inline edit modal and provider-backed edit services
│   └── settings/                # Settings shell and provider tabs
├── shared/                      # Reusable UI components, settings controls, mention/dropdown
├── i18n/                        # Internationalization (10 locales)
├── utils/                       # Domain-free leaf helpers
└── style/                       # Modular CSS
```

## Contributing

Issues and focused pull requests are welcome. Issues are the preferred starting point: describe the problem, reproduction steps, and environment clearly so it can be investigated.

Before opening a pull request, please read the [contribution guide](CONTRIBUTING.md). Pull requests must explain the problem, the proposed solution, why the approach is appropriate, and how the change was validated. Pull requests that add a new provider are not accepted; the guide explains this maintenance and product-quality boundary in detail.

## License

Licensed under the [MIT License](LICENSE).
