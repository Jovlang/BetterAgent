import '@test/helpers/registeredCodex';

import { DEFAULT_CLAUDIAN_SETTINGS } from '@test/helpers/defaultSettings';
import { FakeSideBackend, waitFor } from '@test/helpers/features/chat/SideChatSessionHarness';
import { testDate } from '@test/helpers/testClock';

import { ConversationRepository } from '@/app/conversations/ConversationRepository';
import { SessionMetadataLoader } from '@/app/conversations/SessionMetadataLoader';
import { ProviderExecutionLifecycleRegistry } from '@/core/execution';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import type { Conversation, SessionMetadata } from '@/core/types';
import { ChatExecutionCoordinator } from '@/features/chat/execution/ChatExecutionCoordinator';

function fixture() {
  const conversation: Conversation = {
    id: 'audit-conversation', providerId: 'codex', title: 'Original',
    sessionId: 'native-shared', createdAt: testDate().getTime(),
    lastActivityAt: testDate().getTime(), messages: [], isPinned: false,
  };
  const persistence = {
    metadataReader: {
      revalidate: vi.fn().mockResolvedValue([]),
      load: vi.fn().mockResolvedValue(null),
      scan: vi.fn().mockResolvedValue({ records: [], complete: true, invalidMetadataCount: 0 }),
      loadMetadata: vi.fn().mockResolvedValue(null),
      scanMetadata: vi.fn().mockResolvedValue({ metadata: [], complete: true, invalidMetadataCount: 0 }),
      listMetadata: vi.fn().mockResolvedValue([]),
    },
    saveMetadata: vi.fn().mockResolvedValue(undefined),
    deleteCurrentMetadata: vi.fn().mockResolvedValue(undefined),
    assignMetadataToDevice: vi.fn().mockResolvedValue(undefined),
  };
  const settings = structuredClone(DEFAULT_CLAUDIAN_SETTINGS);
  const repository = new ConversationRepository({
    providers: ProviderRegistry,
    providerSettings: ProviderSettingsCoordinator,
    getSettings: () => settings, getVaultPath: () => '/vault', persistence,
    onConversationDeleted: async () => undefined,
  });
  repository.replaceAll([conversation]);
  return { conversation, persistence, repository };
}

test('failed pin persistence preserves committed state and allows a real retry', async () => {
  const { repository, persistence, conversation } = fixture();
  persistence.saveMetadata.mockRejectedValueOnce(new Error('disk unavailable'));
  await expect(repository.setPlacement(conversation.id, { isPinned: true })).rejects.toThrow('disk unavailable');
  const publishedAfterFailure = repository.list()[0].isPinned;
  await repository.setPlacement(conversation.id, { isPinned: true });
  expect({ publishedAfterFailure, writes: persistence.saveMetadata.mock.calls.length })
    .toEqual({ publishedAfterFailure: false, writes: 2 });
});

test('two runtime owners cannot both hand off the same conversation to native execution', async () => {
  const { repository, conversation } = fixture();
  const lifecycleRegistry = new ProviderExecutionLifecycleRegistry();
  const backend = new FakeSideBackend();
  let serial = 0;
  const coordinators = [0, 1].map(() => new ChatExecutionCoordinator({
    lifecycleRegistry, resolveBackend: () => backend, persistence: repository,
    workingDirectory: '/vault', createId: () => `audit-binding-${++serial}`,
    interactionPort: {
      requestApproval: async () => { throw new Error('unexpected'); },
      askUserQuestion: async () => { throw new Error('unexpected'); },
      dismissInteraction: () => undefined,
    },
  }));
  try {
    for (const coordinator of coordinators) {
      await coordinator.bindConversation({ conversationId: conversation.id, providerId: 'codex', resumeSeed: { providerSessionId: conversation.sessionId! } });
    }
    const outcomes: unknown[] = [];
    const runs = coordinators.map((coordinator, index) => coordinator.execute({
      submissionId: `audit-${index}`, timestamp: testDate().getTime(),
      rawDisplayText: 'run', canonicalText: 'run', images: [],
      configuration: { systemInstructions: { kind: 'main-agent' as const, instructions: 'Main Agent prompt.' } },
      toolPolicy: { kind: 'provider-default' },
    }).then(result => { outcomes[index] = result; }, error => { outcomes[index] = error; }));
    await waitFor(() => backend.sessions.reduce((n, session) => n + session.requests.length, 0) + outcomes.filter(Boolean).length >= 2);
    const handedOff = backend.sessions.reduce((n, session) => n + session.requests.length, 0);
    for (const session of backend.sessions) session.complete();
    await Promise.all(runs);
    expect(handedOff).toBeLessThanOrEqual(1);
  } finally {
    await Promise.all(coordinators.map(coordinator => coordinator.dispose()));
    await lifecycleRegistry.dispose();
  }
});

