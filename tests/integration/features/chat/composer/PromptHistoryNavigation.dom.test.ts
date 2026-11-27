/** @vitest-environment jsdom */
import '@test/helpers/registeredCodex';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { axe } from '@test/helpers/accessibility';
import { codexCatalogFixture } from '@test/helpers/codexModels';
import { createFeatureHostFixture } from '@test/helpers/FeatureHostFixture';
import { createChatFeatureHost } from '@test/helpers/features/chat/ChatFeatureHostFixture';
import { createClaudianView } from '@test/helpers/features/chat/ClaudianViewHarness';
import { createSessionRuntimePool } from '@test/helpers/features/chat/SessionRuntimePoolHarness';
import { FakeSideBackend } from '@test/helpers/features/chat/SideChatSessionHarness';
import { testDate } from '@test/helpers/testClock';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { App, Component } from 'obsidian';

import { ChatModelSelectionCoordinator } from '@/app/settings/ChatModelSelectionCoordinator';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { type ChatMessage, type ClaudianSettings, type Conversation } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { activateTab, destroyTab } from '@/features/chat/tabs/TabLifecycle';
import { TabManager } from '@/features/chat/tabs/TabManager';
import { createTabRuntime } from '@/features/chat/tabs/TabRuntimeFactory';
import { VaultMentionDataProvider } from '@/shared/mention/VaultMentionDataProvider';

const { Scope: HostScope } = await vi.importActual<typeof import('@test/__mocks__/obsidian')>('obsidian');

