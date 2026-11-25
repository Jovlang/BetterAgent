/** @vitest-environment jsdom */
import '@/providers';

import { claudeCatalogFixture } from '@test/helpers/claudeModels';
import { DEFAULT_CLAUDIAN_SETTINGS } from '@test/helpers/defaultSettings';
import { approvalDecisionOptions } from '@test/helpers/features/chat/approvalDecisionOptions';
import { createChatFeatureHost } from '@test/helpers/features/chat/ChatFeatureHostFixture';
import { createSessionRuntimePool } from '@test/helpers/features/chat/SessionRuntimePoolHarness';
import { FakeSideBackend } from '@test/helpers/features/chat/SideChatSessionHarness';
import { testDate } from '@test/helpers/testClock';
import { waitFor } from '@testing-library/dom';
import { App } from 'obsidian';

import { ConversationRepository } from '@/app/conversations/ConversationRepository';
import type { ConversationPersistence } from '@/app/storage/ConversationPersistenceStore';
import { type ProviderExecutionRequest } from '@/core/execution';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type { ClaudianSettings, Conversation, ConversationMutablePatch } from '@/core/types';
import { createClaudianAPI } from '@/features/chat/session-messaging/ClaudianAPI';
import { SessionMessagingService } from '@/features/chat/session-messaging/SessionMessagingService';
import type { SessionSignal } from '@/features/chat/sessions/ChatSessionRuntime';

interface SignalEntry { readonly sessionId: string; readonly signal: SessionSignal }
const isProgress = (entry: SignalEntry) => entry.signal.type === 'progress';
const isInteraction = (interactionId: string, pending: boolean) => (entry: SignalEntry) =>
  entry.signal.type === 'interaction' && entry.signal.interactionId === interactionId && entry.signal.pending === pending;

async function setup(options: {  members?: Record<string, string> } = {}) {
  const app = new App();
  Object.assign(app.vault.adapter, { basePath: '/vault' });
  const backend = new FakeSideBackend();
  vi.spyOn(ProviderRegistry, 'createExecutionBackend').mockReturnValue(backend);
  ProviderWorkspaceRegistry.setServices('claude', {});
  // Sonnet has effort control; Haiku has none.
  const catalog = claudeCatalogFixture(['claude-sonnet-4-5', 'claude-haiku-4-5'], ['low', 'high']);
  delete (catalog.discoveredModels[1] as { supportedEffortLevels?: string[] }).supportedEffortLevels;
  let settings: ClaudianSettings = Object.assign(structuredClone(DEFAULT_CLAUDIAN_SETTINGS), {
    model: 'claude-sonnet-4-5', permissionMode: 'normal', effortLevel: 'high', excludedTags: [],
    lastSelectedChatModel: { providerId: 'claude', model: 'claude-sonnet-4-5' },
    providerConfigs: { claude: catalog },
  });
  const record = (id: string, activityOffset = 0): Conversation => ({
    id, sessionId: null, providerId: 'claude', selectedModel: settings.model, title: id === 'sender' ? 'Research' : id,
    messages: [], createdAt: testDate().getTime(), lastActivityAt: testDate({ minutes: activityOffset }).getTime(),
  } as Conversation);
  // The recipient is the most recently active session; the caller is older.
  const records = new Map([['sender', -1], ['recipient', 0], ['archived', 1]].map(([id, offset]) => [id, record(id as string, offset as number)]));
  records.get('archived')!.isArchived = true;
  for (const [id, projectId] of Object.entries(options.members ?? {})) {
    records.set(id, { ...(records.get(id) ?? record(id, -2)), projectId });
  }
  const repository = new ConversationRepository({
    providers: ProviderRegistry, providerSettings: ProviderSettingsCoordinator,
    getSettings: () => settings, getVaultPath: () => '/vault', onConversationDeleted: async () => undefined,
    persistence: {
      metadataReader: { revalidate: vi.fn(), load: vi.fn(), scan: vi.fn(), loadMetadata: vi.fn(), scanMetadata: vi.fn(), listMetadata: vi.fn() },
      saveMetadata: async () => undefined, deleteCurrentMetadata: async () => undefined, assignMetadataToDevice: async () => undefined,
    } as ConversationPersistence,
  });
  repository.replaceAll([...records.values()]);
  const saves: ConversationMutablePatch[] = [];
  const settled: string[] = [];
  const signals: SignalEntry[] = [];
  const signalWaiters = new Set<{ matches: (entry: SignalEntry) => boolean; resolve: (entry: SignalEntry) => void }>();
  /** Arm before the step that should signal; resolves with the first matching signal. */
  const nextSignal = (matches: (entry: SignalEntry) => boolean) => new Promise<SignalEntry>(resolve => {
    signalWaiters.add({ matches, resolve });
  });
  const pool = createSessionRuntimePool(() => host, {
    onSessionSettled: id => settled.push(id),
    onSessionSignal: (sessionId, signal) => {
      const entry = { sessionId, signal: structuredClone(signal) };
      signals.push(entry);
      for (const waiter of [...signalWaiters]) {
        if (!waiter.matches(entry)) continue;
        signalWaiters.delete(waiter);
        waiter.resolve(entry);
      }
    },
  });
  const views = { openSession: vi.fn(async (_id: string, _options: { focus: boolean }) => undefined) };
  const service = new SessionMessagingService({ getHost: () => host, getActiveConversationId: () => 'sender' });
  onTestFinished(() => service.dispose());
  const host = await createChatFeatureHost({
    sessionRuntimes: pool,
    app, settings,

    getConversationSummary: (id: string) => repository.getSync(id),
    getConversationSync: (id: string) => repository.getSync(id),
    getCachedConversation: (id: string) => repository.getSync(id),
    getConversationById: async (id: string) => repository.getSync(id),
    getConversationList: () => repository.list(),
    ensureConversationMetadataLoaded: async () => { repository.mergeMetadataConversations([...records.values()]); },
    renameConversation: async () => undefined,
    updateConversation: async (id: string, patch: ConversationMutablePatch) => {
      saves.push(structuredClone(patch));
      await repository.update(id, patch);
    },
    createConversation: vi.fn(async () => { const created = record('created'); records.set(created.id, created); return created; }),
    executionPersistence: {
      registerExecutionBinding() {}, releaseExecutionBinding() {},
      assertConversationExecutionAuthority: async () => undefined,
      persistExecutionSnapshot: async () => true, recordConversationActivity: async () => undefined,
    },
  });
  settings = host.settings;
  return { host, pool, service, records, repository, backend, saves, record, settled, signals, nextSignal, views };
}
const requestText = (request: ProviderExecutionRequest) => request.input.filter(block => block.type === 'text').map(block => block.text).join('');
afterEach(() => { ProviderWorkspaceRegistry.clear(); vi.restoreAllMocks(); });


