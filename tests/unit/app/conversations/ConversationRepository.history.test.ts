import '@test/helpers/registeredCodex';

import type { Mocked } from 'vitest';

import { ConversationRepository } from '@/app/conversations/ConversationRepository';
import type { ConversationPersistence } from '@/app/storage/ConversationPersistenceStore';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import type { Conversation } from '@/core/types';







function createConversation(id = 'conversation-1'): Conversation {
  return {
    id,
    providerId: 'codex',
    title: 'Conversation',
    createdAt: 1,
    lastActivityAt: 1,
    sessionId: 'session-1',
    messages: [],
  };
}

function createRepository(conversation = createConversation()) {
  const persistence: Mocked<ConversationPersistence> = {
    metadataReader: {
      revalidate: vi.fn().mockResolvedValue([]),
      load: vi.fn().mockResolvedValue(null),
      scan: vi.fn().mockResolvedValue({
        records: [],
        complete: true,
        invalidMetadataCount: 0,
      }),
      loadMetadata: vi.fn().mockResolvedValue(null),
      scanMetadata: vi.fn().mockResolvedValue({
        metadata: [],
        complete: true,
        invalidMetadataCount: 0,
      }),
      listMetadata: vi.fn().mockResolvedValue([]),
    },
    saveMetadata: vi.fn().mockResolvedValue(undefined),
    deleteCurrentMetadata: vi.fn().mockResolvedValue(undefined),
    assignMetadataToDevice: vi.fn().mockResolvedValue(undefined),
  };
  const repository = new ConversationRepository({
    providers: ProviderRegistry,
    providerSettings: ProviderSettingsCoordinator,
    getSettings: () => ({}),
    getVaultPath: () => '/vault',
    persistence,
    onConversationDeleted: vi.fn().mockResolvedValue(undefined),
  });
  repository.replaceAll([conversation]);
  return { repository, persistence };
}

afterEach(() => vi.restoreAllMocks());


test('does not publish a relocated identity after concurrent deletion', async () => {
  const conversation = createConversation();
  const { repository, persistence } = createRepository(conversation);
  // Deletion waits for the in-flight hydration, so the read starts it without awaiting it.
  let deleting: Promise<void> | undefined;
  vi.spyOn(ProviderRegistry, 'getConversationHistoryService').mockReturnValue({
    hydrateConversationHistory: async () => ({}),
    readNativeHistoryRevision: async () => null,
    resolveSessionIdForConversation: value => value?.sessionId ?? null,
    isPendingForkConversation: () => false,
    buildForkProviderState: () => ({}),
    getConversationSessionAvailability: async () => 'relocated',
    prepareRelocatedConversationSession: async () => {
      deleting = repository.delete(conversation.id);
      return { sessionId: null, providerState: { previousProviderSessionIds: ['session-1'] } };
    },
  });
  expect(await repository.ensureHydrated(conversation.id)).toBeNull();
  await deleting;
  expect(deleting).toBeDefined();
  expect(repository.getCachedConversation(conversation.id)).toBeNull();
  expect(persistence.saveMetadata).not.toHaveBeenCalled();
  expect(persistence.deleteCurrentMetadata).toHaveBeenCalledWith(conversation.id);
});
