# Projects

BetterAgent no longer manages projects or automatically includes project instructions or memory in a conversation. Use Obsidian notes and folders for organization and reference relevant notes from the chat.

Existing conversations still appear in history. BetterAgent migrates the entire private `.claudian/` directory to `.betteragent/` on startup, including any old project records under `projects/`. Memory notes at paths you chose are left in place. If both data directories exist, startup leaves both untouched rather than overwriting either.
