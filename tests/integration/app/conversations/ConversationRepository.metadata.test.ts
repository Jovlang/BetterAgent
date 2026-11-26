import { DesktopVault } from '@test/helpers/core/DesktopVault';
import { testDate } from '@test/helpers/testClock';

import { ConversationRepository } from '@/app/conversations/ConversationRepository';
import { ConversationPersistenceStore } from '@/app/storage/ConversationPersistenceStore';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import { registerProviderModules } from '@/core/providers/registerProviderModules';
import type { Conversation, SessionMetadata, UsageInfo } from '@/core/types';
import { codexProviderRegistration } from '@/providers/codex/registration';

registerProviderModules([codexProviderRegistration]);

const DEVICE_KEY = `device-${'a'.repeat(64)}`;
let vault: DesktopVault;
let store: ConversationPersistenceStore;
let repository: ConversationRepository;
beforeEach(async () => {
  vault = await DesktopVault.create();
  store = new ConversationPersistenceStore(vault.files, DEVICE_KEY);
  repository = new ConversationRepository({
    providers: ProviderRegistry, providerSettings: ProviderSettingsCoordinator,
    getSettings: () => ({}), getVaultPath: () => vault.root,
    persistence: store, onConversationDeleted: async () => undefined,
  });
});
afterEach(async () => { vi.restoreAllMocks(); await vault.dispose(); });

async function persistMetadata(conversation: Conversation): Promise<SessionMetadata> {
  repository.replaceAll([conversation]);
  const snapshot = repository.getSync(conversation.id)!;
  await repository.persistConversations([snapshot]);
  expect(repository.getSync(conversation.id)).toEqual(snapshot);
  const metadata = await store.metadataReader.loadMetadata(conversation.id);
  expect(metadata).not.toBeNull();
  return metadata!;
}

  describe('public metadata persistence - rewind', () => {
    it('includes resumeAtMessageId when set', async () => {
      const conversation: Conversation = {
        id: 'conv-rewind',
        providerId: 'codex',
        title: 'Rewind Test',
        createdAt: testDate().getTime(),
        lastActivityAt: testDate({ milliseconds: 1000 }).getTime(),
        sessionId: 'sdk-session',
        messages: [],
        resumeAtMessageId: 'assistant-uuid-123',
      };

      const metadata = (await persistMetadata(conversation));

      expect(metadata.resumeAtMessageId).toBe('assistant-uuid-123');
    });

    it('omits resumeAtMessageId when not set', async () => {
      const conversation: Conversation = {
        id: 'conv-no-rewind',
        providerId: 'codex',
        title: 'No Rewind',
        createdAt: testDate().getTime(),
        lastActivityAt: testDate({ milliseconds: 1000 }).getTime(),
        sessionId: null,
        messages: [],
      };

      const metadata = (await persistMetadata(conversation));

      expect(metadata.resumeAtMessageId).toBeUndefined();
    });
  });

  describe('public metadata persistence - projections', () => {
    it('does not fall back to unsanitized state when the provider rejects it', async () => {
      const service = ProviderRegistry.getConversationHistoryService('codex');
      const sanitizer = vi.spyOn(service, 'buildPersistedProviderState').mockReturnValue(undefined);
      const conversation: Conversation = {
        id: 'conv-rejected-provider-state',
        providerId: 'codex',
        title: 'Rejected state',
        createdAt: testDate().getTime(),
        lastActivityAt: testDate().getTime(),
        sessionId: null,
        messages: [],
        providerState: { untrustedPath: '/outside/root/session.jsonl' },
      };

      expect((await persistMetadata(conversation)).providerState).toBeUndefined();
      sanitizer.mockRestore();
    });

    it('converts Conversation to SessionMetadata', async () => {
      const usage: UsageInfo = {
        model: 'claude-opus-4-5',
        inputTokens: 5000,
        cacheCreationInputTokens: 1000,
        cacheReadInputTokens: 500,
        contextWindow: 200000,
        contextTokens: 6500,
        percentage: 3,
      };

      const conversation: Conversation = {
        id: 'conv-convert',
        providerId: 'codex',
        title: 'Convert Test',
        createdAt: testDate().getTime(),
        lastActivityAt: testDate({ milliseconds: 900 }).getTime(),
        sessionId: 'sdk-session',
        providerState: { providerSessionId: 'current-sdk-session' },
        messages: [
          { id: 'msg-1', role: 'user', content: 'Hello', timestamp: testDate({ milliseconds: 100 }).getTime() },
        ],
        linkedContentPath: 'notes/test.md',
        usage,
        titleGenerationStatus: 'success',
      };

      const metadata = (await persistMetadata(conversation));

      expect(metadata.id).toBe('conv-convert');
      expect(metadata.title).toBe('Convert Test');
      expect(metadata.createdAt).toBe(testDate().getTime());
      expect(metadata.lastActivityAt).toBe(testDate({ milliseconds: 900 }).getTime());
      expect(metadata.sessionId).toBe('sdk-session');
      expect((metadata.providerState)?.providerSessionId).toBe('current-sdk-session');
      expect(metadata.linkedContentPath).toBe('notes/test.md');
      expect(metadata.usage).toEqual(usage);
      expect(metadata.titleGenerationStatus).toBe('success');

      // Should not include messages
      expect(metadata).not.toHaveProperty('messages');
    });

    it('includes forkSource when set', async () => {
      const conversation: Conversation = {
        id: 'conv-fork',
        providerId: 'codex',
        title: 'Fork Test',
        createdAt: testDate().getTime(),
        lastActivityAt: testDate({ milliseconds: 1000 }).getTime(),
        sessionId: null,
        messages: [],
        providerState: { forkSource: { sessionId: 'source-session-abc', resumeAt: 'asst-uuid-xyz' } },
      };

      const metadata = (await persistMetadata(conversation));

      expect((metadata.providerState)?.forkSource).toEqual({
        sessionId: 'source-session-abc',
        resumeAt: 'asst-uuid-xyz',
      });
    });

    it('omits forkSource when not set', async () => {
      const conversation: Conversation = {
        id: 'conv-no-fork',
        providerId: 'codex',
        title: 'No Fork',
        createdAt: testDate().getTime(),
        lastActivityAt: testDate({ milliseconds: 1000 }).getTime(),
        sessionId: 'sdk-session',
        messages: [],
      };

      const metadata = (await persistMetadata(conversation));

      expect((metadata.providerState)?.forkSource).toBeUndefined();
    });
  });