const originalResizeObserver = globalThis.ResizeObserver;
const hiddenStyle = document.head.appendChild(document.createElement('style'));
hiddenStyle.textContent = readFileSync(join(process.cwd(), 'src/style/base/visibility.css'), 'utf8');
afterAll(() => hiddenStyle.remove());
beforeEach(() => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => null });

});
afterEach(() => {
  globalThis.ResizeObserver = originalResizeObserver;
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

async function createView(provisional = false, options: { managed?: boolean; draft?: boolean } = {}) {
  vi.spyOn(ProviderRegistry.getConversationHistoryService('codex'), 'buildForkProviderState').mockImplementation(async (sessionId, resumeAt) => ({ forkSource: { sessionId, resumeAt } }));
  const backend = new FakeSideBackend();
  vi.spyOn(ProviderRegistry, 'createExecutionBackend').mockReturnValue(backend);
  const app = new App();
  Object.assign(app.vault.adapter, { basePath: '/vault' });
  const settings = {
    model: 'gpt-5.5', effortLevel: 'high', permissionMode: 'manual',
    enableAutoTitleGeneration: false, excludedTags: [], mediaFolder: '', systemPrompt: '', userName: '',
    providerConfigs: { codex: {
      ...codexCatalogFixture(['gpt-5.5'], ['low', 'high']), promptSuggestions: true,
    } },
  } as unknown as ClaudianSettings;
  const conversation = {
    id: 'conversation-1', providerId: 'codex', selectedModel: 'gpt-5.5',
    sessionId: 'main-session', messages: [], title: 'Existing conversation',
    createdAt: testDate().getTime(), lastActivityAt: testDate().getTime(),
  } as unknown as Conversation;
  const saved: unknown[] = [];
  const conversations = new Map([
    [conversation.id, conversation],
    ['other-conversation', { ...conversation, id: 'other-conversation', sessionId: 'other-session' }],
  ]);
  const fixture = await createFeatureHostFixture({ app, settings, providerOverrides: {
    getResolvedProviderCliPath: async () => '/bin/claude',
  } });
  const pool = createSessionRuntimePool(() => plugin);
  const plugin: ChatFeatureHost = await createChatFeatureHost({ fixture, sessionRuntimes: pool,

    executionPersistence: {
      registerExecutionBinding() {}, releaseExecutionBinding() {},
      assertConversationExecutionAuthority: async () => {},
      persistExecutionSnapshot: async (...args: unknown[]) => { saved.push(structuredClone(args)); return true; },
      recordConversationActivity: async () => {},
    },
    getConversationSummary: (id: string) => conversations.get(id) ?? null,

    getConversationSync: (id: string) => conversations.get(id) ?? null,
    getCachedConversation: (id: string) => conversations.get(id) ?? null,
    getConversationById: async (id: string) => conversations.get(id) ?? null,
    getConversationList: () => [{ ...conversation, messageCount: conversation.messages.length, preview: '' }], renameConversation: async () => {},
    updateConversation: async (_id, patch) => { saved.push(structuredClone(patch)); },
    chatModelSelection: new ChatModelSelectionCoordinator(fixture.coordinator),
  });
  const component = new Component();
  const containerEl = document.body.createDiv();
  const manager = options.managed ? new TabManager(plugin, containerEl, component as never, {}, new VaultMentionDataProvider(app)) : null;
  const tab = manager ? (await manager.createTab(conversation.id))! : await createTabRuntime({
    plugin, conversation: options.draft ? undefined : conversation, component, containerEl,
    mentionDataProvider: new VaultMentionDataProvider(app), getProviderCatalogConfig: () => null,
    isRuntimeLive: () => true, lifecycleState: provisional ? 'provisional' : 'open',
    openConversation: async () => {}, startNewConversation: async () => {},
  });
  await tab.session.runtime.model.hydrate();
  if (!options.draft) {
    await tab.executionCoordinator.bindConversation({ conversationId: conversation.id, providerId: 'codex' });
    await tab.executionCoordinator.prepare();
  }
  vi.spyOn(tab.dom.messagesEl, 'getClientRects').mockImplementation(() =>
    (tab.dom.contentEl.classList.contains('claudian-hidden') ? [] : [{}]) as unknown as DOMRectList);
  activateTab(tab);
  tab.dom.inputEl.focus();
  return { get tab() { return manager?.getActiveTab() ?? tab; }, backend, saved, conversation, manager, plugin,
    dispose: async () => { if (manager) await manager.destroy(); else await destroyTab(tab); await pool.dispose(); await fixture.dispose(); },
  };
}

type View = Awaited<ReturnType<typeof createView>>;
function textbox(view: View): HTMLElement { return within(view.tab.dom.inputEl).getByRole('textbox'); }
function key(view: View, name: string, options: KeyboardEventInit = {}): KeyboardEvent & { inputPrevented: boolean } {
  const event = Object.assign(new KeyboardEvent('keydown', { key: name, code: name, bubbles: true, cancelable: true, ...options }), { inputPrevented: false });
  const observe = () => { event.inputPrevented = event.defaultPrevented; };
  view.tab.dom.inputEl.addEventListener('keydown', observe, true);
  textbox(view).dispatchEvent(event);
  view.tab.dom.inputEl.removeEventListener('keydown', observe, true);
  return event;
}
function type(view: View, text: string): void {
  fireEvent.paste(textbox(view), { clipboardData: { getData: () => text, files: [] } });
}
function user(id: string, content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role: 'user', content, timestamp: testDate().getTime(), ...extra };
}

function accessibilityFingerprints(result: Awaited<ReturnType<typeof axe>>): string[] {
  const checks = (values: typeof result.violations[number]['nodes'][number]['any']) => values
    .map(check => ({ id: check.id, data: check.data })).sort((left, right) => left.id.localeCompare(right.id));
  return result.violations.flatMap(violation => violation.nodes.map(node => JSON.stringify({
    rule: violation.id, target: node.target,
    any: checks(node.any), all: checks(node.all), none: checks(node.none),
  }))).sort();
}

async function completeTurn(view: View, text: string): Promise<string> {
  type(view, text);
  const pending = view.tab.controllers.inputController.sendMessage();
  await waitFor(() => expect(view.backend.latest.getStatus()).toBe('executing'));
  const turnId = view.backend.latest.activeTurnId;
  view.backend.latest.emitText('Completed answer'); view.backend.latest.complete();
  await pending;
  return turnId;
}

it.each([false, true])('restores history before the actual View Scope consumes Escape (Main busy: %s)', async busy => {
  const view = await createView();
  let pending: Promise<void> | undefined;
  try {
    view.tab.state.messages = [user('previous', 'Previous prompt')];
    if (busy) {
      type(view, 'Running prompt');
      pending = view.tab.controllers.inputController.sendMessage();
    }
    await waitFor(() => expect(view.backend.latest.getStatus()).toBe(busy ? 'executing' : 'idle'));
    expect(view.tab.state.isStreaming).toBe(busy);
    key(view, 'ArrowUp');
    expect(view.tab.dom.inputEl.value).toBe(busy ? 'Running prompt' : 'Previous prompt');
    const native = view.backend.latest;
    const cancellations = native.cancelCalls;
    const root = await createClaudianView({ host: view.plugin, containerEl: view.tab.dom.contentEl,
      contentEl: view.tab.dom.contentEl, tabManager: { getActiveTab: () => view.tab } });
    root['wireEventHandlers']();
    assert(root.scope instanceof HostScope);
    const handler = root.scope.handlers.find(entry => entry.key === 'Escape');
    assert(handler);
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    // Obsidian consumes a false-returning Scope handler before the same event reaches the DOM.
    expect(handler.func(event, { key: 'Escape', vkey: 'Escape', modifiers: '' })).toBe(false);
    event.preventDefault();
    textbox(view).dispatchEvent(event);
    expect(view.tab.dom.inputEl.value).toBe('');
    expect(native.cancelCalls).toBe(cancellations);
    expect(native.getStatus()).toBe(busy ? 'executing' : 'idle');
    if (busy) {
      native.emitText('Completed answer'); native.complete();
      await pending;
    }
  } finally { await view.dispose(); }
});

it('recalls and resends visible user text through the real input controller and persistence port', async () => {
  const view = await createView();
  try {
    type(view, 'Earlier prompt');
    key(view, 'Enter');
    await waitFor(() => expect(view.backend.latest.requests).toHaveLength(1));
    view.backend.latest.emitText('First answer'); view.backend.latest.complete();
    await waitFor(() => expect(view.tab.state.isStreaming).toBe(false));
    expect(view.tab.dom.inputEl.value).toBe('');
    await Promise.resolve();
    const baselineAccessibility = await axe(view.tab.dom.inputComposerEl);
    expect(baselineAccessibility).toHaveNoViolations();
    expect(accessibilityFingerprints(baselineAccessibility)).toEqual([]);
    const allowedAttributes = { runOnly: { type: 'rule' as const, values: ['aria-allowed-attr'] } };
    expect(accessibilityFingerprints(await axe(view.tab.dom.inputComposerEl, allowedAttributes))).toEqual([]);
    expect(key(view, 'ArrowUp').defaultPrevented).toBe(true);
    expect(view.tab.dom.inputEl.value).toBe('Earlier prompt');
    expect(textbox(view).textContent).toBe('Earlier prompt');
    // Recall preserves the real multiline textbox and the complete composer's accessibility.
    await Promise.resolve();
    const recalledAccessibility = await axe(view.tab.dom.inputComposerEl);
    expect(recalledAccessibility).toHaveNoViolations();
    expect(accessibilityFingerprints(recalledAccessibility)).toEqual([]);
    expect(accessibilityFingerprints(await axe(view.tab.dom.inputComposerEl, allowedAttributes))).toEqual([]);
    const focusedTextbox = within(view.tab.dom.inputComposerEl).getByRole('textbox', { name: 'Message' });
    expect(within(view.tab.dom.inputComposerEl).getAllByRole('textbox')).toEqual([focusedTextbox]);
    expect(focusedTextbox).toBe(textbox(view));
    expect(focusedTextbox.getAttribute('aria-multiline')).toBe('true');
    expect(focusedTextbox.textContent).toBe('Earlier prompt');
    try {
      focusedTextbox.setAttribute('aria-checked', 'false');
      const withFault = await axe(view.tab.dom.inputComposerEl, allowedAttributes);
      expect(accessibilityFingerprints(withFault)).toEqual([JSON.stringify({
        rule: 'aria-allowed-attr', target: ['.cm-content'],
        any: [], all: [{ id: 'aria-allowed-attr', data: ['aria-checked="false"'] }], none: [],
      })]);
    } finally {
      focusedTextbox.removeAttribute('aria-checked');
    }
    expect(await axe(view.tab.dom.inputComposerEl)).toHaveNoViolations();
    view.saved.length = 0;
    key(view, 'Enter');
    await waitFor(() => expect(view.backend.latest.requests).toHaveLength(2));
    expect(view.backend.latest.requests[1].input).toEqual([{ type: 'text', text: 'Earlier prompt' }]);
    view.backend.latest.emitText('Second answer'); view.backend.latest.complete();
    await waitFor(() => expect(view.tab.state.isStreaming).toBe(false));
    expect(view.tab.state.messages.filter(message => message.role === 'user').map(message => message.content))
      .toEqual(['Earlier prompt', 'Earlier prompt']);
    await waitFor(() => expect(view.saved).toContainEqual(expect.objectContaining({ messages: expect.any(Array) })));
    const snapshots = view.saved.flatMap(value => Array.isArray(value) ? value : [value])
      .filter((value): value is { messages: ChatMessage[] } => typeof value === 'object' && value !== null
        && 'messages' in value && Array.isArray(value.messages));
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots.at(-1)!.messages.filter(message => message.role === 'user').map(message => message.content))
      .toEqual(['Earlier prompt', 'Earlier prompt']);
  } finally { await view.dispose(); }
});

