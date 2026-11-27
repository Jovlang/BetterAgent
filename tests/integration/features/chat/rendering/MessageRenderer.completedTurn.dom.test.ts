/** @vitest-environment jsdom */
import '@test/helpers/registeredCodex';

import { axe } from '@test/helpers/accessibility';
import { createChatFeatureHost } from '@test/helpers/features/chat/ChatFeatureHostFixture';
import { testDate } from '@test/helpers/testClock';
import { fireEvent, within } from '@testing-library/dom';
import { Component, MarkdownRenderer } from 'obsidian';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { ChatMessage, ToolCallInfo } from '@/core/types';
import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import { createResponseTextBlock } from '@/features/chat/rendering/ResponseLayout';
import { createThinkingBlock, finalizeThinkingBlock } from '@/features/chat/rendering/ThinkingBlockRenderer';
import { setLocale, t } from '@/i18n/i18n';

let defaultHost: Awaited<ReturnType<typeof createChatFeatureHost>>;

function setup(providerId = 'codex') {
  const messagesEl = document.body.createDiv();
  const fork = vi.fn().mockResolvedValue(undefined);
  const renderer = new MessageRenderer(
    defaultHost,
    new Component(),
    messagesEl, undefined, fork, () => ProviderRegistry.getCapabilities(providerId),
  );
  return { renderer, messagesEl, fork };
}

const messages: ChatMessage[] = [
  { id: 'u1', role: 'user', content: 'Fix this', timestamp: 1, userMessageId: 'native-u1' },
  { id: 'a1', role: 'assistant', content: 'Checking the code.', timestamp: 2,
    contentBlocks: [{ type: 'text', content: 'Checking the code.' }] },
  { id: 'a2', role: 'assistant', content: 'Fixed the bug.', timestamp: 3,
    assistantMessageId: 'native-a2', durationSeconds: 65, completedAt: 5,
    contentBlocks: [
      { type: 'thinking', content: 'Check the edge case.' },
      { type: 'text', content: 'Fixed the bug.' },
    ] },
];

const INTERRUPTED = 'Interrupted · What should BetterAgent do instead?';

/** The interrupted disclosure's header is the interrupt indicator itself, never repeated in its body. */
function expectInterruptHeader(header: HTMLElement, history: HTMLElement): void {
  expect([header.querySelector('.claudian-interrupted')?.textContent, header.querySelector('.claudian-interrupted-hint')?.textContent])
    .toEqual(['Interrupted', '· What should BetterAgent do instead?']);
  expect(history.querySelector('.claudian-interrupted, .claudian-interrupted-hint')).toBeNull();
}

