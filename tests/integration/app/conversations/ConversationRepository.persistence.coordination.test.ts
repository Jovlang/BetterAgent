import '@test/helpers/registeredCodex';

import type { MockedFunction } from 'vitest';

import { ConversationRepository } from '@/app/conversations/ConversationRepository';
import type { ConversationPersistence } from '@/app/storage/ConversationPersistenceStore';
import type { SessionMetadataReader } from '@/app/storage/SessionStorage';
import type { ProviderSessionSnapshot } from '@/core/execution';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import type { ChatMessage, Conversation } from '@/core/types';

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

interface MockPersistence extends ConversationPersistence {
  saveMetadata: MockedFunction<ConversationPersistence['saveMetadata']>;
  deleteCurrentMetadata: MockedFunction<ConversationPersistence['deleteCurrentMetadata']>;
  assignMetadataToDevice: MockedFunction<ConversationPersistence['assignMetadataToDevice']>;
}

function createPersistence(): MockPersistence {
  const metadataReader: SessionMetadataReader = {
    revalidate: vi.fn().mockResolvedValue([]),
    load: vi.fn(),
    scan: vi.fn(),
    loadMetadata: vi.fn(),
    scanMetadata: vi.fn(),
    listMetadata: vi.fn(),
  };
  return {
    metadataReader,
    saveMetadata: vi.fn().mockResolvedValue(undefined),
    deleteCurrentMetadata: vi.fn().mockResolvedValue(undefined),
    assignMetadataToDevice: vi.fn().mockResolvedValue(undefined),
  };
}

function createRepository(
  conversation = createConversation(),
  persistence = createPersistence(),
) {
  const onConversationDeleted = vi.fn().mockResolvedValue(undefined);
  const repository = new ConversationRepository({
    providers: ProviderRegistry,
    providerSettings: ProviderSettingsCoordinator,
    getSettings: () => ({}),
    getVaultPath: () => '/vault',
    persistence,
    onConversationDeleted,
  });
  repository.replaceAll([conversation]);
  return { repository, persistence, onConversationDeleted };
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('ConversationRepository persistence queue and binding fences', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('persists only the latest eligible snapshot revision at queued commit time', async () => {
    const conversation = {
      ...createConversation(),
      providerState: { retainedFutureField: 'preserve-me' },
    };
    const persistence = createPersistence();
    const barrier = deferred<void>();
    persistence.saveMetadata.mockImplementationOnce(async () => {
      await barrier.promise;
    });
    const { repository } = createRepository(conversation, persistence);
    repository.registerExecutionBinding(conversation.id, 'binding-1', 4);
    const revision1: ProviderSessionSnapshot = {
      providerId: 'codex',
      revision: 1,
      providerSessionId: 'native-1',
      providerState: { cursor: 1 },
      status: 'executing',
    };
    const revision2: ProviderSessionSnapshot = {
      providerId: 'codex',
      revision: 2,
      providerSessionId: 'native-2',
      providerState: { cursor: 2 },
      status: 'idle',
    };

    const blockingSave = repository.rename(conversation.id, 'Queued title');
    const first = repository.persistExecutionSnapshot(
      conversation.id,
      'binding-1',
      4,
      revision1,
    );
    const second = repository.persistExecutionSnapshot(
      conversation.id,
      'binding-1',
      4,
      revision2,
    );
    await Promise.resolve();
    barrier.resolve();

    await Promise.all([blockingSave, first, second]);

    const snapshots = persistence.saveMetadata.mock.calls
      .map(([metadata]) => metadata)
      .filter(({ sessionId }) => sessionId === 'native-2');
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].providerState).toEqual({
      retainedFutureField: 'preserve-me',
      cursor: 2,
    });
    await expect(repository.persistExecutionSnapshot(
      conversation.id,
      'binding-1',
      4,
      {
        ...revision1,
        providerStateDeletes: ['retainedFutureField'],
      },
    )).resolves.toBe(false);
    expect(repository.getSync(conversation.id)!.providerState).toEqual({
      retainedFutureField: 'preserve-me',
      cursor: 2,
    });
  });

  it('copies saved history once while isolating queued, persisted, and committed state', async () => {
    const conversation = createConversation();
    const persistence = createPersistence();
    const barrier = deferred<void>();
    persistence.saveMetadata.mockImplementationOnce(async () => {
      await barrier.promise;
    });
    const { repository } = createRepository(conversation, persistence);
    const messages: ChatMessage[] = [
      { id: 'user', role: 'user', content: 'Delegate', timestamp: 1 },
      {
        id: 'assistant', role: 'assistant', content: '', timestamp: 2,
        toolCalls: [{
          id: 'agent', name: 'Agent', input: { description: 'Helper' }, status: 'completed',
          subagent: {
            id: 'agent', description: 'Helper', status: 'completed', result: 'Done',
            isExpanded: false, toolCalls: [],
          },
        }],
      },
    ];
    const blockingSave = repository.rename(conversation.id, 'Queued title');
    const clone = vi.spyOn(globalThis, 'structuredClone');
    const saving = repository.update(conversation.id, { messages });
    // The caller keeps mutating live chat state while the save waits in the queue.
    messages[1].toolCalls![0].subagent!.result = 'Changed while queued';
    messages.push({ id: 'late', role: 'user', content: 'Late', timestamp: 3 });
    barrier.resolve();
    await Promise.all([blockingSave, saving]);
    const historyCopies = clone.mock.calls.filter(([value]) => (
      (value as { messages?: unknown[] } | null)?.messages?.length
    ));
    clone.mockRestore();

    expect(historyCopies).toHaveLength(1);
    messages[1].toolCalls![0].subagent!.result = 'Changed after commit';
    const committed = repository.getSync(conversation.id)!;
    expect(committed.messages.map(message => message.id)).toEqual(['user', 'assistant']);
    expect(committed.messages[1].toolCalls![0].subagent!.result).toBe('Done');

    // A later save replaces committed history without reaching the earlier persisted projection.
    await repository.update(conversation.id, { messages: [committed.messages[0]] });
    expect(persistence.saveMetadata.mock.calls.at(-1)![0].providerState).toBeUndefined();
  });

  it('rejects the wrong binding or generation and lets a released binding drain', async () => {
    const conversation = {
      ...createConversation(),
      providerState: { retainedFutureField: 'preserve-me' },
    };
    const persistence = createPersistence();
    const { repository } = createRepository(conversation, persistence);
    repository.registerExecutionBinding(conversation.id, 'binding-1', 3);
    const snapshot: ProviderSessionSnapshot = {
      providerId: 'codex',
      revision: 1,
      providerSessionId: 'native-1',
      status: 'idle',
    };
    const staleStateSnapshot: ProviderSessionSnapshot = {
      ...snapshot,
      providerStateDeletes: ['retainedFutureField'],
    };

    await expect(repository.persistExecutionSnapshot(
      conversation.id,
      'other-binding',
      3,
      staleStateSnapshot,
    )).resolves.toBe(false);
    await expect(repository.persistExecutionSnapshot(
      conversation.id,
      'binding-1',
      2,
      staleStateSnapshot,
    )).resolves.toBe(false);

    const accepted = repository.persistExecutionSnapshot(
      conversation.id,
      'binding-1',
      3,
      snapshot,
    );
    repository.releaseExecutionBinding(conversation.id, 'binding-1');
    await expect(accepted).resolves.toBe(true);
    await expect(repository.persistExecutionSnapshot(
      conversation.id,
      'binding-1',
      3,
      {
        ...snapshot,
        revision: 2,
        providerStateDeletes: ['retainedFutureField'],
      },
    )).resolves.toBe(false);
    expect(persistence.saveMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'native-1',
        providerState: { retainedFutureField: 'preserve-me' },
      }),
    );
  });

});

