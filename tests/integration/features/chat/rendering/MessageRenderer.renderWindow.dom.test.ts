/** @vitest-environment jsdom */
import '@test/helpers/registeredCodex';

import { axe } from '@test/helpers/accessibility';
import { createChatFeatureHost } from '@test/helpers/features/chat/ChatFeatureHostFixture';
import { testDate } from '@test/helpers/testClock';
import { fireEvent, within } from '@testing-library/dom';
import { Component, MarkdownRenderer } from 'obsidian';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { ChatMessage } from '@/core/types';
import { NavigationSidebar } from '@/features/chat/navigation/NavigationSidebar';
import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';

const start = testDate().getTime();

function turn(index: number): ChatMessage[] {
  return [
    { id: `u${index}`, role: 'user', content: `Prompt ${index}`, timestamp: start + index },
    { id: `a${index}`, role: 'assistant', content: `Answer ${index}`, timestamp: start + index,
      durationSeconds: 1, completedAt: start + index, contentBlocks: [{ type: 'text', content: `Answer ${index}` }] },
  ];
}

/** 102 messages whose tail window would begin at a bare interrupt marker if cut by count alone. */
function transcript(): ChatMessage[] {
  const messages = Array.from({ length: 30 }, (_, index) => turn(index)).flat();
  messages.push(
    { id: 'u-stopped', role: 'user', content: 'Stopped prompt', timestamp: start + 30 },
    { id: 'a-stopped', role: 'assistant', content: 'Partial', timestamp: start + 30,
      contentBlocks: [{ type: 'text', content: 'Partial' }] },
    { id: 'marker', role: 'user', content: '[Request interrupted by user]', timestamp: start + 30, isInterrupt: true },
  );
  for (let index = 31; index < 50; index++) messages.push(...turn(index));
  messages.push({ id: 'u-last', role: 'user', content: 'Last prompt', timestamp: start + 50 });
  return messages;
}

async function setup(providerId?: string, navigate: (id: string, target?: string) => Promise<void> = vi.fn()) {
  const messagesEl = document.body.createDiv();
  // jsdom has no layout: a 500px viewport over top-level nodes 100px tall each.
  let scrollTop = 0;
  Object.defineProperty(messagesEl, 'scrollHeight', { configurable: true, get: () => messagesEl.children.length * 100 });
  Object.defineProperty(messagesEl, 'scrollTop', { configurable: true, get: () => scrollTop, set: value => { scrollTop = value; } });
  Object.defineProperty(messagesEl, 'clientHeight', { configurable: true, get: () => 500 });
  messagesEl.getBoundingClientRect = () => ({ top: 0, bottom: 500 }) as DOMRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const top = Array.from(messagesEl.children).indexOf(this) * 100 - scrollTop;
    return { top, bottom: top + 100 } as DOMRect;
  });
  const renderer = new MessageRenderer(
    await createChatFeatureHost({ settings: { mediaFolder: '' } }), new Component(), messagesEl, undefined, undefined,
    providerId ? () => ({ ...ProviderRegistry.getCapabilities(providerId), supportsConversationBranches: true }) : undefined,
    { navigate, isBusy: () => false },
  );
  return { renderer, messagesEl };
}

function renderedPrompts(messagesEl: HTMLElement): string[] {
  return Array.from(messagesEl.querySelectorAll<HTMLElement>('[data-role="user"] .claudian-message-content'), el => el.textContent ?? '');
}

afterEach(() => { vi.restoreAllMocks(); });

beforeEach(() => {
  document.body.replaceChildren();
  vi.mocked(MarkdownRenderer.render).mockImplementation(async (_app, markdown, el) => {
    (el as HTMLElement).createEl('p', { text: markdown });
  });
});

it('renders the latest turns first and reveals earlier turns above them in order, keeping the reading position', async () => {
  const { renderer, messagesEl } = (await setup());
  const messages = transcript();
  renderer.renderMessages(messages, () => 'Hello');

  // The window starts at the stopped turn's prompt, never at its bare marker.
  expect(renderedPrompts(messagesEl)[0]).toBe('Stopped prompt');
  expect(renderedPrompts(messagesEl)).not.toContain('Prompt 29');
  expect(Array.from(messagesEl.querySelectorAll('.claudian-message')).filter(el => !el.hasAttribute('data-message-id'))).toEqual([]);
  expect(messagesEl.querySelector('[data-message-id="a-stopped"]')?.textContent).toContain('Interrupted');

  const showEarlier = within(messagesEl).getByRole('button', { name: 'Show earlier messages' });
  expect(await axe(messagesEl)).toHaveNoViolations();
  const firstShown = messagesEl.querySelector<HTMLElement>('[data-message-id="u-stopped"]')!;
  const nodesBefore = messagesEl.children.length;
  messagesEl.scrollTop = 0;
  fireEvent.click(showEarlier);

  expect(renderedPrompts(messagesEl).slice(0, 2)).toEqual(['Prompt 10', 'Prompt 11']);
  // The prompt that was on screen stays where the reader left it.
  expect(messagesEl.scrollTop).toBe((messagesEl.children.length - nodesBefore) * 100);
  expect(messagesEl.querySelector('[data-message-id="u-stopped"]')).toBe(firstShown);

  const lastShowEarlier = within(messagesEl).getByRole('button', { name: 'Show earlier messages' });
  lastShowEarlier.focus();
  fireEvent.click(lastShowEarlier);
  expect(within(messagesEl).queryByRole('button', { name: 'Show earlier messages' })).toBeNull();
  // Keyboard focus stays in the transcript when the last reveal removes the focused control.
  expect(document.activeElement).toBe(messagesEl);
  const visiblePrompts = messages.filter(message => message.role === 'user' && !message.isInterrupt).map(message => message.content);
  expect(renderedPrompts(messagesEl)).toEqual(visiblePrompts);
  expect(Array.from(messagesEl.querySelectorAll('[data-role="assistant"]'), el => el.getAttribute('data-message-id')))
    .toEqual(messages.filter(message => message.role === 'assistant').map(message => message.id));
});

