# BetterAgent

BetterAgent is a fork of Claudian, focused on unrestricted file context and a cleaner user experience.

BetterAgent is maintained by Jovlang. The original [Claudian](https://github.com/YishenTu/claudian) plugin was created by Yishen Tu. BetterAgent disables spellcheck in the chat composer and lets new chats automatically link active non-Markdown files, such as PDFs and Canvas files. Existing tag exclusions still apply.

Some screenshots still show the upstream Claudian interface.

![Preview](assets/Preview.png)

An Obsidian plugin that brings Codex into your vault. Your vault becomes its working directory for reading, editing, and searching files and running commands.

## Features & Usage

Open BetterAgent from the ribbon icon or command palette. Configure Codex under **Settings → BetterAgent → Codex**.

**Inline Edit** — Select text or start at the cursor position + hotkey to edit directly in notes with word-level diff preview.

**Slash Commands & Skills** — Type `/` or `$` for reusable prompt templates or Skills from user- and vault-level scopes.

**@mention** — Type `@` to reference vault files and folders.

**Side Chat (`/side` or `/btw`)** — Explore a separate, temporary conversation with follow-ups and tools while keeping the main chat unchanged.

**MCP Servers** — Connect external tools through the Codex CLI’s MCP configuration.

**Conversation History** — Open **History** next to Linked content below the composer to search for a conversation. History opens automatically beside the chat when the pane is wider than 600 px. In narrow panes it replaces the chat when opened manually; **Back** returns to the same conversation and draft. Find **Archive** under **More** in the same row.

**Migrating from older versions** — The floating Zen panel, chat tab row, project management, and agent-facing session tools are no longer available. Existing Codex conversations remain in History, and BetterAgent does not move or delete [old project files and memory notes](docs/projects.md).

**Plugin API (experimental)** — Let other Obsidian plugins send prompts to sessions, stop them and read their replies. See the [Plugin API guide](docs/plugin-api.md).

**Collaboration** — Collab is now a standalone plugin. See [Claudian Collab](https://github.com/YishenTu/claudian-collab).

## Requirements

- [Codex CLI](https://github.com/openai/codex) with a compatible subscription or API key
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

- **Sent to API**: Your input, attached files, images, and tool call outputs. Codex sends data to its configured API.
- **No telemetry or unsolicited background activity**: BetterAgent does not run telemetry beacons. UI polling timers read local Obsidian/editor selection state only. Network activity is limited to explicit provider runtime work, configured MCP endpoints, provider SDK/CLI calls needed to answer your requests, and their configured services.

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