describe('outside-client API', () => {
  it.each([
    { label: 'tool only', finalText: undefined, isError: false, interrupted: false, trailingNotification: false, expected: '(no reply)' },
    { label: 'blank text after work', finalText: ' \n', isError: false, interrupted: false, trailingNotification: false, expected: '(no reply)' },
    { label: 'failed tool', finalText: undefined, isError: true, interrupted: false, trailingNotification: false, expected: '(error)' },
    { label: 'stopped after work', finalText: undefined, isError: false, interrupted: true, trailingNotification: false, expected: '(interrupted)' },
    { label: 'final text after work', finalText: 'The note is up to date.', isError: false, interrupted: false, trailingNotification: false, expected: 'The note is up to date.' },
    { label: 'notification after final text', finalText: 'The note is up to date.', isError: false, interrupted: false, trailingNotification: true, expected: 'The note is up to date.' },
  ])('reads the final answer after notification-split work: $label', async ({ finalText, isError, interrupted, trailingNotification, expected }) => {
    const h = (await setup());
    const api = createClaudianAPI(h.service, h.views);
    await api.send('recipient', { text: 'Inspect the note' });
    await waitFor(() => expect(h.backend.sessions[0]?.requests).toHaveLength(1));
    const native = h.backend.latest;
    const model = h.pool.get('recipient')!.peekModel!;
    native.emitText('I will inspect the note.');
    await waitFor(() => expect(model.state.currentTextContent).toContain('I will inspect the note.'));
    native.emitSessionEvent({ type: 'task_notification', content: 'An earlier task finished.' });
    native.emitOutput({ type: 'tool_started', toolCallId: 'inspect', toolScope: { kind: 'main' }, name: 'Read', input: { file_path: 'note.md' } });
    native.emitOutput({ type: 'tool_completed', toolCallId: 'inspect', toolScope: { kind: 'main' }, content: 'Current note content.', isError });
    if (finalText) native.emitText(finalText);
    await waitFor(() => expect(model.state.currentTextContent).toBe(finalText ?? ''));
    if (trailingNotification) {
      native.emitSessionEvent({ type: 'task_notification', content: 'Another earlier task finished.' });
    }
    if (interrupted) native.cancel();
    else native.complete();
    await h.pool.get('recipient')!.turns.drain();

    expect(model.state.messages.some(message => message.responseContinuationOf !== undefined)).toBe(true);
    expect(await api.read('recipient')).toBe(expected);
  });

  it('delivers client text as the user\'s own prompt, reports the active session, and reads the finished reply', async () => {
    const h = (await setup());
    const api = createClaudianAPI(h.service, h.views);
    expect(api.version).toBe(1);
    expect(api.getActiveSessionId()).toBe('sender');
    expect(await api.send('recipient', { text: 'What is next?' })).toBe('started');
    await waitFor(() => expect(h.backend.sessions[0]?.requests).toHaveLength(1));
    // No session envelope: the provider receives exactly what the user said.
    expect(requestText(h.backend.latest.requests[0])).toBe('What is next?');
    h.backend.latest.emitText('Ship the release.');
    h.backend.latest.complete();
    await h.pool.get('recipient')!.turns.drain();
    await waitFor(() => expect(h.settled).toEqual(['recipient']));
    expect(await api.read('recipient')).toBe('Ship the release.');
    // Persisted as an ordinary user prompt, so history shows no session sender.
    const prompt = await waitFor(() => {
      const saved = h.saves.flatMap(patch => patch.messages ?? []).find(message => message.role === 'user');
      expect(saved).toBeDefined();
      return saved!;
    });
    expect(prompt).toMatchObject({ content: 'What is next?', displayContent: 'What is next?' });
    expect(prompt.sessionMessage).toBeUndefined();
  });

  it('reads no reply from a first turn that is still running after a steer', async () => {
    const h = (await setup());
    const api = createClaudianAPI(h.service, h.views);
    await api.send('recipient', { text: 'Inspect the note' });
    await waitFor(() => expect(h.backend.sessions[0]?.requests).toHaveLength(1));
    const native = h.backend.latest;
    const steers: ProviderExecutionRequest[] = [];
    Object.assign(native, { steer: async (request: ProviderExecutionRequest) => { steers.push(request); return true; } });
    native.emitText('I am still inspecting.');
    expect(await api.send('recipient', { text: 'Also check the links', mode: 'steer' })).toBe('steered');
    native.emitOutput({ type: 'user_message_started', content: requestText(native.requests[0]), nativeUserMessageId: 'native-start' });
    native.emitOutput({ type: 'user_message_started', content: requestText(steers[0]), nativeUserMessageId: 'native-steer' });
    const model = h.pool.get('recipient')!.peekModel!;
    await waitFor(() => expect(model.state.messages.some(message => message.userMessageId === 'native-steer')).toBe(true));
    expect(await api.read('recipient')).toBe('');
    native.emitText('Both look fine.');
    native.complete();
    await h.pool.get('recipient')!.turns.drain();
    expect(await api.read('recipient')).toBe('Both look fine.');
  });

  it('stops a running session through send without text, and requires text otherwise', async () => {
    const h = (await setup());
    const api = createClaudianAPI(h.service, h.views);
    await expect(api.send('recipient', {})).rejects.toThrow('"text" is required unless mode is "interrupt"');
    await expect(api.send('recipient', { mode: 'steer' })).rejects.toThrow('"text" is required unless mode is "interrupt"');
    await api.send('recipient', { text: 'Long task' });
    await waitFor(() => expect(h.backend.sessions[0]?.requests).toHaveLength(1));
    expect(h.settled).toEqual([]);
    expect(await api.send('recipient', { mode: 'interrupt' })).toBe('interrupted');
    expect(h.backend.latest.cancelCalls).toBe(1);
    await h.pool.get('recipient')!.turns.drain();
    await waitFor(() => expect(h.settled).toEqual(['recipient']));
    expect(await api.send('recipient', { mode: 'interrupt' })).toBe('idle');
  });
  /** Sends through the API and returns once the provider has the request. */
  async function startTurn(h: Awaited<ReturnType<typeof setup>>, text = 'Start') {
    const api = createClaudianAPI(h.service, h.views);
    const handoff = h.backend.nextRequest(() => true);
    await api.send('recipient', { text });
    await handoff;
    const native = h.backend.latest;
    return { api, native, port: native.config.interactionPort };
  }

  it('lists sessions like the list tool, with live status and no caller row', async () => {
    const h = await setup();
    const api = createClaudianAPI(h.service, h.views);
    expect(await api.listSessions()).toEqual({ sessions: [
      { sessionId: 'recipient', title: 'recipient', provider: 'claude', status: 'idle', active: false },
      { sessionId: 'sender', title: 'Research', provider: 'claude', status: 'idle', active: true },
    ] });
    expect(await api.listSessions({ limit: 1 })).toEqual({ sessions: [
      { sessionId: 'recipient', title: 'recipient', provider: 'claude', status: 'idle', active: false },
    ], truncated: true });
    await expect(api.listSessions({ limit: 0 })).rejects.toThrow('"limit" must be an integer from 1 to 200.');
    const { native } = await startTurn(h);
    expect((await api.listSessions()).sessions[0]).toMatchObject({ sessionId: 'recipient', status: 'running' });
    const requested = h.nextSignal(isInteraction('q', true));
    const question = native.config.interactionPort.askUserQuestion({
      interactionId: 'q', sessionInstanceId: native.sessionInstanceId, turnId: native.activeTurnId, kind: 'question',
      input: { questions: [{ question: 'Proceed?', options: [{ label: 'Yes', description: '' }] }] },
    }, new AbortController().signal);
    question.catch(() => undefined);
    await requested;
    expect((await api.listSessions()).sessions[0]).toMatchObject({ sessionId: 'recipient', status: 'awaiting-user' });
    native.config.interactionPort.dismissInteraction('q', 'native-rejected');
    await expect(question).rejects.toThrow('Provider interaction is stale');
    native.complete();
    await h.pool.get('recipient')!.turns.drain();
  });

  it('signals every streamed block as it is received, before the turn ends', async () => {
    const h = await setup();
    const { api, native } = await startTurn(h, 'Inspect the note');
    // Each step is observed while the turn still runs, so buffering until completion would fail.
    const step = async (emit: () => void) => {
      const next = h.nextSignal(isProgress);
      emit();
      const entry = await next;
      expect(entry.sessionId).toBe('recipient');
      return (entry.signal as Extract<SessionSignal, { type: 'progress' }>).progress;
    };
    const thinking = await step(() => native.emitOutput({ type: 'thinking_delta', text: 'Plan' }));
    const { messageId } = thinking;
    expect(thinking).toEqual({ kind: 'thinking', messageId, blockIndex: 0, text: 'Plan' });
    expect(await step(() => native.emitText('I will '))).toEqual({ kind: 'text', messageId, blockIndex: 1, text: 'I will ' });
    expect(await step(() => native.emitText('look.'))).toEqual({ kind: 'text', messageId, blockIndex: 1, text: 'I will look.' });
    expect(await step(() => native.emitOutput({ type: 'tool_started', toolCallId: 'inspect', toolScope: { kind: 'main' }, name: 'Read', input: { file_path: 'note.md' } })))
      .toEqual({ kind: 'tool', messageId, toolId: 'inspect', toolName: 'Read', status: 'running' });
    expect(await step(() => native.emitOutput({ type: 'tool_completed', toolCallId: 'inspect', toolScope: { kind: 'main' }, content: 'Content.', isError: false })))
      .toEqual({ kind: 'tool', messageId, toolId: 'inspect', toolName: 'Read', status: 'completed' });
    expect(await step(() => native.emitText('Done.'))).toEqual({ kind: 'text', messageId, blockIndex: 3, text: 'Done.' });
    // Notices join the open text block exactly as the transcript shows them.
    expect(await step(() => native.emitOutput({ type: 'notice', message: 'Rate limited', level: 'warning' })))
      .toEqual({ kind: 'text', messageId, blockIndex: 3, text: 'Done.\n\n⚠️ **Warning:** Rate limited' });
    expect(h.pool.get('recipient')!.isWorking).toBe(true);
    native.complete();
    await h.pool.get('recipient')!.turns.drain();
    expect(await api.read('recipient')).toBe('Done.\n\n⚠️ **Warning:** Rate limited');
  });

  it('signals a notice after thinking as a new text block, and a terminal execution error as text', async () => {
    const h = await setup();
    const { native } = await startTurn(h, 'Inspect the note');
    const step = async (emit: () => void) => {
      const next = h.nextSignal(isProgress);
      emit();
      const progress = ((await next).signal as Extract<SessionSignal, { type: 'progress' }>).progress;
      return { kind: progress.kind, ...('blockIndex' in progress ? { blockIndex: progress.blockIndex, text: progress.text } : {}) };
    };
    expect(await step(() => native.emitOutput({ type: 'thinking_delta', text: 'Plan' }))).toEqual({ kind: 'thinking', blockIndex: 0, text: 'Plan' });
    expect(await step(() => native.emitOutput({ type: 'notice', message: 'Slow', level: 'info' })))
      .toEqual({ kind: 'text', blockIndex: 1, text: '\n\n⚠️ **Notice:** Slow' });
    expect(await step(() => native.emitText('Answer'))).toEqual({ kind: 'text', blockIndex: 1, text: '\n\n⚠️ **Notice:** Slow\n\nAnswer' });
    expect(await step(() => native.emitOutput({ type: 'execution_error', category: 'provider', message: 'Overloaded', recoverable: false })))
      .toEqual({ kind: 'text', blockIndex: 1, text: '\n\n⚠️ **Notice:** Slow\n\nAnswer\n\n**Error:** Overloaded' });
    await h.pool.get('recipient')!.turns.drain();
  });

  it('opens no view for an archived session', async () => {
    const h = await setup();
    const api = createClaudianAPI(h.service, h.views);
    await expect(api.openSession('archived')).rejects.toThrow('The session does not exist or is archived');
    expect(h.views.openSession).not.toHaveBeenCalled();
  });

  const interactionSignals = (h: Awaited<ReturnType<typeof setup>>) => h.signals
    .filter(entry => entry.signal.type === 'interaction')
    .map(entry => ({ sessionId: entry.sessionId, ...(entry.signal as object) }));

  it('exposes every approval option with its decision and answers with the chosen one', async () => {
    const h = await setup();
    const { api, native, port } = await startTurn(h);
    const requested = h.nextSignal(isInteraction('approve', true));
    const approval = port.requestApproval({
      decisionOptions: approvalDecisionOptions(),
      interactionId: 'approve', sessionInstanceId: native.sessionInstanceId, turnId: native.activeTurnId, kind: 'approval',
      toolName: 'Bash', input: { command: 'ls' }, description: 'ls', blockedPath: '/outside',
    }, new AbortController().signal);
    approval.catch(() => undefined);
    await requested;
    const [pending] = api.getPendingInteractions('recipient');
    expect(pending).toMatchObject({
      interactionId: 'approve', kind: 'approval', toolName: 'Bash', description: 'ls', blockedPath: '/outside',
    });
    expect(pending.questions).toHaveLength(1);
    expect(pending.questions[0]).toMatchObject({ multiSelect: false, isOther: false, isSecret: false });
    expect(pending.questions[0].options.map(option => option.decision)).toEqual(['deny', 'allow', 'allow-always']);
    const always = pending.questions[0].options.find(option => option.decision === 'allow-always')!;
    const key = pending.questions[0].id ?? pending.questions[0].question;
    await expect(api.answerInteraction('recipient', 'approve', { [key]: 'Not an option' })).rejects.toThrow();
    expect(api.getPendingInteractions('recipient')).toHaveLength(1);
    await api.answerInteraction('recipient', 'approve', { [key]: always.value });
    expect(await approval).toEqual({ interactionId: 'approve', value: always.value });
    expect(api.getPendingInteractions('recipient')).toEqual([]);
    expect(interactionSignals(h)).toEqual([
      { sessionId: 'recipient', type: 'interaction', interactionId: 'approve', pending: true },
      { sessionId: 'recipient', type: 'interaction', interactionId: 'approve', pending: false },
    ]);
    await expect(api.answerInteraction('recipient', 'approve', { [key]: always.value })).rejects.toThrow();
    native.complete();
    await h.pool.get('recipient')!.turns.drain();
  });

  it('answers a question with an option or custom text only where the question accepts it', async () => {
    const h = await setup();
    const { api, native, port } = await startTurn(h);
    const requested = h.nextSignal(isInteraction('ask', true));
    const question = port.askUserQuestion({
      interactionId: 'ask', sessionInstanceId: native.sessionInstanceId, turnId: native.activeTurnId, kind: 'question',
      input: { questions: [
        { id: 'color', question: 'Which color?', header: 'Color', options: [{ label: 'Red', description: 'warm' }], isOther: true },
        { question: 'Which sizes?', options: [{ label: 'S', description: '' }, { label: 'M', description: '' }], multiSelect: true },
      ] },
    }, new AbortController().signal);
    question.catch(() => undefined);
    await requested;
    expect(api.getPendingInteractions('recipient')[0]).toEqual({
      interactionId: 'ask', kind: 'question', questions: [
        { id: 'color', header: 'Color', question: 'Which color?', multiSelect: false, isOther: true, isSecret: false,
          options: [{ label: 'Red', value: 'Red', description: 'warm' }] },
        { header: 'Q2', question: 'Which sizes?', multiSelect: true, isOther: false, isSecret: false,
          options: [{ label: 'S', value: 'S', description: '' }, { label: 'M', value: 'M', description: '' }] },
      ],
    });
    // Free text only where isOther allows it; every question needs an answer.
    await expect(api.answerInteraction('recipient', 'ask', { color: 'Red', 'Which sizes?': ['XL'] })).rejects.toThrow();
    await expect(api.answerInteraction('recipient', 'ask', { color: 'Red' })).rejects.toThrow();
    await api.answerInteraction('recipient', 'ask', { color: 'Teal', 'Which sizes?': ['S', 'M'] });
    expect(await question).toEqual({ interactionId: 'ask', answers: { color: 'Teal', 'Which sizes?': ['S', 'M'] } });
    native.complete();
    await h.pool.get('recipient')!.turns.drain();
  });

  it('answers an async question only once its reply is delivered as the next prompt', async () => {
    const h = await setup();
    const { api, native } = await startTurn(h);
    const requested = h.nextSignal(entry => entry.signal.type === 'interaction' && entry.signal.pending);
    native.emitOutput({ type: 'tool_started', toolCallId: 'ask-tool', toolScope: { kind: 'main' }, name: 'AskUserQuestion', input: {
      replyMode: 'user-message', questions: [{ question: 'Which file?', options: [{ label: 'a.md', description: '' }], isOther: true }],
    } });
    native.emitOutput({ type: 'tool_completed', toolCallId: 'ask-tool', toolScope: { kind: 'main' }, content: 'Waiting for the user.', isError: false });
    native.complete();
    await h.pool.get('recipient')!.turns.drain();
    await requested;
    const [pending] = api.getPendingInteractions('recipient');
    expect(pending).toMatchObject({ kind: 'question', questions: [{ question: 'Which file?', isOther: true }] });
    // Claude formats no async reply: delivery fails, the request stays pending and can be retried.
    await expect(api.answerInteraction('recipient', pending.interactionId, { 'Which file?': 'b.md' })).rejects.toThrow();
    expect(api.getPendingInteractions('recipient')).toHaveLength(1);
    expect(native.requests).toHaveLength(1);
    vi.spyOn(ProviderRegistry, 'formatQuestionReply').mockImplementation((_provider, _tool, answers) => ({
      content: `Answer: ${String(answers['Which file?'])}`, displayContent: '',
    }));
    let delivered = false;
    const answering = api.answerInteraction('recipient', pending.interactionId, { 'Which file?': 'b.md' }).then(() => { delivered = native.requests.length === 2; });
    // While the answer is being delivered, a second answer is refused.
    await expect(api.answerInteraction('recipient', pending.interactionId, { 'Which file?': 'a.md' })).rejects.toThrow('is not awaiting an answer');
    await answering;
    expect(delivered).toBe(true);
    expect(requestText(native.requests[1])).toContain('b.md');
    expect(api.getPendingInteractions('recipient')).toEqual([]);
    native.complete();
    await h.pool.get('recipient')!.turns.drain();
  });

  it('signals an interaction settled when it is answered elsewhere', async () => {
    const h = await setup();
    const { api, native, port } = await startTurn(h);
    const requested = h.nextSignal(isInteraction('ask', true));
    const question = port.askUserQuestion({
      interactionId: 'ask', sessionInstanceId: native.sessionInstanceId, turnId: native.activeTurnId, kind: 'question',
      input: { questions: [{ question: 'Proceed?', options: [{ label: 'Yes', description: '' }] }] },
    }, new AbortController().signal);
    question.catch(() => undefined);
    await requested;
    expect(api.getPendingInteractions('recipient')).toHaveLength(1);
    const settled = h.nextSignal(isInteraction('ask', false));
    port.dismissInteraction('ask', 'native-rejected');
    await settled;
    await expect(question).rejects.toThrow('Provider interaction is stale');
    expect(api.getPendingInteractions('recipient')).toEqual([]);
    expect(interactionSignals(h)).toEqual([
      { sessionId: 'recipient', type: 'interaction', interactionId: 'ask', pending: true },
      { sessionId: 'recipient', type: 'interaction', interactionId: 'ask', pending: false },
    ]);
    expect(api.getPendingInteractions('missing')).toEqual([]);
    native.complete();
    await h.pool.get('recipient')!.turns.drain();
  });
});