it('renders a short transcript whole without an earlier-messages control', async () => {
  const { renderer, messagesEl } = (await setup());
  const messages = Array.from({ length: 5 }, (_, index) => turn(index)).flat();
  renderer.renderMessages(messages, () => 'Hello');
  expect(renderedPrompts(messagesEl)).toHaveLength(5);
  expect(within(messagesEl).queryByRole('button', { name: 'Show earlier messages' })).toBeNull();
});

it('lists every prompt without rendering earlier bodies and reveals only through the selected prompt', async () => {
  const { renderer, messagesEl } = (await setup());
  const parent = document.body.createDiv();
  parent.append(messagesEl);
  messagesEl.scrollTo = vi.fn();
  vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (this: HTMLElement) {
    return Array.from(messagesEl.children).indexOf(this) * 100;
  });
  const messages = Array.from({ length: 60 }, (_, index) => turn(index)).flat();
  messages[20].displayContent = 'Visible prompt ten';
  renderer.renderMessages(messages, () => 'Hello');
  const sidebar = new NavigationSidebar(parent, messagesEl, () => renderer.getDirectoryEntries());
  try {
    const rendersBefore = vi.mocked(MarkdownRenderer.render).mock.calls.length;
    fireEvent.click(within(parent).getByRole('button', { name: 'Conversation directory' }));
    expect(within(parent).getAllByRole('button', { name: /^\d+\. / })).toHaveLength(60);
    expect(within(parent).getByRole('button', { name: '11. Visible prompt ten' })).toBeDefined();
    expect(vi.mocked(MarkdownRenderer.render)).toHaveBeenCalledTimes(rendersBefore);
    expect(renderedPrompts(messagesEl)).toHaveLength(20);

    fireEvent.click(within(parent).getByRole('button', { name: '11. Visible prompt ten' }));
    expect(renderedPrompts(messagesEl)[0]).toBe('Visible prompt ten');
    expect(renderedPrompts(messagesEl)).not.toContain('Prompt 9');
    const selected = messagesEl.querySelector<HTMLElement>('[data-message-id="u10"]')!;
    expect(messagesEl.scrollTo).toHaveBeenLastCalledWith({ top: Math.max(selected.offsetTop - 10, 0), behavior: 'smooth' });

    renderer.removeMessage('u3');
    renderer.removeMessage('u15');
    renderer.addMessage(turn(60)[0]);
    fireEvent.click(within(parent).getByRole('button', { name: 'Conversation directory' }));
    const labels = within(parent).getAllByRole('button', { name: /^\d+\. / }).map(button => button.textContent);
    expect(labels).toHaveLength(59);
    expect(labels).not.toContain('4. Prompt 3');
    expect(labels.some(label => label?.endsWith('. Prompt 15'))).toBe(false);
    expect(labels.at(-1)).toBe('59. Prompt 60');
  } finally {
    sidebar.destroy();
    renderer.dispose();
  }
});

it('renders an insertion beside an unrendered earlier message in transcript order', async () => {
  const { renderer, messagesEl } = (await setup());
  const messages = Array.from({ length: 30 }, (_, index) => turn(index)).flat();
  renderer.renderMessages(messages, () => 'Hello');
  expect(messagesEl.querySelector('[data-message-id="a3"]')).toBeNull();

  renderer.addMessage({ id: 'late', role: 'assistant', content: '', timestamp: start }, 'a3');
  const ids = Array.from(messagesEl.querySelectorAll('[data-message-id]'), el => el.getAttribute('data-message-id'));
  expect(ids.indexOf('late')).toBe(ids.indexOf('a3') + 1);
  expect(ids.at(-1)).toBe('a29');
});

it('keeps a message removed while unrendered out of the revealed transcript', async () => {
  const { renderer, messagesEl } = (await setup());
  const messages = Array.from({ length: 30 }, (_, index) => turn(index)).flat();
  renderer.renderMessages(messages, () => 'Hello');
  renderer.removeMessage('a3');
  renderer.revealEarlierMessages(true);
  const ids = Array.from(messagesEl.querySelectorAll('[data-message-id]'), el => el.getAttribute('data-message-id'));
  expect(ids).toEqual(messages.map(message => message.id).filter(id => id !== 'a3'));
});