it('navigates in order, leaves the oldest boundary native, and restores the empty draft at the newest boundary', async () => {
  const view = await createView();
  try {
    view.tab.state.messages = [user('old', 'First\nmultiline'), user('new', 'Latest prompt')];
    expect(key(view, 'ArrowUp').inputPrevented).toBe(true);
    expect(view.tab.dom.inputEl.value).toBe('Latest prompt');
    key(view, 'ArrowUp');
    expect(view.tab.dom.inputEl.value).toBe('First\nmultiline');
    expect(key(view, 'ArrowUp').inputPrevented).toBe(false);
    expect(key(view, 'ArrowUp').inputPrevented).toBe(false);
    expect(view.tab.dom.inputEl.value).toBe('First\nmultiline');
    expect(key(view, 'ArrowDown').inputPrevented).toBe(false);
    key(view, 'ArrowDown');
    expect(view.tab.dom.inputEl.value).toBe('Latest prompt');
    expect(key(view, 'ArrowDown').inputPrevented).toBe(true);
    expect(view.tab.dom.inputEl.value).toBe('');
    expect(key(view, 'ArrowDown').inputPrevented).toBe(false);
    key(view, 'ArrowUp');
    expect(key(view, 'Escape').inputPrevented).toBe(true);
    expect(view.tab.dom.inputEl.value).toBe('');
    key(view, 'Escape');
    expect(view.tab.dom.inputEl.value).toBe('');
  } finally { await view.dispose(); }
});

