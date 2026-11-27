# BetterAgent

BetterAgent brings Codex into Obsidian for chat, file context, and inline editing. Codex uses your vault as its working directory for reading, editing, and searching files and running commands.

BetterAgent is maintained by Jovlang and forked from [Claudian](https://github.com/YishenTu/claudian), created by Yishen Tu.

## Changes from upstream Claudian

### Codex and file context

- **Codex is the only provider.** Its settings are shown directly, without an integration picker. The Claude Code, OpenCode, Pi, Grok, Antigravity, and DeepSeek integrations and the shared ACP layer were removed. Existing Codex conversations still appear in History; other providers’ conversation files and metadata are left in place but are not shown.
- **Linked content is no longer Markdown-only.** New chats can automatically link the active PDF, Canvas, Base, or other vault file as well as notes. Tag exclusions still apply. Linking a file supplies its path as context; it doesn’t guarantee Codex can interpret the format.
- **The composer has one Send/Stop button and spellcheck is off.** With an empty composer, an editor or browser selection can be sent as the prompt. When there’s a typed prompt, the selection is included as context instead. Escape can cancel a running turn without also closing History.

### Chat and history

- **One adaptive chat viewer replaces the tab row and floating Zen Mode.** The standard command to focus the chat composer remains. **New chat**, **History**, and **More** sit next to Linked content below the composer.
- **History is searchable and adapts to pane width.** It opens beside the chat above 600 px and replaces it when opened in narrower panes. It supports sorting, conversation actions, and a switch between a flat list and grouping by linked content without clearing the current search. **Archive** is under **More**. The mouse Back button toggles History inside chat; returning to chat preserves the conversation, scroll position, and unsent draft.
- **Projects and automatic project instructions and memory are gone.** Former project conversations supported by Codex appear in ordinary History. [Legacy project records and memory notes](docs/projects.md) are not moved or deleted.
- **Cross-session messaging and the experimental plugin API are gone.** Agents can no longer discover, read, start, message, or control other conversations through plugin tools. The local messaging endpoint and public API were removed, and old session mentions are treated as plain text. Manual History, file and folder mentions, Inline Edit, and Side Chat are still available. See [cross-session messaging](docs/cross-session-messaging.md).

### Plugin identity and maintenance

- **Separate plugin ID and branding.** BetterAgent uses `betteragent` instead of `realclaudian`, with its own UI labels, agent prompts, and issue tracker. It still uses Claudian’s vault storage and chat view for compatibility; don’t enable both plugins in the same vault.
- **A smaller codebase and release process.** Provider-specific dependencies, unused UI and locale strings, and obsolete tests were removed. Remaining tests and build checks focus on Codex, including permission-setting restoration and preservation of legacy session metadata. Inherited GitHub Actions workflows were removed; [releases are published manually from tags](CONTRIBUTING.md).

See the [BetterAgent commit history](https://github.com/Jovlang/BetterAgent/commits/betteragent/) for the implementation details.

## Features & Usage

Open BetterAgent from the ribbon icon or command palette. Configure Codex under **Settings → BetterAgent → Codex**.

**Inline Edit** — Select text or start at the cursor position + hotkey to edit directly in notes with word-level diff preview.

**Slash Commands & Skills** — Type `/` or `$` for reusable prompt templates or Skills from user- and vault-level scopes.

**@mention** — Type `@` to reference vault files and folders.

**Side Chat (`/side` or `/btw`)** — Explore a separate, temporary conversation with follow-ups and tools while keeping the main chat unchanged.

**MCP Servers** — Connect external tools through the Codex CLI’s MCP configuration.

**Conversation History** — Click **History** below the composer or press the mouse Back button inside chat. Use **More → Archive** to find archived conversations.

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
│   └── codex/                   # Codex shared app-server adaptor, JSON-RPC, JSONL history
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
