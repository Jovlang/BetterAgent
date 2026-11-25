/** @vitest-environment jsdom */
import '@/providers';

import { axe } from '@test/helpers/accessibility';
import { createFixture, deferred } from '@test/helpers/ChatInputHarness';
import { createTabSession } from '@test/helpers/ConversationPorts';
import { useTranscriptGeometry } from '@test/helpers/dom/transcriptGeometry';
import { createChatFeatureHost } from '@test/helpers/features/chat/ChatFeatureHostFixture';
import { createTabMessageId } from '@test/helpers/features/chat/SessionEventsHarness';
import { FakeSideBackend } from '@test/helpers/features/chat/SideChatSessionHarness';
import { testClock, testDate } from '@test/helpers/testClock';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { Component, MarkdownRenderer } from 'obsidian';

import { ProviderExecutionLifecycleRegistry, type ProviderExecutionRequest } from '@/core/execution';
import type { ChatMessage, ImageAttachment } from '@/core/types';
import { ChatExecutionCoordinator } from '@/features/chat/execution/ChatExecutionCoordinator';
import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import { SubagentManager } from '@/features/chat/rendering/subagents/SubagentManager';
import { SessionEvents } from '@/features/chat/sessions/SessionEvents';
import { ChatState } from '@/features/chat/state/ChatState';
import { BackgroundResponses } from '@/features/chat/turns/BackgroundResponses';
import { renderSessionTaskNotification } from '@/features/chat/turns/BackgroundTurnRenderer';
import { ResponseStream } from '@/features/chat/turns/ResponseStream';
import { StreamController } from '@/features/chat/turns/StreamController';
import { TurnCoordinator } from '@/features/chat/turns/TurnCoordinator';



vi.mock('node:fs/promises');

beforeEach(() => {
  document.body.replaceChildren();
  vi.mocked(MarkdownRenderer.render).mockImplementation(async (_app, markdown, el) => {
    (el as HTMLElement).createEl('p', { text: markdown });
  });
});

it.each(['attached', 'detached', 'absent', 'late-text', 'late-thinking'] as const)(
  'retains ordered text and thinking blocks with %s transcript content', async presentation => {
    const clock = testClock();
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock().getTime());
    const messagesEl = document.body.createDiv();
    const plugin = await createChatFeatureHost({ settings: { mediaFolder: '' } });
    const renderer = new MessageRenderer(plugin, new Component(), messagesEl);
    const state = new ChatState();
    const subagents = new SubagentManager(() => undefined);
    const stream = new StreamController({ plugin, state, renderer, subagentManager: subagents,
      getMessagesEl: () => messagesEl, updateQueueIndicator: () => undefined });
    const message: ChatMessage = {
      id: 'response', role: 'assistant', timestamp: clock().getTime(), content: '', contentBlocks: [], toolCalls: [],
    };
    state.addMessage(message);
    const mountContent = () => {
      state.currentContentEl = renderer.addMessage(message).querySelector('.claudian-message-content');
    };
    if (presentation === 'attached' || presentation === 'detached') mountContent();
    if (presentation === 'detached') messagesEl.remove();
    try {
      await stream.handleStreamChunk({ type: 'text', content: 'Before ' }, message);
      if (presentation === 'late-text') mountContent();
      await stream.handleStreamChunk({ type: 'text', content: 'thinking.' }, message);
      await stream.handleStreamChunk({ type: 'thinking', content: 'Consider ' }, message);
      clock.advance({ seconds: 2 });
      if (presentation === 'late-thinking') mountContent();
      await stream.handleStreamChunk({ type: 'thinking', content: 'the result.' }, message);
      clock.advance({ seconds: 1 });
      await stream.handleStreamChunk({ type: 'text', content: 'After thinking.' }, message);
      await stream.handleStreamChunk({ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'note.md' } }, message);
      await stream.handleStreamChunk({ type: 'tool_result', id: 'read', content: 'Note contents' }, message);
      await stream.handleStreamChunk({ type: 'notice', level: 'warning', content: 'Unavailable file' }, message);
      await stream.handleStreamChunk({ type: 'error', content: 'Unable to continue' }, message);
      await stream.handleStreamChunk({ type: 'done' }, message);
      await stream.finalizeCurrentThinkingBlock(message);
      await stream.finalizeCurrentTextBlock(message);

      expect(message.contentBlocks).toEqual([
        { type: 'text', content: 'Before thinking.' },
        { type: 'thinking', content: 'Consider the result.', durationSeconds: 3 },
        { type: 'text', content: 'After thinking.' },
        { type: 'tool_use', toolId: 'read' },
        { type: 'text', content: '\n\n⚠️ **Warning:** Unavailable file\n\n❌ **Error:** Unable to continue' },
      ]);
      expect(message.toolCalls).toEqual([expect.objectContaining({ id: 'read', status: 'completed', result: 'Note contents' })]);
    } finally {
      stream.resetStreamingState();
      stream.dispose(); subagents.clear(); renderer.dispose(); now.mockRestore();
    }
  },
);