describe('ConversationRepository deletion persistence', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('restores the exact live binding and replays the newest snapshot after removal failure', async () => {
    const conversation = createConversation();
    const persistence = createPersistence();
    const removal = deferred<void>();
    persistence.deleteCurrentMetadata.mockReturnValue(removal.promise);
    const { repository } = createRepository(conversation, persistence);
    repository.registerExecutionBinding(conversation.id, 'binding-1', 4);

    const deletion = repository.delete(conversation.id);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(persistence.deleteCurrentMetadata).toHaveBeenCalledTimes(1);

    await expect(repository.persistExecutionSnapshot(
      conversation.id,
      'binding-1',
      4,
      {
        providerId: 'codex',
        revision: 1,
        providerSessionId: 'superseded-during-delete',
        status: 'executing',
      },
    )).resolves.toBe(false);
    await expect(repository.persistExecutionSnapshot(
      conversation.id,
      'binding-1',
      4,
      {
        providerId: 'codex',
        revision: 2,
        providerSessionId: 'native-during-delete',
        providerState: { cursor: 2 },
        status: 'idle',
      },
    )).resolves.toBe(false);
    await expect(repository.persistExecutionSnapshot(
      conversation.id,
      'binding-1',
      5,
      {
        providerId: 'codex',
        revision: 3,
        providerSessionId: 'wrong-generation-during-delete',
        status: 'idle',
      },
    )).resolves.toBe(false);
    removal.reject(new Error('removal failed'));

    await expect(deletion).rejects.toThrow('removal failed');
    expect(repository.getCachedConversation(conversation.id)).toMatchObject({ id: conversation.id });
    expect(persistence.saveMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'native-during-delete',
        providerState: { cursor: 2 },
      }),
    );
    await expect(repository.persistExecutionSnapshot(
      conversation.id,
      'binding-1',
      4,
      {
        providerId: 'codex',
        revision: 3,
        providerSessionId: 'native-after-rollback',
        status: 'idle',
      },
    )).resolves.toBe(true);
    await expect(repository.persistExecutionSnapshot(
      conversation.id,
      'binding-1',
      5,
      {
        providerId: 'codex',
        revision: 4,
        providerSessionId: 'wrong-generation',
        status: 'idle',
      },
    )).resolves.toBe(false);
  });

  it('fences a late snapshot and queued save so deletion cannot recreate metadata', async () => {
    const conversation = createConversation();
    const persistence = createPersistence();
    const barrier = deferred<void>();
    persistence.saveMetadata.mockImplementationOnce(async () => {
      await barrier.promise;
    });
    const { repository } = createRepository(conversation, persistence);
    repository.registerExecutionBinding(conversation.id, 'binding', 1);
    const firstSave = repository.rename(conversation.id, 'In flight');
    const snapshot = repository.persistExecutionSnapshot(
      conversation.id,
      'binding',
      1,
      {
        providerId: 'codex',
        revision: 1,
        providerSessionId: 'late-native',
        status: 'idle',
      },
    );
    const deletion = repository.delete(conversation.id);
    barrier.resolve();

    await Promise.all([firstSave, snapshot, deletion]);

    const removalCall = persistence.deleteCurrentMetadata.mock.invocationCallOrder[0];
    const laterMetadataWrite = persistence.saveMetadata.mock.invocationCallOrder
      .find((order) => order > removalCall);
    expect(laterMetadataWrite).toBeUndefined();
  });
});
