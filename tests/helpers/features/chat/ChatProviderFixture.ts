import { FakeSession } from '@test/helpers/ChatExecutionHarness';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { codexProviderRegistration } from '@/providers/codex/registration';

/** Keep Codex model and UI policies real; replace native execution in the view tests. */
export function registerChatTestProvider() {
  const sessions: FakeSession[] = [];
  const workspace = { initialize: async () => ({}) };
  ProviderRegistry.register('codex', {
    ...codexProviderRegistration,
    createExecutionBackend: () => ({
      providerId: 'codex',
      createSession: () => {
        const session = new FakeSession('codex', `codex-session-${sessions.length + 1}`);
        sessions.push(session);
        return session;
      },
    }),
  });
  ProviderWorkspaceRegistry.register('codex', workspace);
  onTestFinished(async () => {
    await ProviderWorkspaceRegistry.disposeInitialized();
    ProviderWorkspaceRegistry.clear();
  });
  return { sessions };
}