it.each([
  [false, false], [true, false], [false, true], [true, true],
])('keeps background tools and notification order (compaction: %s, steering: %s)', async (compaction, steering) => {
  const { messagesEl, renderer, state, stream, coordinator, session, backend, dispose } = (await createBackgroundChat());
  try {
    await coordinator.bindConversation({ conversationId: 'conversation', providerId: 'codex' });
    await coordinator.prepare();
    const requested: ChatMessage = { id: 'requested', role: 'assistant', timestamp: 1, content: '', contentBlocks: [] };
    state.addMessage(requested);
    state.currentContentEl = renderer.addMessage(requested).querySelector('.claudian-message-content');
    await stream.handleStreamChunk({ type: 'text', content: 'Requested ' }, requested);
    const current = state.currentContentEl;
    const native = backend.latest;
    native.emitSessionEvent({ type: 'task_notification', content: 'First task finished.' });
    native.emitBackgroundEvent({ type: 'background_turn_started' });
    native.emitBackgroundEvent({ type: 'tool_started', toolCallId: 'read', toolScope: { kind: 'main' }, name: 'Read', input: { file_path: 'task.output' } });
    native.emitSessionEvent({ type: 'task_notification', content: 'Second task finished.' });
    if (steering) native.emitBackgroundEvent({ type: 'user_message_started', content: 'Change the plan', nativeUserMessageId: 'steered-user' });
    native.emitBackgroundEvent({ type: 'tool_completed', toolCallId: 'read', toolScope: { kind: 'main' }, content: 'First task result' });
    if (compaction) native.emitBackgroundEvent({ type: 'context_compacted' });
    native.emitBackgroundEvent({ type: 'text_delta', text: 'After notification.' });
    native.emitBackgroundEvent({ type: 'background_turn_completed', reason: 'completed', nativeAssistantId: 'final-checkpoint' });
    await session.awaitBackgroundWork();
    const notifications = within(messagesEl).getAllByRole('button', { name: 'Task notification' });
    const automaticWork = within(messagesEl).getByText('Read');
    expect(notifications[0].compareDocumentPosition(automaticWork) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(automaticWork.compareDocumentPosition(notifications[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const notification = notifications[1];
    const answer = within(messagesEl).getByText('After notification.');
    expect(notification.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const output = [notification, ...(steering ? [within(messagesEl).getByText('Change the plan')] : []),
      ...(compaction ? [within(messagesEl).getByText('Conversation compacted')] : []), answer];
    for (const [index, element] of output.slice(1).entries()) {
      expect(output[index].compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(state.messages.at(-1)).toMatchObject({ content: 'After notification.', assistantMessageId: 'final-checkpoint', isAutomaticResponse: !steering });
    expect(state.messages.flatMap(message => message.toolCalls ?? [])).toMatchObject([{ id: 'read', result: 'First task result', status: 'completed' }]);
    expect(state.messages.filter(message => message.assistantMessageId === 'final-checkpoint')).toHaveLength(1);
    expect(state.currentContentEl).toBe(current);
    await stream.handleStreamChunk({ type: 'text', content: 'answer' }, requested);
    await stream.finalizeCurrentTextBlock(requested);
    expect(requested.content).toBe('Requested answer');
    expect((await axe(messagesEl)).violations).toEqual([]);
  } finally {
    await dispose();
  }
});

it.each([
  ['before the turn opens', 1, false], ['after the turn opens', 1, true], ['twice after the turn opens', 2, true],
] as const)('renders a notification turn the same when its notification arrives %s', async (_order, cards, opensFirst) => {
  const { messagesEl, state, coordinator, session, backend, dispose } = (await createBackgroundChat());
  try {
    await coordinator.bindConversation({ conversationId: 'conversation', providerId: 'codex' });
    await coordinator.prepare();
    const native = backend.latest;
    const contents = ['First task finished.', 'Second task finished.'].slice(0, cards);
    // Claude opens a notification turn at its native init and publishes the notification at its first token.
    if (opensFirst) native.emitBackgroundEvent({ type: 'background_turn_started' });
    for (const content of contents) native.emitSessionEvent({ type: 'task_notification', content });
    if (!opensFirst) native.emitBackgroundEvent({ type: 'background_turn_started' });
    native.emitBackgroundEvent({ type: 'text_delta', text: 'Automatic reply.' });
    native.emitBackgroundEvent({ type: 'background_turn_completed', reason: 'completed', nativeAssistantId: 'automatic-checkpoint' });
    await session.awaitBackgroundWork();
    expect(state.messages).toMatchObject([
      ...contents.map(content => ({ isAutomaticResponse: true, contentBlocks: [{ type: 'task_notification', content }] })),
      { content: 'Automatic reply.', isAutomaticResponse: true, assistantMessageId: 'automatic-checkpoint',
        contentBlocks: [{ type: 'text', content: 'Automatic reply.' }] },
    ]);
    expect(state.messages).toHaveLength(cards + 1);
    const headers = within(messagesEl).getAllByRole('button', { name: 'Task notification' });
    const reply = within(messagesEl).getByText('Automatic reply.');
    expect(headers).toHaveLength(cards);
    for (const header of headers) expect(header.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const content of contents) expect(within(messagesEl).getByText(content).closest('[hidden]')).not.toBeNull();
    expect(reply.closest('[hidden]')).toBeNull();
    expect(within(messagesEl).queryByRole('button', { name: /^Worked/ })).toBeNull();
    expect((await axe(messagesEl)).violations).toEqual([]);
  } finally { await dispose(); }
});

it.each([
  ['', 'steered reply'], ['', ''], ['automatic prefix', 'steered reply'], ['automatic prefix', ''],
])('preserves background output around accepted input (prefix: %s, reply: %s)', async (prefix, reply) => {
  const { messagesEl, renderer, state, coordinator, session, backend, dispose } = (await createBackgroundChat());
  try {
    await coordinator.bindConversation({ conversationId: 'conversation', providerId: 'codex' });
    await coordinator.prepare();
    const native = backend.latest;
    native.emitBackgroundEvent({ type: 'background_turn_started' });
    if (prefix) native.emitBackgroundEvent({ type: 'text_delta', text: prefix });
    native.emitBackgroundEvent({ type: 'user_message_started', content: 'steered message', nativeUserMessageId: 'steered-user' });
    await session.awaitBackgroundWork();
    expect(within(messagesEl).getByText('steered message').closest('[hidden]')).toBeNull();
    // A later submission must not move ahead of the already accepted steer and its reserved response.
    const later: ChatMessage = { id: 'later', role: 'user', content: 'later input', timestamp: testDate().getTime() };
    state.addMessage(later); renderer.addMessage(later);
    if (reply) native.emitBackgroundEvent({ type: 'text_delta', text: reply });
    native.emitBackgroundEvent({ type: 'background_turn_completed', reason: 'completed', nativeAssistantId: 'steered-checkpoint' });
    await session.awaitBackgroundWork();
    expect(state.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(['steered message', 'later input']);
    expect(state.messages.find(message => message.role === 'user')?.userMessageId).toBe('steered-user');
    expect(state.messages).toMatchObject([
      ...(prefix ? [{ role: 'assistant', content: prefix, isAutomaticResponse: true }] : []),
      { role: 'user', content: 'steered message' },
      ...(reply ? [{ role: 'assistant', content: reply, assistantMessageId: 'steered-checkpoint', isAutomaticResponse: false }] : []),
      { role: 'user', content: 'later input' },
    ]);
    expect(state.messages.filter(message => message.assistantMessageId === 'steered-checkpoint')).toHaveLength(reply ? 1 : 0);
    const elements = [...(prefix ? [prefix] : []), 'steered message', ...(reply ? [reply] : []), 'later input'].map(text => within(messagesEl).getByText(text));
    expect(elements.slice(1).map((element, index) => !!(elements[index].compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)))
      .toEqual(elements.slice(1).map(() => true));
    expect((await axe(messagesEl)).violations).toEqual([]);
  } finally { await dispose(); }
});

it('does not continue a steered reply from a later turn notification', async () => {
  const { messagesEl, state, coordinator, session, backend, dispose } = (await createBackgroundChat());
  try {
    await coordinator.bindConversation({ conversationId: 'conversation', providerId: 'codex' });
    await coordinator.prepare();
    const native = backend.latest;
    native.emitBackgroundEvent({ type: 'background_turn_started' });
    native.emitBackgroundEvent({ type: 'text_delta', text: 'first automatic' });
    native.emitBackgroundEvent({ type: 'background_turn_started' }, 'background-2');
    native.emitSessionEvent({ type: 'task_notification', content: 'Second turn task finished.' });
    native.emitBackgroundEvent({ type: 'user_message_started', content: 'steered message', nativeUserMessageId: 'steered-user' });
    native.emitBackgroundEvent({ type: 'text_delta', text: 'steered reply' });
    native.emitBackgroundEvent({ type: 'background_turn_completed', reason: 'completed', nativeAssistantId: 'steered-checkpoint' });
    await session.awaitBackgroundWork();
    const notification = within(messagesEl).getByRole('button', { name: 'Task notification' });
    const reply = within(messagesEl).getByText('steered reply');
    expect(reply.compareDocumentPosition(notification) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const steered = state.messages.find(message => message.content === 'steered reply');
    expect(steered).toMatchObject({ isAutomaticResponse: false, assistantMessageId: 'steered-checkpoint' });
    expect(steered?.responseContinuationOf).toBeUndefined();
    expect((await axe(messagesEl)).violations).toEqual([]);
  } finally { await dispose(); }
});

it.each([
  ['pending', 'background'], ['uncertain', 'background'],
  ['pending', 'automatic'], ['uncertain', 'automatic'],
  ['pending', 'requested'], ['uncertain', 'requested'],
  ['uncertain', 'rejected'],
])('reconciles late image input through real chat owners (%s acknowledgement, %s turn)', async (acknowledgement, destination) => {
  const { messagesEl, state, coordinator, session, backend, input, setImages, dispose } = (await createBackgroundChat(true));
  try {
    await coordinator.bindConversation({ conversationId: 'conversation-1', providerId: 'codex' });
    await coordinator.prepare();
    const native = backend.latest;
    const admission = deferred<boolean>();
    const nativeSteer = vi.fn((_request: ProviderExecutionRequest) => Promise.resolve(true))
      .mockImplementationOnce(() => admission.promise);
    Object.assign(native, { steer: nativeSteer });
    input!.input.value = 'initial message';
    const first = input!.controller.sendMessage();
    await waitFor(() => expect(native.requests).toHaveLength(1));
    native.emitOutput({ type: 'user_message_started', content: 'initial message', nativeUserMessageId: 'initial-user' });
    native.emitText('initial answer');
    await waitFor(() => expect(within(messagesEl).getByText('initial answer')).toBeTruthy());
    const image: ImageAttachment = { id: 'image', name: 'pixel.png', mediaType: 'image/png', data: 'aW1hZ2U=', size: 5, source: 'paste' };
    const display = destination === 'automatic' && acknowledgement === 'uncertain' ? 'steer with image' : '';
    input!.input.value = display;
    setImages([image]);
    await input!.controller.sendMessage();
    const steering = input!.controller.queue.steerNow();
    await waitFor(() => expect(nativeSteer).toHaveBeenCalledTimes(1));
    if (acknowledgement === 'uncertain') {
      admission.reject(new Error('Acknowledgement lost'));
      await steering;
    }
    native.complete();
    await first;
    state.discardPendingConversationSave();
    const savedMessages: ChatMessage[][] = [];
    input!.plugin.updateConversation.mockImplementation(async (_id, updates) => {
      if (updates.messages) savedMessages.push(structuredClone(updates.messages));
    });
    let next: Promise<void> | undefined;
    const late = { type: 'user_message_started' as const, content: '', nativeUserMessageId: 'late-image-user',
      inputId: nativeSteer.mock.calls[0][0].inputId };
    expect(late.inputId).toEqual(expect.any(String));
    if (destination === 'requested') {
      input!.input.value = 'new message';
      next = input!.controller.sendMessage();
    } else if (destination === 'rejected') {
      vi.spyOn(native, 'execute').mockImplementationOnce(() => {
        native.emitBackgroundEvent({ type: 'background_turn_started' });
        native.emitBackgroundEvent(late);
        throw new Error('New request failed admission');
      });
      input!.input.value = 'new message';
      await input!.controller.sendMessage();
    }
    await waitFor(() => expect(native.requests).toHaveLength(destination === 'requested' ? 2 : 1));
    if (destination === 'requested') {
      native.emitOutput({ type: 'user_message_started', content: 'new message', nativeUserMessageId: 'new-user' });
      admission.resolve(true);
      await steering;
      input!.input.value = 'new steer';
      await input!.controller.sendMessage();
      await input!.controller.queue.steerNow();
    }
    expect(nativeSteer).toHaveBeenCalledTimes(destination === 'requested' ? 2 : 1);
    if (destination === 'requested') {
      native.emitOutput(late);
      native.emitOutput({ type: 'user_message_started', content: 'provider expanded new steer', nativeUserMessageId: 'new-steer-user',
        inputId: nativeSteer.mock.calls[1][0].inputId });
    } else if (destination !== 'rejected') {
      native.emitBackgroundEvent({ type: 'background_turn_started' });
      if (destination === 'automatic') {
        native.emitBackgroundEvent({ type: 'assistant_message_started' });
        native.emitBackgroundEvent({ type: 'text_delta', text: 'automatic work before steering' });
      }
      native.emitBackgroundEvent(late);
    }
    admission.resolve(true);
    await steering;
    if (destination === 'requested') {
      native.emitText('image answer');
      native.complete();
      await next;
    } else {
      native.emitBackgroundEvent({ type: 'text_delta', text: 'image answer' });
      native.emitBackgroundEvent({ type: 'background_turn_completed', reason: 'completed', nativeAssistantId: 'late-checkpoint' });
    }
    await session.awaitBackgroundWork();
    expect(state.messages.filter(message => message.role === 'user')).toMatchObject([
      { content: 'initial message', userMessageId: 'initial-user' },
      ...(destination === 'requested' ? [{ content: 'new message', userMessageId: 'new-user' }] : []),
      { content: display, images: [image], userMessageId: 'late-image-user' },
      ...(destination === 'requested' ? [{ content: 'new steer', userMessageId: 'new-steer-user' }] : []),
    ]);
    expect(coordinator.getSteerSubmission(late.inputId!)).toBeUndefined();
    expect(within(messagesEl).getByRole('img', { name: 'pixel.png' })).toBeTruthy();
    expect(within(messagesEl).getByText('image answer')).toBeTruthy();
    const prefix = 'automatic work before steering';
    expect(state.messages.filter(message => message.content === prefix || message.content === 'image answer'
      || message.userMessageId === 'late-image-user')).toMatchObject([
      ...(destination === 'automatic' ? [{ role: 'assistant', content: prefix, isAutomaticResponse: true }] : []),
      { role: 'user', content: display, images: [image], userMessageId: 'late-image-user' },
      { role: 'assistant', content: 'image answer', ...(destination === 'requested' ? {} : { isAutomaticResponse: false, assistantMessageId: 'late-checkpoint' }) },
    ]);
    expect(state.messages.filter(message => message.assistantMessageId === 'late-checkpoint')).toHaveLength(destination === 'requested' ? 0 : 1);
    const elements = [...(destination === 'automatic' ? [within(messagesEl).getByText(prefix)] : []),
      within(messagesEl).getByRole('img', { name: 'pixel.png' }), ...(display ? [within(messagesEl).getByText(display)] : []),
      within(messagesEl).getByText('image answer')];
    for (const [index, element] of elements.slice(1).entries()) {
      expect(elements[index].compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect((await axe(messagesEl)).violations).toEqual([]);
    expect(input!.input.value).toBe(destination === 'rejected' ? 'new message' : '');
    expect(input!.controller.queue.message).toBeNull();
    expect(state.hasPendingConversationSave).toBe(destination !== 'requested');
    const savedLateMessages = savedMessages.at(-1)?.filter(message =>
      message.userMessageId === 'late-image-user' || message.content === 'image answer') ?? [];
    expect(savedLateMessages).toMatchObject(destination === 'requested' ? [
      { role: 'user', userMessageId: 'late-image-user', images: [image] },
      { role: 'assistant', content: 'image answer' },
    ] : []);
    expect(native.requests).toHaveLength(destination === 'requested' ? 2 : 1);
    expect(nativeSteer).toHaveBeenCalledTimes(destination === 'requested' ? 2 : 1);
  } finally { await dispose(); }
});

async function createBackgroundChat(withInput = false) {
  const messagesEl = document.body.createDiv();
  const plugin = await createChatFeatureHost({ settings: { mediaFolder: '' } });
  const renderer = new MessageRenderer(plugin,
    new Component(), messagesEl);
  const lifecycleRegistry = new ProviderExecutionLifecycleRegistry();
  const backend = new FakeSideBackend();
  let input: Awaited<ReturnType<typeof createFixture>> | undefined;
  const coordinator: ChatExecutionCoordinator = new ChatExecutionCoordinator({
    lifecycleRegistry, resolveBackend: () => backend,
    persistence: { persistExecutionSnapshot: async () => true, registerExecutionBinding: () => undefined,
      releaseExecutionBinding: () => undefined, assertConversationExecutionAuthority: async () => undefined,
      recordConversationActivity: async () => undefined },
    interactionPort: { requestApproval: vi.fn(), askUserQuestion: vi.fn(), dismissInteraction: vi.fn() }, workingDirectory: '/vault', createId: () => 'binding',
    onRequestedEvent: event => input?.controller.handleExecutionEvent(event),
    onSessionEvent: (event, context) => events.enqueue(event, context),
  });
  const tabSession = createTabSession({ id: 'tab', conversationId: 'conversation', draftModel: null,
    providerId: 'codex', lifecycleState: 'open' }, coordinator);
  const session = tabSession.runtime;
  const state = new ChatState({}, undefined, session.turns);
  const subagents = new SubagentManager(() => undefined);
  const stream = new StreamController({ plugin, state, renderer, subagentManager: subagents,
    getMessagesEl: () => messagesEl, updateQueueIndicator: () => undefined });
  const setImages = (next: ImageAttachment[]) => {
    if (!input) throw new Error('Input fixture required for attachments');
    input.images.setImages(next);
  };
  if (withInput) input = (await createFixture({
    state, session, renderer, streamController: stream,
    getMessagesEl: () => messagesEl, getExecutionCoordinator: () => coordinator,
  }));
  const events: SessionEvents = new SessionEvents({ state, renderer, stream, session, executionCoordinator: coordinator,
    persistence: { save: async () => undefined, scheduleProgressSave: () => undefined },
    createMessageId: createTabMessageId, updatePermissionMode: async () => undefined,
    receiveSuggestion: () => undefined, discardSuggestion: () => undefined, canAcceptBackgroundWork: () => true,
    claimBackgroundUserMessage: (nativeUserMessageId, inputId) => input?.controller.claimBackgroundUserMessage(nativeUserMessageId, inputId),
  });
  return { messagesEl, renderer, state, stream, coordinator, session, backend, input, setImages, dispose: async () => {
    await coordinator.dispose(); await lifecycleRegistry.dispose();
    stream.dispose(); subagents.clear(); renderer.dispose();
  } };
}

it('records requested and background segments around notifications with no presenter', async () => {
  const state = new ChatState();
  const plugin = await createChatFeatureHost({ settings: {} });
  const manager = new SubagentManager(() => undefined);
  const renderer = null;
  const stream = new StreamController({ plugin, state, renderer, subagentManager: manager,
    getMessagesEl: () => null, updateQueueIndicator: () => undefined });
  let nextId = 0;
  const host = { state, renderer, stream, turns: new TurnCoordinator(), createMessageId: () => `message-${++nextId}` };
  const response = new ResponseStream(host);
  const background = new BackgroundResponses(host);
  const requestedScope = { kind: 'requested' as const, sessionInstanceId: 'native', executionId: 'request', turnId: 'requested', sequence: 1 };
  const backgroundScope = { kind: 'background' as const, sessionInstanceId: 'native', turnId: 'background', sequence: 1 };
  try {
    response.start();
    await response.handleEvent({ type: 'text_delta', text: 'Before.', scope: requestedScope });
    background.reserve('binding', 'background');
    await background.handle('binding', { type: 'text_delta', text: 'Background before.', scope: backgroundScope }, () => true);
    renderSessionTaskNotification(host, 'Task finished.', requestedScope, backgroundScope);
    await response.handleEvent({ type: 'text_delta', text: 'After.', scope: { ...requestedScope, sequence: 2 } });
    await background.handle('binding', { type: 'text_delta', text: 'Background after.', scope: { ...backgroundScope, sequence: 2 } }, () => true);
    await background.handle('binding', { type: 'background_turn_completed', reason: 'completed', scope: { ...backgroundScope, sequence: 3 } }, () => true);
    await response.finish(response.active!, { interrupted: false, failed: false });
    expect(state.messages.map(message => message.contentBlocks)).toEqual([
      [{ type: 'text', content: 'Before.' }],
      [{ type: 'text', content: 'Background before.' }],
      [{ type: 'task_notification', content: 'Task finished.' }],
      [{ type: 'text', content: 'Background after.' }],
      [{ type: 'text', content: 'After.' }],
    ]);
  } finally { stream.dispose(); manager.clear(); }
});

it('retains a successful edit diff when no tool card was created', async () => {
  const state = new ChatState();
  const plugin = await createChatFeatureHost({ settings: {} });
  const manager = new SubagentManager(() => undefined);
  const messagesEl = document.body.createDiv();
  const renderer = new MessageRenderer(plugin, new Component(), messagesEl);
  const stream = new StreamController({ plugin, state, renderer, subagentManager: manager,
    getMessagesEl: () => messagesEl, updateQueueIndicator: () => undefined });
  const message: ChatMessage = { id: 'edit-response', role: 'assistant', timestamp: testClock()().getTime(), content: '' };
  try {
    await stream.handleStreamChunk({ type: 'tool_use', id: 'edit', name: 'Edit', input: { file_path: '/outside/note.md', old_string: 'old', new_string: 'new' } }, message);
    await stream.handleStreamChunk({ type: 'tool_result', id: 'edit', content: 'Updated.', resultDetails: {
      diff: { filePath: '/outside/note.md', diffLines: [{ type: 'delete', text: 'old', oldLineNum: 1 }, { type: 'insert', text: 'new', newLineNum: 1 }], stats: { added: 1, removed: 1 } },
    } }, message);
    expect(message.toolCalls?.[0].diffData).toEqual({ filePath: '/outside/note.md',
      diffLines: [{ type: 'delete', text: 'old', oldLineNum: 1 }, { type: 'insert', text: 'new', newLineNum: 1 }], stats: { added: 1, removed: 1 } });
    expect(messagesEl.childElementCount).toBe(0);
  } finally { stream.dispose(); manager.clear(); renderer.dispose(); }
});

/** Text a reader sees in an element, skipping collapsed disclosure content. */
function visibleText(element: HTMLElement): string {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement?.closest('[hidden], .claudian-message-timestamp') && node.textContent?.trim()) parts.push(node.textContent.trim());
  }
  return parts.join(' ');
}

function visibleTranscript(root: HTMLElement): string {
  return Array.from(root.querySelectorAll<HTMLElement>('.claudian-message'), visibleText).filter(Boolean).join(' ');
}

async function createBackgroundSession() {
  const messagesEl = document.body.createDiv();
  const plugin = await createChatFeatureHost({ settings: { mediaFolder: '' } });
  const renderer = new MessageRenderer(plugin, new Component(), messagesEl);
  const state = new ChatState();
  const manager = new SubagentManager(() => undefined);
  const stream = new StreamController({ plugin, state, renderer, subagentManager: manager,
    getMessagesEl: () => messagesEl, updateQueueIndicator: () => undefined });
  let nextId = 0;
  const host = { state, renderer, stream, createMessageId: () => `message-${++nextId}` };
  const background = new BackgroundResponses(host);
  const scope = { kind: 'background' as const, sessionInstanceId: 'native', turnId: 'automatic', sequence: 0 };
  const next = () => ({ ...scope, sequence: ++scope.sequence });
  const text = (value: string) => background.handle('binding', { type: 'text_delta', text: value, scope: next() }, () => true);
  const stop = () => background.handle('binding', { type: 'background_turn_completed', reason: 'interrupted', scope: next() }, () => true);
  return { messagesEl, plugin, renderer, state, host, background, next, text, stop,
    dispose: () => { stream.dispose(); manager.clear(); renderer.dispose(); } };
}

it('keeps a reply before a steer intact and ends the steered input in an indicator when stopped before new output', async () => {
  const session = (await createBackgroundSession());
  const { messagesEl, renderer, state, background } = session;
  const inspect = () => ({
    transcript: Array.from(messagesEl.querySelectorAll<HTMLElement>('.claudian-message'), visibleText).filter(Boolean),
    disclosures: within(messagesEl).queryAllByRole('button', { name: /^(Interrupted|Worked)/ }).length,
  });
  try {
    renderSessionTaskNotification(session.host, 'Job finished.', undefined, session.next());
    background.reserve('binding', 'automatic');
    await session.text('Background reply.');
    background.userMessage('binding', { type: 'user_message_started', content: 'Make it shorter', scope: session.next() });
    await session.stop();
    await Promise.resolve();
    const expected = { transcript: ['Task notification', 'Background reply.', 'Make it shorter',
      'Interrupted · What should BetterAgent do instead?'], disclosures: 0 };
    expect(inspect()).toEqual(expected);
    expect(state.messages.find(message => message.content === 'Background reply.')?.isInterrupt).toBeUndefined();
    renderer.renderMessages(state.messages, () => 'Welcome');
    await Promise.resolve();
    expect(inspect()).toEqual(expected);
  } finally { session.dispose(); }
});

// A bare marker belongs to the turn that stopped: an automatic turn with no visible trigger
// that stops before output ends in a plain indicator and leaves the completed answer before it alone.
it('keeps a completed answer intact when the automatic turn after it stops before output', async () => {
  const session = (await createBackgroundSession());
  const { messagesEl, renderer, state, background } = session;
  const inspect = () => ({
    transcript: Array.from(messagesEl.querySelectorAll<HTMLElement>('.claudian-message'), visibleText).filter(Boolean),
    interrupted: within(messagesEl).queryAllByRole('button', { name: /^Interrupted/ }).length,
  });
  try {
    const prompt: ChatMessage = { id: 'prompt', role: 'user', content: 'Do the work', timestamp: testDate().getTime() };
    const answer: ChatMessage = { id: 'answer', role: 'assistant', content: 'Completed answer.', timestamp: testDate().getTime(),
      completedAt: testDate().getTime(), contentBlocks: [{ type: 'text', content: 'Completed answer.' }] };
    state.addMessage(prompt);
    state.addMessage(answer);
    renderer.renderMessages(state.messages, () => 'Welcome');
    background.reserve('binding', 'automatic');
    await session.stop();
    await Promise.resolve();
    const expected = { transcript: ['Do the work', 'Completed answer.', 'Interrupted · What should BetterAgent do instead?'], interrupted: 0 };
    expect(inspect()).toEqual(expected);
    renderer.renderMessages(state.messages, () => 'Welcome');
    await Promise.resolve();
    expect(inspect()).toEqual(expected);
  } finally { session.dispose(); }
});

// The interrupted reply before a marker only shows the marker of its own turn.
it('keeps the indicator of an automatic turn stopped before output after an interrupted requested reply', async () => {
  const session = (await createBackgroundSession());
  const { messagesEl, renderer, state, background } = session;
  const indicators = () => within(messagesEl).getAllByText('Interrupted').length;
  try {
    const prompt: ChatMessage = { id: 'prompt', role: 'user', content: 'Do the work', timestamp: testDate().getTime() };
    state.addMessage(prompt);
    renderer.renderMessages(state.messages, () => 'Welcome');
    const requested = new ResponseStream({ ...session.host, turns: new TurnCoordinator() });
    requested.start();
    await requested.handleEvent({ type: 'text_delta', text: 'Requested partial.',
      scope: { kind: 'requested', sessionInstanceId: 'native', executionId: 'execution', turnId: 'requested', sequence: 1 } });
    await requested.finish(requested.active!, { interrupted: true, failed: false });
    background.reserve('binding', 'automatic');
    await session.stop();
    await Promise.resolve();
    expect(indicators()).toBe(2);
    renderer.renderMessages(state.messages, () => 'Welcome');
    await Promise.resolve();
    expect(indicators()).toBe(2);
  } finally { session.dispose(); }
});

// Blank thinking is no output: the stop ends the reply before it, as the shared layout reads it.
it.each([true, false])('folds a background turn stopped after blank thinking like rerender (earlier reply: %s)', async earlier => {
  const session = (await createBackgroundSession());
  const { messagesEl, renderer, state, background } = session;
  const inspect = () => ({ transcript: visibleTranscript(messagesEl),
    headers: within(messagesEl).queryAllByRole('button', { name: /^Interrupted/ }).length });
  try {
    background.reserve('binding', 'automatic');
    if (earlier) {
      await session.text('Earlier reply.');
      renderSessionTaskNotification(session.host, 'Job finished.', undefined, session.next());
    }
    await background.handle('binding', { type: 'thinking_delta', text: '   ', scope: session.next() }, () => true);
    await session.stop();
    await Promise.resolve();
    const expected = { transcript: 'Interrupted · What should BetterAgent do instead?', headers: earlier ? 1 : 0 };
    expect(inspect()).toEqual(expected);
    renderer.renderMessages(state.messages, () => 'Welcome');
    await Promise.resolve();
    expect(inspect()).toEqual(expected);
  } finally { session.dispose(); }
});

// Output-free segments on either side of a notification show nothing: a turn stopped without
// output keeps its notification visible and ends in a plain indicator.
it('keeps a notification visible when blank thinking surrounds it in a stopped background turn', async () => {
  const session = (await createBackgroundSession());
  const { messagesEl, renderer, state, background } = session;
  const blankThinking = () => background.handle('binding', { type: 'thinking_delta', text: '   ', scope: session.next() }, () => true);
  const inspect = () => ({ transcript: visibleTranscript(messagesEl),
    headers: within(messagesEl).queryAllByRole('button', { name: /^Interrupted/ }).length });
  try {
    background.reserve('binding', 'automatic');
    await blankThinking();
    renderSessionTaskNotification(session.host, 'Job finished.', undefined, session.next());
    await blankThinking();
    await session.stop();
    await Promise.resolve();
    const expected = { transcript: 'Task notification Interrupted · What should BetterAgent do instead?', headers: 0 };
    expect(inspect()).toEqual(expected);
    renderer.renderMessages(state.messages, () => 'Welcome');
    await Promise.resolve();
    expect(inspect()).toEqual(expected);
  } finally { session.dispose(); }
});


// Issue #2189: an arrival keeps a scrolled-up reader's place, and still comes into view at the bottom.
it.each([
  { reader: 'far up', autoScroll: true },
  { reader: 'far up', autoScroll: false },
  { reader: 'at the bottom', autoScroll: true },
  { reader: 'at the bottom', autoScroll: false },
])('follows a notification and background turn only for a reader $reader (auto-scroll $autoScroll)', async ({ reader, autoScroll }) => {
  const session = (await createBackgroundSession());
  const { messagesEl, plugin, renderer, state, background } = session;
  plugin.settings.enableAutoScroll = autoScroll;
  const geometry = useTranscriptGeometry(messagesEl);
  try {
    for (let index = 0; index < 6; index++) {
      state.addMessage({ id: `u${index}`, role: 'user', content: `Prompt ${index}`, timestamp: testDate().getTime() });
      state.addMessage({ id: `a${index}`, role: 'assistant', content: `Answer ${index}`, timestamp: testDate().getTime(),
        completedAt: testDate().getTime(), contentBlocks: [{ type: 'text', content: `Answer ${index}` }] });
    }
    renderer.renderMessages(state.messages, () => 'Welcome');
    expect(messagesEl.scrollTop).toBe(geometry.bottom());
    if (reader === 'far up') {
      fireEvent.wheel(messagesEl, { deltaY: -100 });
      messagesEl.scrollTop = 200;
      fireEvent.scroll(messagesEl);
    }
    const expected = () => reader === 'far up' ? 200 : geometry.bottom();

    renderSessionTaskNotification(session.host, 'Job finished.', undefined, session.next());
    expect(messagesEl.scrollTop).toBe(expected());
    background.reserve('binding', 'automatic');
    expect(messagesEl.scrollTop).toBe(expected());
    await session.text('Background reply.');
    await background.handle('binding', { type: 'background_turn_completed', reason: 'completed', scope: session.next() }, () => true);
    await Promise.resolve();
    expect(within(messagesEl).getByText('Background reply.')).toBeTruthy();
    expect(messagesEl.scrollTop).toBe(expected());
  } finally { session.dispose(); }
});

// A reader who scrolls up while a settled turn is still rendering keeps that place when it finishes.
it.each([true, false])('keeps the place of a reader who scrolls up during background rendering (auto-scroll %s)', async autoScroll => {
  const session = (await createBackgroundSession());
  const { messagesEl, plugin, renderer, state, background } = session;
  plugin.settings.enableAutoScroll = autoScroll;
  const geometry = useTranscriptGeometry(messagesEl);
  const rendering = deferred<void>();
  const renderStarted = deferred<void>();
  vi.mocked(MarkdownRenderer.render).mockImplementation(async (_app, markdown, el) => {
    if (markdown === 'Background reply.') {
      renderStarted.resolve();
      await rendering.promise;
    }
    (el as HTMLElement).createEl('p', { text: markdown });
  });
  try {
    for (let index = 0; index < 6; index++) {
      state.addMessage({ id: `u${index}`, role: 'user', content: `Prompt ${index}`, timestamp: testDate().getTime() });
      state.addMessage({ id: `a${index}`, role: 'assistant', content: `Answer ${index}`, timestamp: testDate().getTime(),
        completedAt: testDate().getTime(), contentBlocks: [{ type: 'text', content: `Answer ${index}` }] });
    }
    renderer.renderMessages(state.messages, () => 'Welcome');
    expect(messagesEl.scrollTop).toBe(geometry.bottom());

    background.reserve('binding', 'automatic');
    await session.text('Background reply.');
    const completing = background.handle('binding', { type: 'background_turn_completed', reason: 'completed', scope: session.next() }, () => true);
    await renderStarted.promise;
    fireEvent.wheel(messagesEl, { deltaY: -100 });
    messagesEl.scrollTop = 200;
    fireEvent.scroll(messagesEl);
    rendering.resolve();
    await completing;
    await Promise.resolve();

    expect(within(messagesEl).getByText('Background reply.')).toBeTruthy();
    expect(messagesEl.scrollTop).toBe(200);
  } finally { session.dispose(); }
});