it('never recalls parent or child text in Side and resets history on a real Main-Side-Main round trip', async () => {
  const view = await createView();
  try {
    await completeTurn(view, 'Parent prompt');
    const parent = view.backend.latest;
    await completeTurn(view, '/side Independent child prompt');
    expect(view.backend.sessions).toHaveLength(2);
    expect(parent.requests).toHaveLength(1);
    expect(view.tab.controllers.sideChatController.destination).toBe('side');
    expect(key(view, 'ArrowUp').inputPrevented).toBe(false);
    key(view, 'Escape');
    view.tab.dom.inputEl.focus();
    expect(view.tab.dom.inputEl.value).toBe('');
    view.tab.controllers.sideChatController.collapse();
    key(view, 'ArrowUp');
    expect(view.tab.dom.inputEl.value).toBe('Parent prompt');
    view.tab.controllers.sideChatController.expand();
    view.tab.controllers.sideChatController.collapse();
    key(view, 'Escape');
    view.tab.dom.inputEl.focus();
    expect(view.tab.dom.inputEl.value).toBe('Parent prompt');
    expect(key(view, 'ArrowDown').inputPrevented).toBe(false);
    expect(view.tab.dom.inputEl.value).toBe('Parent prompt');
    view.tab.dom.inputEl.value = ''; fireEvent.input(view.tab.dom.inputEl);
    key(view, 'ArrowUp');
    expect(view.tab.dom.inputEl.value).toBe('Parent prompt');
  } finally { await view.dispose(); }
});