test('a metadata scan paused during source resolution cannot publish writes after unload', async () => {
  const { repository, persistence, conversation } = fixture();
  repository.replaceAll([]);
  const metadata: SessionMetadata = { ...conversation, providerState: undefined };
  const record = { metadata, source: 'unscoped' as const, needsMigration: true };
  let resolveSource!: (value: (typeof record)[]) => void;
  let sourceStarted!: () => void;
  const readingSource = new Promise<void>(resolve => { sourceStarted = resolve; });
  persistence.metadataReader.revalidate.mockImplementation(() => new Promise(resolve => {
    resolveSource = resolve;
    sourceStarted();
  }));
  persistence.metadataReader.scan.mockResolvedValue({ records: [record], complete: true, invalidMetadataCount: 0 });
  let unloading = false;
  const loader = new SessionMetadataLoader({
    sessions: persistence.metadataReader, conversations: repository,
    isUnloading: () => unloading, whenLayoutReady: callback => callback(),
    onConversationListChanged: () => undefined,
  });
  loader.scheduleRemainingLoad();
  await readingSource;
  unloading = true;
  const disposal = loader.dispose();
  resolveSource([record]);
  await disposal;
  expect(persistence.saveMetadata).not.toHaveBeenCalled();
});

test('historical recovery cannot overwrite a model selection whose write is pending', async () => {
  const { repository, persistence, conversation } = fixture();
  let finishRecovery!: (model: string) => void;
  const recoveryResult = new Promise<string>(resolve => { finishRecovery = resolve; });
  const history = ProviderRegistry.getConversationHistoryService('codex');
  const recoverySpy = vi.spyOn(history, 'recoverConversationModelSelection').mockReturnValue(recoveryResult);
  let finishWrite!: () => void;
  persistence.saveMetadata.mockImplementationOnce(() => new Promise<void>(resolve => { finishWrite = resolve; }));
  try {
    const recovery = repository.recoverMissingSelectedModels();
    const update = repository.update(conversation.id, { selectedModel: 'gpt-5.5' });
    await waitFor(() => Boolean(finishWrite));
    finishRecovery('gpt-5.4-mini');
    // Let the native read finish while the explicit write is still pending.
    await recoveryResult;
    await Promise.resolve();
    finishWrite();
    await Promise.all([recovery, update]);
    expect(persistence.saveMetadata.mock.calls.map(([metadata]) => metadata.selectedModel)).toEqual(['gpt-5.5']);
    expect(repository.getSync(conversation.id)?.selectedModel).toBe('gpt-5.5');
  } finally {
    recoverySpy.mockRestore();
  }
});

test('failed deletion restores a binding committed while deletion was pending', async () => {
  const { repository, persistence, conversation } = fixture();
  const messages: Conversation['messages'] = [
    { id: 'replacement-message', role: 'assistant', content: 'Replacement', timestamp: testDate().getTime() },
  ];
  let finishWrite!: () => void;
  persistence.saveMetadata.mockImplementationOnce(() => new Promise<void>(resolve => { finishWrite = resolve; }));
  persistence.deleteCurrentMetadata.mockRejectedValueOnce(new Error('deletion failed'));
  const update = repository.update(conversation.id, { sessionId: 'replacement', messages });
  await waitFor(() => Boolean(finishWrite));
  const deletion = repository.delete(conversation.id);
  finishWrite();
  await expect(deletion).rejects.toThrow('deletion failed');
  await update;
  expect(repository.getCachedConversation(conversation.id)).toMatchObject({ sessionId: 'replacement', messages });
  expect(persistence.saveMetadata.mock.calls.at(-1)?.[0].sessionId).toBe('replacement');
});

test('linked-content rename during a session write reaches disk', async () => {
  const { repository, persistence, conversation } = fixture();
  const linked = { ...conversation, linkedContentPath: 'old.md' };
  repository.replaceAll([linked]);
  let finishWrite!: () => void;
  persistence.saveMetadata.mockImplementationOnce(() => new Promise<void>(resolve => { finishWrite = resolve; }));
  const update = repository.update(linked.id, { sessionId: 'replacement' });
  await waitFor(() => Boolean(finishWrite));
  const rename = repository.rewriteLinkedContentPaths('old.md', 'new.md');
  finishWrite();
  await Promise.all([update, rename]);
  expect(persistence.saveMetadata.mock.calls.at(-1)?.[0].linkedContentPath).toBe('new.md');
});

test('conversation reads and update inputs are detached from repository records', async () => {
  const { repository, conversation } = fixture();
  const messages = [{ id: 'message', role: 'assistant', content: 'original', timestamp: testDate().getTime() }] as Conversation['messages'];
  await repository.update(conversation.id, { messages });
  messages[0].content = 'caller edit';
  const snapshot = repository.getCachedConversation(conversation.id)!;
  expect(snapshot.messages[0].content).toBe('original');
  snapshot.messages[0].content = 'reader edit';
  repository.getAll().splice(0);
  expect(repository.getSync(conversation.id)?.messages[0].content).toBe('original');
});
