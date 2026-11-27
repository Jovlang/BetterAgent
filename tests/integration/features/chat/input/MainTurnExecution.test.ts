import '@test/helpers/registeredCodex';

// @vitest-environment jsdom
import { createFixture } from '@test/helpers/ChatInputHarness';
import { Notice } from 'obsidian';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { ChatMessage } from '@/core/types';
import type { ImageAttachment } from '@/core/types';
import { t } from '@/i18n/i18n';

const nativeCapabilities = ProviderRegistry.getCapabilities('codex');
beforeEach(() => {
  vi.spyOn(ProviderRegistry, 'getCapabilities').mockReturnValue({ ...nativeCapabilities, supportsTurnSteer: true });
});
afterEach(() => vi.restoreAllMocks());

describe('MainTurnExecution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ProviderRegistry.getCapabilities).mockReturnValue({
      ...nativeCapabilities,
      providerId: 'codex',
      supportsFork: true,
      supportsNativeHistory: true,
      supportsTurnSteer: true,
    });

  });

  it('submits and persists separate first and continued turns', async () => {
    const fixture = await createFixture();
    fixture.linkedContentController.lock('Projects');
    let persistedMessages: ChatMessage[] | undefined;
    fixture.plugin.updateConversation.mockImplementation(async (_id, updates) => {
      persistedMessages = structuredClone(updates.messages);
    });
    const usage = { model: 'claude-model', inputTokens: 10, contextWindow: 100, contextTokens: 10, percentage: 10 };
    fixture.native.respond.mockImplementation((run, request) => {
      run.emit({ type: 'turn_started', accepted: true });
      const text = request.input.filter(part => part.type === 'text').map(part => part.text).join('');
      if (text === 'first') {
        run.emit({ type: 'tool_started', toolCallId: 'agent-1', toolScope: { kind: 'main' }, name: 'Read',
          input: { file_path: 'README.md' } });
        run.emit({ type: 'tool_completed', toolCallId: 'agent-1', toolScope: { kind: 'main' }, content: 'Done' });
      } else {
        run.emit({ type: 'usage_updated', usage });
      }
      run.emit({ type: 'text_delta', text: `reply:${text}` });
      run.complete();
    });

    await fixture.controller.sendMessage({ content: 'first' });
    expect(fixture.state.messages.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: 'user', content: 'first' }, { role: 'assistant', content: 'reply:first' },
    ]);
    expect(persistedMessages).toMatchObject([
      { role: 'user', content: 'first' }, { role: 'assistant', content: 'reply:first' },
    ]);

    expect(fixture.state.messages[1].contentBlocks).toEqual(expect.arrayContaining([{ type: 'tool_use', toolId: 'agent-1' }]));
    await fixture.controller.sendMessage({ content: 'second' });
    expect(fixture.state.usage).toMatchObject(usage);

    const [first, second] = fixture.native.requests;
    expect(first).toMatchObject({
      input: [{ type: 'text', text: 'first' }],
      context: { linkedContent: { path: 'Projects' } },
      toolPolicy: { kind: 'provider-default' },
      conversationHistory: [],
    });
    expect(second.context).not.toHaveProperty('linkedContent');
    expect(second.conversationHistory).toMatchObject([
      { role: 'user', content: 'first' }, { role: 'assistant', content: 'reply:first' },
    ]);
    const expected = [
      { role: 'user', content: 'first' }, { role: 'assistant', content: 'reply:first' },
      { role: 'user', content: 'second' }, { role: 'assistant', content: 'reply:second' },
    ];
    expect(fixture.state.messages.map(({ role, content }) => ({ role, content }))).toEqual(expected);
    expect(persistedMessages).toMatchObject(expected);
  });

  it('keeps context feature-owned in the normalized submission', async () => {
    const fixture = await createFixture();
    fixture.linkedContentController.lock('note.md');

    await fixture.controller.sendMessage({
      content: 'use context',
      editorContextOverride: {
        mode: 'selection',
        notePath: 'note.md',
        selectedText: 'selection',
        startLine: 1,
      },
    });

    expect(fixture.native.requests[0]).toMatchObject({
      input: [{ type: 'text', text: 'use context' }],
      configuration: expect.objectContaining({
        model: 'claude-model',
      }),
      context: expect.objectContaining({
        linkedContent: { path: 'note.md' },
      }),
    });
  });

  it('restores composer input and rolls back the local turn on definite pre-handoff failure', async () => {
    const image: ImageAttachment = {
      id: 'image-1',
      name: 'image.png',
      mediaType: 'image/png',
      data: 'aGVsbG8=',
      size: 5,
      source: 'paste',
    };
    const fixture = await createFixture();
    fixture.images.setImages([image]);
    fixture.input.value = 'retry this';
    fixture.execution.repository.assertConversationExecutionAuthority.mockRejectedValueOnce(new Error('ledger unavailable'));

    await fixture.controller.sendMessage();

    expect(fixture.input.value).toBe('retry this');
    expect(fixture.images.getAttachedImages()).toEqual([image]);
    expect(fixture.state.messages).toEqual([]);
    expect(fixture.deps.getMessagesEl()?.textContent).toBe('');
    expect(fixture.plugin.updateConversation).not.toHaveBeenCalled();
    expect(fixture.state.activity?.kind).not.toBe('error');
    expect(Notice).toHaveBeenCalledWith('Message was not sent. Please try again.');
  });

  it('does not restore input after an ambiguous post-handoff rejection', async () => {
    const fixture = (await createFixture());
    fixture.input.value = 'possibly sent';
    fixture.native.respond.mockImplementationOnce(run => {
      run.emit({ type: 'turn_started', accepted: true });
      run.events.fail(new Error('stream failed'));
    });

    await fixture.controller.sendMessage();

    expect(fixture.input.value).toBe('');
    expect(fixture.state.messages).toHaveLength(2);
    expect(fixture.plugin.updateConversation.mock.calls.at(-1)?.[1].messages).toEqual(fixture.state.messages);
    expect(fixture.deps.getMessagesEl()?.textContent).toContain('stream failed');
  });

  it('renders and stores normalized requested output', async () => {
    const fixture = (await createFixture());
    fixture.native.respond.mockImplementationOnce(run => {
      run.emit({ type: 'turn_started', accepted: true });
      run.emit({ type: 'text_delta', text: 'world' });
      run.complete();
    });

    await fixture.controller.sendMessage({ content: 'hello' });

    expect(fixture.state.messages.filter(message => message.role === 'assistant').map(message => message.content)).toEqual(['world']);
    expect(fixture.deps.getMessagesEl()?.textContent).toContain('world');
    expect(fixture.plugin.updateConversation.mock.calls.at(-1)?.[1].messages).toMatchObject([
      { role: 'user', content: 'hello' }, { role: 'assistant', content: 'world' },
    ]);
  });

  it('renders a missing native session as an ordinary error and keeps the conversation', async () => {
    const fixture = (await createFixture());
    fixture.input.value = 'already handed off';
    fixture.native.respond.mockImplementationOnce(run => {
      run.emit({ type: 'turn_started', accepted: true });
      run.emit({ type: 'execution_error', category: 'provider-session-missing', message: 'Session missing', recoverable: true });
    });

    await fixture.controller.sendMessage();

    const messagesText = fixture.deps.getMessagesEl()?.textContent;
    expect(messagesText).toContain(t('chat.executionNotices.sessionUnavailable'));
    expect(messagesText).not.toContain('Session missing');
    expect(Notice).not.toHaveBeenCalled();
    expect(fixture.input.value).toBe('');
    expect(fixture.state.isStreaming).toBe(false);
    expect(fixture.state.messages.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: 'user', content: 'already handed off' }, { role: 'assistant', content: '' },
    ]);
    expect(fixture.plugin.updateConversation).toHaveBeenCalled();
    expect(fixture.native.disposeCalls).toBe(0);

    await fixture.controller.sendMessage({ content: 'try again' });

    expect(fixture.native.requests).toHaveLength(2);
    expect(fixture.native.disposeCalls).toBe(0);
  });

  it('does not report a definite pre-handoff failure as reviewable', async () => {
    const onReviewableSettlement = vi.fn();
    const fixture = (await createFixture({ onReviewableSettlement }));
    fixture.execution.repository.assertConversationExecutionAuthority.mockRejectedValueOnce(new Error('not handed off'));

    await fixture.controller.sendMessage({ content: 'finish this' });

    expect(onReviewableSettlement).not.toHaveBeenCalled();
  });
});