beforeEach(async () => {
  document.body.replaceChildren();
  defaultHost = await createChatFeatureHost({ settings: { mediaFolder: '' } });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

it.each([false, true])('collapses completed history above the answer and puts copy, fork, time below it (compaction: %s)', async compaction => {
  const { renderer, messagesEl, fork } = setup();
  const historyMessages: ChatMessage[] = [...messages];
  if (compaction) historyMessages.splice(2, 0, {
    id: 'compact', role: 'assistant', content: '', timestamp: testDate().getTime(),
    contentBlocks: [{ type: 'context_compacted' }],
  });
  renderer.renderMessages(historyMessages, () => 'Hello');
  await Promise.resolve();
  const header = within(messagesEl).getByRole('button', { name: 'Worked for 01:05' });
  expect(header.hasAttribute('aria-label')).toBe(false);
  expect(header.hasAttribute('title')).toBe(false);
  expect(header.getAttribute('aria-expanded')).toBe('false');
  const history = document.getElementById(header.getAttribute('aria-controls')!)!;
  expect(history.hidden).toBe(true);
  expect(history.textContent).toContain('Checking the code.');
  expect(history.textContent).toContain('Check the edge case.');
  expect(history.contains(within(messagesEl).queryByText('Conversation compacted'))).toBe(compaction);
  expect(history.textContent).not.toContain('Fixed the bug.');
  fireEvent.click(header);
  expect(history.hidden).toBe(false);
  expect(header.getAttribute('aria-expanded')).toBe('true');
  const thinking = within(history).getByRole('button', { name: 'Thought' });
  expect(thinking.hasAttribute('aria-label')).toBe(false);
  expect(thinking.hasAttribute('title')).toBe(false);
  fireEvent.keyDown(thinking, { key: 'Enter' });
  expect(thinking.getAttribute('aria-expanded')).toBe('true');
  expect((await axe(history)).violations).toEqual([]);
  fireEvent.click(header);
  expect(history.hidden).toBe(true);

  const answer = messagesEl.querySelector<HTMLElement>('[data-message-id="a2"]')!;
  const copy = within(answer).getByRole('button', { name: 'Copy message' });
  const forkButton = within(answer).getByRole('button', { name: 'Fork conversation' });
  const time = copy.parentElement!.querySelector('.claudian-message-timestamp')!;
  expect(copy.parentElement).toBe(forkButton.parentElement);
  expect(copy.parentElement).toBe(time.parentElement);
  expect(Array.from(copy.parentElement!.children)).toEqual([copy, forkButton, time]);
  fireEvent.click(copy);
  fireEvent.click(forkButton);
  await Promise.resolve();
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith('Fixed the bug.');
  expect(fork).toHaveBeenCalledWith('a2');
  const user = messagesEl.querySelector<HTMLElement>('[data-message-id="u1"]')!;
  expect(within(user).getByRole('button', { name: 'Copy message' }).nextElementSibling)
    .toBe(user.querySelector('.claudian-message-timestamp'));
  expect((await axe(answer)).violations).toEqual([]);
  renderer.dispose();
});

it('keeps live and finalized thinking accessible without hover tooltip attributes', async () => {
  const host = document.body.createDiv();
  const state = createThinkingBlock(host, { startTime: Date.now() });
  const header = within(host).getByRole('button', { name: 'Thinking 0s...' });
  expect(header.hasAttribute('aria-label')).toBe(false);
  expect(header.hasAttribute('title')).toBe(false);
  fireEvent.keyDown(header, { key: ' ' });
  expect(header.getAttribute('aria-expanded')).toBe('true');
  finalizeThinkingBlock(state, 0);
  expect(within(host).getByRole('button', { name: /^Thought for \d+s$/ })).toBe(header);
  expect(header.getAttribute('aria-expanded')).toBe('false');
  fireEvent.keyDown(header, { key: ' ' });
  expect(header.getAttribute('aria-expanded')).toBe('true');
  expect(state.contentEl.classList.contains('claudian-hidden')).toBe(false);
  expect((await axe(host)).violations).toEqual([]);
});

it('keeps live output in place until completion, then preserves the same content elements', async () => {
  const { renderer, messagesEl } = setup();
  const msg: ChatMessage = { id: 'live', role: 'assistant', content: 'Done.', timestamp: 4,
    contentBlocks: [{ type: 'thinking', content: 'Working' }, { type: 'text', content: 'Done.' }] };
  const el = renderer.addMessage(msg);
  const content = el.querySelector<HTMLElement>('.claudian-message-content')!;
  const work = content.createDiv({ cls: 'claudian-thinking-block', text: 'Working' });
  const answer = createResponseTextBlock(content);
  answer.setText('Done.');
  expect(within(messagesEl).queryByRole('button', { name: /Worked/ })).toBeNull();
  expect(work.parentElement).toBe(content);
  msg.durationSeconds = 0;
  renderer.finalizeResponse(msg, [msg]);
  const header = within(messagesEl).getByRole('button', { name: 'Worked for 00:00' });
  expect(work.parentElement!.hidden).toBe(true);
  expect(answer.parentElement).toBe(content);
  header.focus();
  expect(document.activeElement).toBe(header);
  expect(header.getAttribute('type')).toBe('button');
  renderer.dispose();
});

it('leaves unsuccessful output expanded', () => {
  const { renderer } = setup();
  const msg: ChatMessage = { id: 'failed', role: 'assistant', content: 'Partial', timestamp: 4,
    contentBlocks: [{ type: 'text', content: 'Partial' }] };
  const el = renderer.addMessage(msg);
  el.querySelector('.claudian-message-content')!.createDiv({ cls: 'claudian-text-block', text: 'Partial' });
  renderer.finalizeResponse(msg, [msg], false);
  expect(within(el).queryByRole('button', { name: /^(Worked|Interrupted)/ })).toBeNull();
  expect(within(el).getByText('Partial').closest('[hidden]')).toBeNull();
  expect(within(el).getByRole('button', { name: 'Copy message' })).toBeDefined();
  renderer.dispose();
});

it('folds a partial-text interruption under a disclosure headed by the interrupt indicator', async () => {
  const { renderer, messagesEl } = setup('codex');
  renderer.renderMessages([
    messages[0],
    { id: 'partial', role: 'assistant', content: 'Partial answer', timestamp: 4, isInterrupt: true,
      durationSeconds: 12, contentBlocks: [{ type: 'text', content: 'Partial answer' }] },
  ], () => 'Hello');
  await Promise.resolve();
  const header = within(messagesEl).getByRole('button', { name: INTERRUPTED });
  expect(within(messagesEl).queryByRole('button', { name: /^Worked/ })).toBeNull();
  const history = document.getElementById(header.getAttribute('aria-controls')!)!;
  const answer = within(messagesEl).getByText('Partial answer');
  expectInterruptHeader(header, history);
  expect(answer.closest('[hidden]')).toBe(history);
  expect(within(messagesEl.querySelector<HTMLElement>('[data-message-id="partial"]')!)
    .queryByRole('button', { name: 'Copy message' })).toBeNull();
  fireEvent.click(header);
  expect(answer.closest('[hidden]')).toBeNull();
  expect((await axe(messagesEl)).violations).toEqual([]);
  renderer.dispose();
});

it('copies retired interruption markup as ordinary message text', async () => {
  const { renderer, messagesEl } = setup();
  const marker = '<span class="claudian-interrupted">Interrupted</span> <span class="claudian-interrupted-hint">· What should BetterAgent do instead?</span>';
  renderer.renderStoredMessage({ id: 'legacy', role: 'assistant', timestamp: 5,
    content: `Partial answer\n\n${marker}` });
  fireEvent.click(within(messagesEl).getByRole('button', { name: 'Copy message' }));
  await Promise.resolve();
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith(`Partial answer\n\n${marker}`);
  expect(messagesEl.querySelectorAll('.claudian-interrupted')).toHaveLength(0);
  expect(await axe(messagesEl)).toHaveNoViolations();
  renderer.dispose();
});

it('keeps separate completed turns with timestamps in their own action rows', () => {
  const { renderer, messagesEl } = setup();
  renderer.renderMessages([...messages,
    { id: 'u2', role: 'user', content: 'Next', timestamp: 6 },
    { id: 'a3', role: 'assistant', content: 'Next answer', timestamp: 7, durationSeconds: 90, completedAt: 10 },
  ], () => 'Hello');
  const headers = within(messagesEl).getAllByRole('button', { name: /Worked for/ });
  expect(headers.map(header => header.textContent)).toEqual(['Worked for 01:05', 'Worked for 01:30']);
  const times = messagesEl.querySelectorAll('.claudian-message-timestamp');
  expect(times).toHaveLength(4);
  for (const time of times) expect(time.parentElement!.lastElementChild).toBe(time);
  renderer.dispose();
});

it.each([true, false])('keeps the final answer visible with fallback tools (content blocks: %s)', async (withBlocks) => {
  const { renderer, messagesEl } = setup();
  renderer.renderStoredMessage({
    id: 'fallback', role: 'assistant', content: 'The final answer.', timestamp: 10, durationSeconds: 5,
    ...(withBlocks ? { contentBlocks: [{ type: 'text' as const, content: 'The final answer.' }] } : {}),
    toolCalls: [{ id: 'read', name: 'Read', input: { file_path: 'README.md' }, status: 'completed', result: 'File contents' }],
  });
  await Promise.resolve();
  const header = within(messagesEl).getByRole('button', { name: 'Worked for 00:05' });
  const history = document.getElementById(header.getAttribute('aria-controls')!)!;
  expect(history.textContent).not.toContain('The final answer.');
  expect(within(messagesEl).getByText('The final answer.').closest('[hidden]')).toBeNull();
  expect(history.querySelector('.claudian-tool-call')).not.toBeNull();
  fireEvent.click(within(messagesEl).getByRole('button', { name: 'Copy message' }));
  await Promise.resolve();
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith('The final answer.');
  renderer.dispose();
});

it.each(['claude', 'codex'])('folds a replayed %s interruption under one disclosure headed by its marker', async provider => {
  const { renderer, messagesEl } = setup();
  const read: ToolCallInfo = { id: 'read', name: 'Read', input: { file_path: 'note.md' }, status: 'completed', result: 'Note' };
  const interrupted: ChatMessage = { id: 'interrupted', role: 'assistant', content: 'Partial answer', timestamp: 3,
    assistantMessageId: 'native-interrupted', toolCalls: [read], contentBlocks: [
      { type: 'thinking', content: 'Still working' },
      { type: 'tool_use', toolId: 'read' },
      { type: 'text', content: 'Partial answer' },
    ] };
  // Claude JSONL records a user-role bracket marker; Codex records an aborted turn as an empty assistant bubble.
  const marker: ChatMessage = provider === 'claude'
    ? { id: 'marker', role: 'user', content: '[Request interrupted by user]', timestamp: 4, isInterrupt: true }
    : { id: 'marker', role: 'assistant', content: '', timestamp: 4, isInterrupt: true };
  renderer.renderMessages([
    messages[0],
    provider === 'codex' ? { ...interrupted, durationSeconds: 9 } : interrupted,
    marker,
    { id: 'u2', role: 'user', content: 'Next prompt', timestamp: 5 },
    { id: 'a3', role: 'assistant', content: 'Next answer', timestamp: 6, durationSeconds: 3, completedAt: 7,
      assistantMessageId: 'native-a3',
      contentBlocks: [{ type: 'thinking', content: 'Next work' }, { type: 'text', content: 'Next answer' }] },
  ], () => 'Hello');
  await Promise.resolve();

  // An interrupted turn has no answer to copy or fork from; the completed turn keeps both.
  const actions = (id: string) => within(messagesEl.querySelector<HTMLElement>(`[data-message-id="${id}"]`)!)
    .queryAllByRole('button', { name: /^(Copy message|Fork conversation)$/ }).map(button => button.getAttribute('aria-label'));
  expect(actions('interrupted')).toEqual([]);
  expect(actions('a3')).toEqual(['Copy message', 'Fork conversation']);

  expect(Array.from(messagesEl.querySelectorAll<HTMLElement>('.claudian-message'), el => el.dataset.messageId))
    .toEqual(['u1', 'interrupted', 'u2', 'a3']);
  const header = within(messagesEl).getByRole('button', { name: INTERRUPTED });
  expect(header.getAttribute('type')).toBe('button');
  expect(header.getAttribute('aria-expanded')).toBe('false');
  const history = document.getElementById(header.getAttribute('aria-controls')!)!;
  const turn = messagesEl.querySelector<HTMLElement>('[data-message-id="interrupted"] .claudian-message-content')!;
  expect(Array.from(turn.querySelectorAll<HTMLElement>(':scope > * > :not([hidden])'))).toEqual([header]);
  expect(messagesEl.querySelectorAll('.claudian-interrupted')).toHaveLength(1);
  expectInterruptHeader(header, history);
  expect(within(messagesEl).getByText('Partial answer').closest('[hidden]')).toBe(history);
  expect(history.lastElementChild!.contains(within(messagesEl).getByText('Partial answer'))).toBe(true);
  expect(within(messagesEl).getByRole('button', { name: 'Worked for 00:03' })).toBeDefined();
  expect(within(messagesEl).getByText('Next answer').closest('[hidden]')).toBeNull();

  header.focus();
  expect(document.activeElement).toBe(header);
  fireEvent.click(header);
  expect(header.getAttribute('aria-expanded')).toBe('true');
  expect(history.hidden).toBe(false);
  const tool = within(history).getByRole('button', { name: /Read.*note\.md/ });
  const thinking = within(history).getByRole('button', { name: 'Thought' });
  expect(thinking.compareDocumentPosition(tool) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect((await axe(messagesEl)).violations).toEqual([]);
  fireEvent.click(header);
  expect(history.hidden).toBe(true);
  renderer.dispose();
});

it('keeps a bare interrupt marker visible when its turn produced no output', () => {
  const { renderer, messagesEl } = setup();
  renderer.renderMessages([
    messages[0],
    { id: 'marker', role: 'user', content: '[Request interrupted by user]', timestamp: 4, isInterrupt: true },
  ], () => 'Hello');
  expect(within(messagesEl).queryByRole('button', { name: /^Interrupted/ })).toBeNull();
  expect(within(messagesEl).getByText('Interrupted').closest('[hidden]')).toBeNull();
  renderer.dispose();
});

it('offers fork on the final live response of a multi-message turn', async () => {
  const { renderer, messagesEl, fork } = setup();
  for (const message of messages) {
    const el = renderer.addMessage(message);
    if (message.role === 'assistant') {
      const text = el.querySelector('.claudian-message-content')!.createDiv({ cls: 'claudian-text-block' });
      await renderer.renderContent(text, message.content);
    }
  }
  renderer.finalizeResponse(messages[2], messages);
  const response = messagesEl.querySelector<HTMLElement>('[data-message-id="a2"]')!;
  fireEvent.click(within(response).getByRole('button', { name: 'Fork conversation' }));
  await Promise.resolve();
  expect(fork).toHaveBeenCalledWith('a2');
  renderer.dispose();
});

it('shows one task notification disclosure between the initial and automatic replies', async () => {
  const { renderer, messagesEl } = setup();
  renderer.renderMessages([
    { id: 'initial', role: 'assistant', content: 'Waiting for completion.', timestamp: 1,
      durationSeconds: 5, contentBlocks: [{ type: 'text', content: 'Waiting for completion.' }] },
    { id: 'automatic', role: 'assistant', isAutomaticResponse: true, content: 'The sleep finished successfully.', timestamp: 25,
      contentBlocks: [
        { type: 'task_notification', content: 'Background command completed (exit code 0).' },
        { type: 'thinking', content: 'Check the completed task.' },
        { type: 'text', content: 'The sleep finished successfully.' },
      ] },
  ], () => 'Hello');
  await Promise.resolve();

  const header = within(messagesEl).getByRole('button', { name: 'Task notification' });
  expect(header.getAttribute('type')).toBe('button');
  expect(header.getAttribute('aria-expanded')).toBe('false');
  const result = within(messagesEl).getByText('Background command completed (exit code 0).');
  expect(result.closest('[hidden]')).not.toBeNull();
  expect(within(messagesEl).getByText('Waiting for completion.').closest('[hidden]')).toBeNull();
  expect(within(messagesEl).getByText('The sleep finished successfully.').closest('[hidden]')).toBeNull();
  expect(within(messagesEl).getAllByRole('button', { name: /^Worked/ })).toHaveLength(1);
  expect(within(messagesEl).getByRole('button', { name: 'Worked for 00:05' })).toBeDefined();
  fireEvent.click(header);
  expect(result.closest('[hidden]')).toBeNull();
  expect(header.getAttribute('aria-expanded')).toBe('true');
  fireEvent.click(header);
  expect(result.closest('[hidden]')).not.toBeNull();
  header.focus();
  expect(document.activeElement).toBe(header);
  expect((await axe(messagesEl)).violations).toEqual([]);
  renderer.dispose();
});

it('folds requested commentary and its notification together before the final answer', async () => {
  const { renderer, messagesEl } = setup();
  renderer.renderStoredMessage({
    id: 'requested-with-notification', role: 'assistant', timestamp: 1,
    content: 'Initial reply.\n\nFollow-up reply.', durationSeconds: 5,
    contentBlocks: [
      { type: 'thinking', content: 'Initial reasoning.' },
      { type: 'text', content: 'Initial reply.' },
      { type: 'task_notification', content: 'The background result.' },
      { type: 'text', content: 'Follow-up reply.' },
    ],
  });
  await Promise.resolve();
  const work = within(messagesEl).getByRole('button', { name: 'Worked for 00:05' });
  const notification = within(messagesEl).getByRole('button', { name: 'Task notification', hidden: true });
  expect(notification.closest('[hidden]')).not.toBeNull();
  expect(within(messagesEl).getByText('Initial reply.').closest('[hidden]')).not.toBeNull();
  expect(within(messagesEl).getByText('Follow-up reply.').closest('[hidden]')).toBeNull();
  fireEvent.click(work);
  expect(within(messagesEl).getByText('Initial reasoning.').closest('[hidden]')).toBeNull();
  expect(within(messagesEl).getByText('Initial reply.').closest('[hidden]')).toBeNull();
  expect(within(messagesEl).getByText('Initial reply.').compareDocumentPosition(notification) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(notification.closest('[hidden]')).toBeNull();
  renderer.dispose();
});

it('nests a notification before the first output inside the requested work disclosure', async () => {
  const { renderer, messagesEl } = setup();
  renderer.renderStoredMessage({
    id: 'requested-after-notification', role: 'assistant', timestamp: 1,
    content: 'The requested answer.', durationSeconds: 5,
    contentBlocks: [
      { type: 'task_notification', content: 'Old task result.' },
      { type: 'thinking', content: 'Reasoning about the new request.' },
      { type: 'text', content: 'The requested answer.' },
    ],
  });
  await Promise.resolve();
  const notification = within(messagesEl).getByRole('button', { name: 'Task notification', hidden: true });
  const work = within(messagesEl).getByRole('button', { name: 'Worked for 00:05' });
  expect(notification.closest('[hidden]')).not.toBeNull();
  expect(within(messagesEl).getByText('Reasoning about the new request.').closest('[hidden]')).not.toBeNull();
  fireEvent.click(work);
  expect(within(messagesEl).getByText('Reasoning about the new request.').closest('[hidden]')).toBeNull();
  expect(within(messagesEl).getByText('Old task result.').closest('[hidden]')).not.toBeNull();
  fireEvent.click(notification);
  expect(within(messagesEl).getByText('Old task result.').closest('[hidden]')).toBeNull();
  expect(within(messagesEl).getByText('The requested answer.').closest('[hidden]')).toBeNull();
  renderer.dispose();
});

it('finalizes each automatic response when multiple task notifications arrive consecutively', async () => {
  const { renderer, messagesEl } = setup();
  renderer.renderMessages([
    { id: 'first-automatic', role: 'assistant', isAutomaticResponse: true, timestamp: 1, content: 'First follow-up.',
      contentBlocks: [
        { type: 'task_notification', content: 'First result.' },
        { type: 'thinking', content: 'Processing the first result.' },
        { type: 'text', content: 'First follow-up.' },
      ] },
    { id: 'second-automatic', role: 'assistant', isAutomaticResponse: true, timestamp: 2, content: 'Second follow-up.',
      contentBlocks: [
        { type: 'task_notification', content: 'Second result.' },
        { type: 'text', content: 'Second follow-up.' },
      ] },
  ], () => 'Hello');
  await Promise.resolve();
  expect(within(messagesEl).getAllByRole('button', { name: 'Task notification' })).toHaveLength(2);
  expect(within(messagesEl).getByText('Processing the first result.').closest('[hidden]')).not.toBeNull();
  expect(within(messagesEl).getByText('First follow-up.').closest('[hidden]')).toBeNull();
  expect(within(messagesEl).getByText('Second follow-up.').closest('[hidden]')).toBeNull();
  renderer.dispose();
});

it('keeps requested work on both sides of a mid-response notification in its own disclosure', async () => {
  const { renderer, messagesEl } = setup();
  renderer.renderStoredMessage({
    id: 'requested-mid-response', role: 'assistant', timestamp: 1,
    content: 'The requested answer.', durationSeconds: 5,
    contentBlocks: [
      { type: 'thinking', content: 'Work before notification.' },
      { type: 'task_notification', content: 'Old task result.' },
      { type: 'thinking', content: 'Work after notification.' },
      { type: 'text', content: 'The requested answer.' },
    ],
  });
  await Promise.resolve();
  expect(within(messagesEl).getByText('Work after notification.').closest('[hidden]')).not.toBeNull();
  fireEvent.click(within(messagesEl).getByRole('button', { name: 'Worked for 00:05' }));
  fireEvent.click(within(messagesEl).getByRole('button', { name: 'Task notification' }));
  expect(within(messagesEl).getByText('Old task result.').closest('[hidden]')).toBeNull();
  expect(within(messagesEl).getByText('Work before notification.').closest('[hidden]')).toBeNull();
  expect(within(messagesEl).getByText('Work after notification.').closest('[hidden]')).toBeNull();
  renderer.dispose();
});

it.each(['codex'])('shows native throughput for %s on replay', async (provider) => {
  const { renderer, messagesEl } = setup(provider);
  const response = { ...messages[2], turnStats: { outputTokens: 125, durationMs: 2500 } };
  renderer.renderMessages([messages[0], response], () => 'Hello');
  const stat = within(messagesEl).getByText('50.0 tok/s');
  expect(stat.parentElement).toBe(within(messagesEl).getAllByRole('button', { name: 'Copy message' }).at(-1)!.parentElement);
  // Obsidian renders aria-label tooltips; a title would add a duplicate browser tooltip.
  expect(stat.getAttribute('aria-label')).toBe('125 tokens · 2.5s');
  expect(stat.hasAttribute('title')).toBe(false);
  expect((await axe(messagesEl)).violations).toEqual([]);
  renderer.dispose();
});

it.each([
  ['codex', undefined],
])('omits unavailable or unsupported throughput (%s, %j)', (provider, turnStats) => {
  const { renderer, messagesEl } = setup(provider as string);
  renderer.renderMessages([messages[0], { ...messages[2], turnStats } as ChatMessage], () => 'Hello');
  expect(within(messagesEl).queryByText(/tok\/s/)).toBeNull();
  renderer.dispose();
});

it.each([
  [2888, 118846, '24.3 tok/s', '1m 58.8s'],
  [300, 119960, '2.5 tok/s', '2m 0s'],
  [90, 3000, '30.0 tok/s', '3s'],
])('summarizes %i tokens over %ims in the tooltip', (outputTokens, durationMs, rate, durationLabel) => {
  const { renderer, messagesEl } = setup();
  renderer.renderMessages([messages[0], { ...messages[2], turnStats: { outputTokens, durationMs } }], () => 'Hello');
  expect(within(messagesEl).getByText(rate).getAttribute('aria-label')).toBe(outputTokens.toLocaleString() + ' tokens · ' + durationLabel);
  renderer.dispose();
});

it('keeps time after throughput', () => {
  const { renderer, messagesEl } = setup();
  renderer.renderMessages([messages[0], { ...messages[2], turnStats: { outputTokens: 158, durationMs: 10000 } }], () => 'Hello');
  const stat = within(messagesEl).getByText('15.8 tok/s');
  const toolbar = stat.parentElement!;
  const copy = within(toolbar).getByRole('button', { name: 'Copy message' });
  const fork = within(toolbar).getByRole('button', { name: 'Fork conversation' });
  expect(Array.from(toolbar.children)).toEqual([copy, fork, stat, toolbar.querySelector('.claudian-message-timestamp')]);
  renderer.dispose();
});

it('defers Markdown for collapsed thinking and notifications until their own disclosure opens', async () => {
  const { renderer, messagesEl } = setup();
  vi.mocked(MarkdownRenderer.render).mockClear();
  renderer.renderStoredMessage({ id: 'lazy', role: 'assistant', timestamp: testDate().getTime(), content: 'Answer',
    contentBlocks: [{ type: 'thinking', content: '**Reasoning**' },
      { type: 'task_notification', content: '**Notification**' }, { type: 'text', content: 'Answer' }],
  });
  expect(vi.mocked(MarkdownRenderer.render).mock.calls.map(call => call[1])).toEqual(['Answer']);
  fireEvent.click(within(messagesEl).getByRole('button', { name: 'Worked' }));
  const thinking = within(messagesEl).getByRole('button', { name: 'Thought' });
  fireEvent.keyDown(thinking, { key: 'Enter' });
  const notification = within(messagesEl).getByRole('button', { name: 'Task notification' });
  fireEvent.click(notification);
  fireEvent.click(notification);
  fireEvent.click(notification);
  await Promise.resolve();
  expect(vi.mocked(MarkdownRenderer.render).mock.calls.map(call => call[1])).toEqual(['Answer', '**Reasoning**', '**Notification**']);
  expect((await axe(messagesEl)).violations).toEqual([]);
  renderer.dispose();
});

it('reuses created message elements instead of searching the growing history for each response', () => {
  const { renderer, messagesEl } = setup();
  const query = vi.spyOn(messagesEl, 'querySelector');
  const history: ChatMessage[] = Array.from({ length: 100 }, (_, index) => ({
    id: `indexed-${index}`, role: index % 2 ? 'assistant' : 'user', content: `Message ${index}`, timestamp: testDate().getTime(),
  }));
  // The renderer may search copies of the history too, so watch every array of its length.
  const positionLookup = vi.spyOn(Array.prototype, 'indexOf');
  renderer.renderMessages(history, () => 'Hello');
  renderer.revealEarlierMessages(true);
  const historyLookups = positionLookup.mock.contexts.filter(context => Array.isArray(context) && context.length === history.length);
  positionLookup.mockRestore();
  expect(historyLookups).toHaveLength(0);
  expect(query.mock.calls.filter(([selector]) => selector.includes('data-message-id') || selector.includes('data-work-message-id'))).toHaveLength(0);
  expect(messagesEl.querySelectorAll('.claudian-message')).toHaveLength(100);
  renderer.dispose();
});

it.each([65, undefined])('localizes completed work disclosures (duration: %s)', async durationSeconds => {
  const englishLabel = durationSeconds === undefined ? t('chat.worked') : t('chat.workedFor', { duration: '01:05' });
  setLocale('zh-CN');
  const { renderer, messagesEl } = setup();
  try {
    const expectedLabel = durationSeconds === undefined ? t('chat.worked') : t('chat.workedFor', { duration: '01:05' });
    expect(expectedLabel).not.toBe(englishLabel);
    renderer.renderMessages([...messages.slice(0, 2), { ...messages[2], durationSeconds }], () => 'Hello');
    await Promise.resolve();
    const header = within(messagesEl).getByRole('button', { name: expectedLabel });
    expect(header.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(within(messagesEl).getByText('Fixed the bug.')).toBeDefined();
  } finally {
    renderer.dispose();
    setLocale('en');
  }
});

it('localizes task notifications and thinking while preserving message content', async () => {
  const englishTaskNotification = t('chat.taskNotification');
  setLocale('zh-CN');
  const { renderer, messagesEl } = setup();
  try {
    expect(t('chat.taskNotification')).not.toBe(englishTaskNotification);
    renderer.renderMessages([{
      id: 'notification', role: 'assistant', isAutomaticResponse: true,
      content: 'Task completed.', timestamp: testDate().getTime(),
      contentBlocks: [
        { type: 'task_notification', content: 'Background command completed.' },
        { type: 'thinking', content: 'Check the result.' },
        { type: 'text', content: 'Task completed.' },
      ],
    }], () => 'Hello');
    await Promise.resolve();
    fireEvent.click(within(messagesEl).getByRole('button', { name: t('chat.taskNotification') }));
    expect(within(messagesEl).getByText('Background command completed.')).toBeDefined();
    expect(within(messagesEl).getByRole('button', { name: t('chat.thinking.label') })).toBeDefined();
    expect(within(messagesEl).getByText('Task completed.')).toBeDefined();
  } finally {
    renderer.dispose();
    setLocale('en');
  }
});

it.each(['pending', 'expired'] as const)('localizes async question card chrome (%s)', async questionStatus => {
  const statusKey = questionStatus === 'pending' ? 'chat.questions.answerBelow' : 'chat.questions.expired';
  const englishStatus = t(statusKey);
  setLocale('zh-CN');
  const { renderer, messagesEl } = setup('codex');
  try {
    expect(t(statusKey)).not.toBe(englishStatus);
    const tool: ToolCallInfo = {
      id: 'async-question', name: 'AskUserQuestion', status: 'completed', questionStatus,
      input: { replyMode: 'user-message', questions: [{ question: 'Which check?', options: [{ label: 'Lint' }] }] },
    };
    renderer.renderStoredMessage({
      id: 'question-message', role: 'assistant', content: '', timestamp: testDate().getTime(), toolCalls: [tool],
    });
    await Promise.resolve();
    expect(within(messagesEl).getByText(t(statusKey))).toBeDefined();
    expect(within(messagesEl).getByText('Which check?')).toBeDefined();
    expect(within(messagesEl).getByText('Lint')).toBeDefined();
  } finally {
    renderer.dispose();
    setLocale('en');
  }
});

it('localizes citation disclosure names through expansion and collapse', async () => {
  const englishMemoryUsed = t('chat.citations.memoryUsed');
  setLocale('zh-CN');
  const { renderer, messagesEl } = setup('codex');
  try {
    expect(t('chat.citations.memoryUsed')).not.toBe(englishMemoryUsed);
    renderer.renderStoredMessage({
      id: 'cited', role: 'assistant', content: '', timestamp: testDate().getTime(),
      contentBlocks: [{ type: 'citations', citations: { kind: 'memory', entries: [{ path: 'MEMORY.md', lineStart: 1, lineEnd: 1, note: 'Provider note' }] } }],
    });
    await Promise.resolve();
    const baseLabel = `${t('chat.citations.memoryUsed')}, ${t('chat.citations.source', { count: 1 })}`;
    const header = within(messagesEl).getByRole('button', { name: t('chat.disclosure.expand', { label: baseLabel }) });
    fireEvent.click(header);
    expect(within(messagesEl).getByRole('button', { name: t('chat.disclosure.collapse', { label: baseLabel }) })).toBe(header);
    expect(within(messagesEl).getByText('MEMORY.md:1')).toBeDefined();
    fireEvent.click(header);
    expect(within(messagesEl).getByRole('button', { name: t('chat.disclosure.expand', { label: baseLabel }) })).toBe(header);
    expect(await axe(messagesEl)).toHaveNoViolations();
  } finally {
    renderer.dispose();
    setLocale('en');
  }
});
