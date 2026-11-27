/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { axe } from '@test/helpers/accessibility';
import { createHarness as createExecutionHarness } from '@test/helpers/ChatExecutionHarness';
import { TEST_CODEX_CATALOG } from '@test/helpers/codexModels';
import { holdResponse } from '@test/helpers/ConversationPorts';
import { useNextTaskAnimationFrames } from '@test/helpers/dom/animationFrames';
import { triggerResize } from '@test/helpers/dom/ResizeObserver';
import { createFeatureHostFixture } from '@test/helpers/FeatureHostFixture';
import { registerChatTestProvider } from '@test/helpers/features/chat/ChatProviderFixture';
import { createClaudianView } from '@test/helpers/features/chat/ClaudianViewHarness';
import { conversationRecord as baseConversationRecord } from '@test/helpers/features/chat/ConversationFixture';
import { createSessionBrowserHost } from '@test/helpers/features/chat/SessionBrowserTestHarness';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { Menu, Scope, TFile } from 'obsidian';

import { ChatModelSelectionCoordinator } from '@/app/settings/ChatModelSelectionCoordinator';
import { TabManager } from '@/features/chat/tabs/TabManager';
import type { TabLayoutPolicy } from '@/features/chat/tabs/types';
import { ChatViewPublisher } from '@/features/chat/workspace/ChatViewPublisher';
import { setLocale } from '@/i18n/i18n';

const conversationRecord = (id: string, overrides?: Parameters<typeof baseConversationRecord>[1]) =>
  baseConversationRecord(id, { providerId: 'codex', ...overrides });

let native: ReturnType<typeof registerChatTestProvider>;
beforeEach(() => {
  useNextTaskAnimationFrames();
  native = registerChatTestProvider();
});

const { Scope: HostScope } = await vi.importActual<typeof import('@test/__mocks__/obsidian')>('obsidian');

const openedViews: Awaited<ReturnType<typeof createClaudianView>>[] = [];

async function createView(options: {
  width?: number;
  records?: ReturnType<typeof conversationRecord>[];
  fixture?: Awaited<ReturnType<typeof createFeatureHostFixture>>;
  host?: Omit<NonNullable<NonNullable<Parameters<typeof createSessionBrowserHost>[0]>['host']>, 'fixture' | 'app'>;
} = {}) {
  const records = options.records ?? ['one', 'two'].map(id => conversationRecord(id));
  const { settings, ...overrides } = options.host ?? {};
  const fixture = options.fixture ?? await createFeatureHostFixture({ settings: { restoreTabsOnStartup: true, enableAutoTitleGeneration: false, providerConfigs: { codex: { enabled: true, discoveredModels: TEST_CODEX_CATALOG } }, ...settings } });
  const { plugin, pool } = await createSessionBrowserHost({ conversations: records.map(record => ({ ...record, messageCount: 0, preview: '' })), host: {
    fixture,
    chatModelSelection: new ChatModelSelectionCoordinator(fixture.coordinator),
    executionPersistence: createExecutionHarness().repository,
    getConversationById: async id => records.find(record => record.id === id) ?? null,
    getConversationSync: id => records.find(record => record.id === id) ?? null,
    getCachedConversation: id => records.find(record => record.id === id) ?? null,
    getConversationSummary: id => records.find(record => record.id === id) ?? null,
    ensureConversationMetadataLoaded: async () => undefined,
    updateConversation: async (id, updates) => { Object.assign(records.find(record => record.id === id)!, updates); },
    ...overrides,
  } });
  const contentEl = document.body.createDiv();
  const resize = (width: number) => {
    const contentRect = new DOMRect(0, 0, width, 0);
    contentEl.getBoundingClientRect = () => contentRect;
    triggerResize(contentEl, { contentRect, borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] });
  };
  contentEl.getBoundingClientRect = () => new DOMRect(0, 0, options.width ?? 400, 0);
  const view = await createClaudianView({ host: plugin, contentEl });
  view.load();
  openedViews.push(view);
  const saved: unknown[] = [];
  const { App: HostApp } = await vi.importActual<typeof import('../../../__mocks__/obsidian')>('obsidian');
  const app = plugin.app;
  if (!(app instanceof HostApp)) throw new Error('Expected the shared Obsidian App');
  const saveLayout = vi.spyOn(app.workspace, 'saveLayout');
  saveLayout.mockImplementation(async () => { saved.push(structuredClone(view.getState())); });
  await view.onOpen();
  const manager = view.getTabManager() as TabManager;
  expect(manager).toBeInstanceOf(TabManager);
  return { view, manager, plugin, pool, contentEl, resize, saveLayout, saved, records };
}

async function openView(options: Parameters<typeof createView>[0] = {}, state: unknown = {}) {
  const fixture = await createView(options);
  await fixture.view.setState(state, { history: false });
  return fixture;
}

function workspaceState(ids = ['restored-1', 'restored-2']) {
  return { tabWorkspace: { version: 1, activeTabId: ids.at(-1), openTabs: ids.map(tabId => ({ tabId, conversationId: null })) } };
}

afterEach(async () => {
  for (const view of openedViews.splice(0)) { await view.onClose(); view.unload(); }
  document.body.replaceChildren();
  vi.restoreAllMocks();
  setLocale('en');
});

describe('ClaudianView real tab lifecycle', () => {
  it('waits for Obsidian state delivery, then restores only the selected legacy identity and publishes one composer', async () => {
    const { view, manager, contentEl } = await createView();
    expect(manager.getTabCount()).toBe(0);
    await view.setState(workspaceState(), { history: false });
    expect(manager.getTabIdentities().map(tab => tab.id)).toEqual(['restored-2']);
    expect(manager.getActiveTab()?.id).toBe('restored-2');
    expect(view.getState()).toMatchObject(workspaceState(['restored-2']));
    expect(contentEl.contains(manager.getActiveTab()!.dom.inputEl)).toBe(true);
    // Later host deliveries cannot replace already-admitted membership.
    await view.setState(workspaceState(['stale']), { history: false });
    expect(manager.getTabCount()).toBe(1);
  });

  it('still releases view and manager resources when the layout save fails', async () => {
    const { view, manager, saveLayout, plugin } = await openView();
    saveLayout.mockRejectedValue(new Error('disk full'));
    await expect(view.onClose()).resolves.toBeUndefined();
    expect(manager.getTabCount()).toBe(0);
    expect(view.getTabManager()).toBeNull();
    expect(view.scope).toBeNull();
    expect(vi.mocked(plugin.app.vault.offref).mock.calls.map(([ref]) => (ref as unknown as { name: string }).name)).toEqual(expect.arrayContaining(['create', 'delete', 'modify', 'rename']));
  });
});

describe('ClaudianView provider and presentation wiring', () => {

  it('hides and restores history without replacing the active composer when a pane resizes', async () => {
    const style = document.head.createEl('style', {
      text: readFileSync(path.resolve('src/style/components/history.css'), 'utf8'),
    });
    onTestFinished(() => style.remove());
    const { view, manager, plugin, contentEl, resize } = await openView({
      width: 400,
      host: { settings: { sessionManagerOrganization: 'list' } },
      records: [
        conversationRecord('one', { linkedContentPath: 'notes/brief.pdf' }),
        conversationRecord('two', { linkedContentPath: 'notes/brief.pdf' }),
        conversationRecord('archived', { isArchived: true }),
      ],
    });
    const brief = Object.assign(new TFile(), {
      path: 'notes/brief.pdf', extension: 'pdf', name: 'brief.pdf', basename: 'brief',
    });
    vi.spyOn(plugin.app.vault, 'getAllLoadedFiles').mockReturnValue([brief]);
    await manager.viewerSlot.show('one');
    const tab = manager.getActiveTab()!;
    const composer = tab.dom.inputComposerEl;
    const history = contentEl.querySelector<HTMLElement>('.claudian-session-sidebar')!;
    expect(history?.querySelector('.claudian-session-surface')).not.toBeNull();
    expect(contentEl.classList.contains('claudian-session-sidebar-left')).toBe(false);
    expect(contentEl.querySelector('.claudian-active-input-slot')?.contains(composer)).toBe(true);

    tab.dom.inputEl.value = 'Unsent draft';
    const chat = contentEl.querySelector<HTMLElement>('.claudian-chat-panel')!;
    tab.dom.messagesEl.scrollTop = 120;
    const historyToggle = within(contentEl).getByRole('button', { name: 'Conversation history' });
    expect(historyToggle.getAttribute('aria-controls')).toBe(history.id);
    expect(historyToggle.getAttribute('aria-expanded')).toBe('false');
    expect(getComputedStyle(history).display).toBe('none');
    const footer = within(tab.dom.infoRowEl);
    expect(footer.getByText('brief.pdf')).toBeTruthy();
    const actionNames = ['New chat', 'Conversation history', 'More chat actions'];
    expect(footer.queryByRole('button', { name: 'Search sessions' })).toBeNull();
    for (const name of actionNames) {
      const button = footer.getByRole('button', { name });
      expect(button.parentElement).toBe(tab.dom.infoRowEl);
      expect(button.textContent).toBe('');
      expect(within(contentEl).getAllByRole('button', { name })).toEqual([button]);
    }

    fireEvent.click(historyToggle);
    expect(historyToggle.getAttribute('aria-expanded')).toBe('true');
    expect(getComputedStyle(history).display).toBe('flex');
    expect(chat.hasAttribute('inert')).toBe(true);
    expect(getComputedStyle(chat).visibility).toBe('hidden');
    // The floating transcript navigation sets its own visibility, so hide the whole chat as a layer.
    expect(getComputedStyle(chat).opacity).toBe('0');
    expect(document.activeElement).toBe(within(history).getByRole('searchbox', { name: 'Search sessions' }));
    expect(within(history).queryByText('History', { exact: true })).toBeNull();
    expect(within(history).queryByRole('button', { name: 'Search sessions' })).toBeNull();
    expect(within(history).getAllByText('brief.pdf')).toHaveLength(2);
    expect(within(history).getByRole('button', { name: 'two brief.pdf' })).toBeTruthy();
    const rowActions = within(history).getByRole('button', { name: 'Actions for two' });
    expect(getComputedStyle(rowActions.parentElement!).opacity).toBe('0');
    expect(within(history).queryByRole('button', { name: 'Archive' })).toBeNull();

    resize(0);
    expect(history.hidden).toBe(false);
    expect(view.getActiveTab()).toBe(tab);
    resize(800);
    expect(history.hidden).toBe(false);
    expect(chat.hasAttribute('inert')).toBe(false);
    expect(getComputedStyle(chat).visibility).toBe('visible');
    expect(within(history).getByRole('searchbox', { name: 'Search sessions' })).toBeTruthy();
    resize(350);
    expect(chat.hasAttribute('inert')).toBe(true);
    fireEvent.click(within(contentEl).getByRole('button', { name: 'Back to conversation' }));
    expect(historyToggle.getAttribute('aria-expanded')).toBe('false');
    expect(getComputedStyle(history).display).toBe('none');
    expect(chat.hasAttribute('inert')).toBe(false);
    expect(view.getActiveTab()).toBe(tab);
    expect(contentEl.querySelector('.claudian-active-input-slot')?.contains(composer)).toBe(true);
    expect(tab.dom.inputEl.value).toBe('Unsent draft');
    expect(tab.dom.messagesEl.scrollTop).toBe(120);

    fireEvent.click(historyToggle);
    const search = within(history).getByRole('searchbox', { name: 'Search sessions' });
    expect(document.activeElement).toBe(search);
    fireEvent.input(search, { target: { value: 'two' } });
    expect(within(history).getByRole('searchbox')).toBe(search);
    expect(within(history).queryByText('one')).toBeNull();
    fireEvent.click(within(history).getByRole('button', { name: 'two brief.pdf' }));
    await waitFor(() => expect(history.hidden).toBe(true));
    expect(view.getActiveTab()?.conversationId).toBe('two');

    const nextFooter = within(manager.getActiveTab()!.dom.infoRowEl);
    expect(nextFooter.getByRole('button', { name: 'Conversation history' })).toBe(historyToggle);
    fireEvent.click(nextFooter.getByRole('button', { name: 'More chat actions' }));
    const menu = (Menu as typeof Menu & {
      instances: Array<{ items: Array<{ title: string; clickHandler?: () => void }>; hide(): void }>;
    }).instances.at(-1)!;
    menu.items.find(item => item.title === 'Archive')?.clickHandler?.();
    menu.hide();
    expect(within(history).getByRole('searchbox', { name: 'Search archived sessions' })).toBe(search);
    expect(within(history).getByText('Archive', { exact: true })).toBeTruthy();
    expect(within(history).getByText('archived')).toBeTruthy();
    expect(within(history).queryByText('two')).toBeNull();
    fireEvent.click(within(history).getByRole('button', { name: 'Back to conversation' }));
    fireEvent.click(nextFooter.getByRole('button', { name: 'New chat' }));
    await waitFor(() => expect(view.getActiveTab()?.conversationId).toBeNull());
  });

  it('toggles linked-content groups without clearing the history search', async () => {
    const publisher = new ChatViewPublisher({
      views: { getAllViews: () => openedViews },
      fontScale: { reconcile: vi.fn() },
      inactiveSessions: { request: vi.fn() },
      hasLoadedAllSessionMetadata: () => false,
    });
    const fixture = await createFeatureHostFixture({
      settings: { sessionManagerOrganization: 'list' },
      afterPublish: (settings, previous) => publisher.publishSettings(settings, previous),
    });
    const { contentEl, plugin, resize } = await openView({
      width: 400,
      fixture,
      records: [
        conversationRecord('review one', { linkedContentPath: 'brief.pdf' }),
        conversationRecord('review two', { linkedContentPath: 'brief.pdf' }),
        conversationRecord('unrelated', { linkedContentPath: 'brief.pdf' }),
      ],
    });
    const brief = Object.assign(new TFile(), { path: 'brief.pdf', extension: 'pdf', name: 'brief.pdf' });
    const lookup = plugin.app.vault.getAbstractFileByPath.bind(plugin.app.vault);
    vi.spyOn(plugin.app.vault, 'getAbstractFileByPath').mockImplementation(path => (
      path === brief.path ? brief : lookup(path)
    ));
    const ui = within(contentEl);
    fireEvent.click(ui.getByRole('button', { name: 'Conversation history' }));
    const search = ui.getByRole('searchbox', { name: 'Search sessions' }) as HTMLInputElement;
    fireEvent.input(search, { target: { value: 'review' } });
    const toggle = ui.getByRole('button', { name: 'Group by linked content', pressed: false });
    expect(ui.queryByRole('button', { name: /^brief\.pdf/, expanded: true })).toBeNull();

    fireEvent.click(toggle);
    const group = await waitFor(() => ui.getByRole('button', { name: /^brief\.pdf/, expanded: true }));
    expect(ui.getByRole('button', { name: 'Group by linked content', pressed: true })).toBe(toggle);
    expect((await axe(toggle, { runOnly: ['button-name', 'aria-valid-attr-value'] })).violations).toEqual([]);
    expect(search.value).toBe('review');
    expect(ui.queryByText('unrelated')).toBeNull();
    fireEvent.click(group);
    expect(ui.queryByRole('button', { name: /^review one/ })).toBeNull();
    expect(ui.queryByRole('button', { name: /^review two/ })).toBeNull();

    resize(800);
    expect(ui.getByRole('button', { name: 'Group by linked content', pressed: true })).toBe(toggle);
    fireEvent.click(toggle);
    await waitFor(() => expect(ui.getByRole('button', { name: 'Group by linked content', pressed: false })).toBe(toggle));
    expect(ui.getByRole('button', { name: 'review one brief.pdf' })).toBeTruthy();
    expect(ui.getByRole('button', { name: 'review two brief.pdf' })).toBeTruthy();
    expect(ui.queryByRole('button', { name: /^brief\.pdf/, expanded: false })).toBeNull();
    expect(search.value).toBe('review');
  });

  it.each([400, 800])('toggles history from the mouse Back button at %i px without navigating away', async width => {
    const { view, manager, contentEl } = await openView({ width });
    await manager.viewerSlot.show('one');
    const tab = manager.getActiveTab()!;
    tab.dom.inputEl.value = 'Keep this draft';
    const toggle = within(tab.dom.infoRowEl).getByRole('button', { name: 'Conversation history' });
    if (width === 400) fireEvent.click(toggle);
    const history = contentEl.querySelector<HTMLElement>('.claudian-session-sidebar')!;
    const search = within(history).getByRole('searchbox');
    fireEvent.input(search, { target: { value: 'two' } });

    const hostPointerUp = vi.fn();
    document.addEventListener('pointerup', hostPointerUp, true);
    onTestFinished(() => document.removeEventListener('pointerup', hostPointerUp, true));
    const dispatchButton = (target: Element, type: string, button: number): MouseEvent => {
      const event = new MouseEvent(type, { button, bubbles: true, cancelable: true });
      fireEvent(target, event);
      return event;
    };

    expect(dispatchButton(document.body, 'pointerup', 3).defaultPrevented).toBe(false);
    expect(dispatchButton(search, 'pointerup', 4).defaultPrevented).toBe(false);
    expect(hostPointerUp).toHaveBeenCalledTimes(2);
    expect(history.hidden).toBe(false);

    expect(dispatchButton(search, 'pointerdown', 3).defaultPrevented).toBe(true);
    expect(history.hidden).toBe(false);
    expect(dispatchButton(search, 'pointerup', 3).defaultPrevented).toBe(true);
    expect(hostPointerUp).toHaveBeenCalledTimes(2);
    expect(history.hidden).toBe(true);
    expect(document.activeElement).toBe(toggle);
    expect(view.getActiveTab()).toBe(tab);
    expect(tab.dom.inputEl.value).toBe('Keep this draft');

    expect(dispatchButton(tab.dom.inputEl, 'pointerdown', 3).defaultPrevented).toBe(true);
    expect(history.hidden).toBe(true);
    expect(dispatchButton(tab.dom.inputEl, 'pointerup', 3).defaultPrevented).toBe(true);
    expect(hostPointerUp).toHaveBeenCalledTimes(2);
    expect(history.hidden).toBe(false);
    expect(document.activeElement).toBe(search);
    expect(view.getActiveTab()).toBe(tab);
    expect(tab.dom.inputEl.value).toBe('Keep this draft');
  });

  it('routes picked sessions and /new through the same viewer at every width', async () => {
    const { manager, resize } = await openView({ width: 640 });
    const policy = (manager as unknown as { layoutPolicy: TabLayoutPolicy }).layoutPolicy;
    expect(policy.forkTarget()).toBe('viewer');
    const source = manager.getActiveTab()!;
    expect(await policy.openPicked('two', source)).toBe(true);
    expect(manager.getActiveTab()!.conversationId).toBe('two');
    expect(await policy.startNew(manager.getActiveTab()!, {})).toBe(true);
    expect(manager.getActiveTab()!.conversationId).toBeNull();
    const current = manager.getActiveTab();
    resize(400);
    expect(manager.getActiveTab()).toBe(current);
    expect(await policy.openPicked('one', current!)).toBe(true);
    expect(manager.getActiveTab()!.conversationId).toBe('one');
    expect(await policy.startNew(manager.getActiveTab()!, {})).toBe(true);
    expect(manager.getActiveTab()!.conversationId).toBeNull();
    resize(640);
  });
});

describe('ClaudianView composer and scoped keys', () => {
  function scoped(view: Awaited<ReturnType<typeof createClaudianView>>, key: string, event: Partial<KeyboardEvent> = {}) {
    assert(view.scope instanceof HostScope);
    const handler = view.scope.handlers.find(handler => handler.key === key);
    assert(handler);
    const keyEvent = new KeyboardEvent('keydown', { key, cancelable: true, ...event });
    if (event.defaultPrevented) keyEvent.preventDefault();
    if (event.preventDefault) keyEvent.preventDefault = event.preventDefault;
    return handler.func(keyEvent, { key, vkey: key, modifiers: '' });
  }

  it('starts a new chat with Ctrl+N only in the composer', async () => {
    const { manager, contentEl } = await openView();
    await manager.viewerSlot.show('one');
    const composerInput = () => within(manager.getActiveTab()!.dom.inputComposerEl)
      .getByRole('textbox', { name: 'Message' });
    const input = composerInput();
    const shortcut = { key: 'n', ctrlKey: true };
    expect(fireEvent.keyDown(contentEl, shortcut)).toBe(true);
    input.focus();
    expect(fireEvent.keyDown(input, { ...shortcut, isComposing: true })).toBe(true);
    expect(fireEvent.keyDown(input, { ...shortcut, shiftKey: true })).toBe(true);
    expect(fireEvent.keyDown(input, shortcut)).toBe(false);
    await waitFor(() => {
      expect(manager.getActiveTab()?.conversationId).toBeNull();
      expect(document.activeElement === composerInput()).toBe(true);
    });
  });

  it('uses one button to send a draft and cancel the resulting turn', async () => {
    const { manager } = await openView({ host: { renameConversation: async () => undefined } }, workspaceState());
    await manager.viewerSlot.show('one');
    const tab = manager.getActiveTab()!;
    const composer = within(tab.dom.inputWrapper);
    const send = composer.getByRole('button', { name: 'Send message' });
    tab.dom.inputEl.value = 'A button submission';
    fireEvent.click(send);
    await waitFor(() => expect(native.sessions[0]?.requests[0]?.input).toEqual([
      { type: 'text', text: 'A button submission' },
    ]));
    const session = native.sessions[0];
    const stop = composer.getByRole('button', { name: 'Cancel response' });
    expect(stop).toBe(send);
    fireEvent.click(stop);
    expect(session.runs[0].cancelCalls).toBe(1);
    session.runs[0].complete();
    await waitFor(() => expect(composer.getByRole('button', { name: 'Send message' })).toBe(send));
  });

  it.each([400, 800])('cancels an active turn once without closing history at %i px', async width => {
    const { view, manager, contentEl } = await openView({ width });
    const tab = manager.getActiveTab()!;
    if (width === 400) {
      fireEvent.click(within(tab.dom.infoRowEl).getByRole('button', { name: 'Conversation history' }));
    }
    const history = contentEl.querySelector<HTMLElement>('.claudian-session-sidebar')!;
    expect(history.hidden).toBe(false);
    const cancel = vi.spyOn(tab.session.turns, 'cancel');
    const release = holdResponse(tab.session.runtime.turns);
    expect(view.scope).toBeInstanceOf(Scope);
    assert(view.scope instanceof HostScope);
    expect(view.scope.parent).toBe(view.app.scope);
    expect(view.registerDomEvent).not.toHaveBeenCalledWith(expect.anything(), 'keydown', expect.any(Function), { capture: true });
    expect(scoped(view, 'Escape', { defaultPrevented: true })).toBe(false);
    expect(tab.state.isStreaming).toBe(true);
    expect(tab.session.turns.cancelRequested).toBe(false);
    expect(history.hidden).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
    expect(scoped(view, 'Escape')).toBe(false);
    expect(tab.session.turns.cancelRequested).toBe(true);
    expect(history.hidden).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(1);
    await release();
    expect(tab.state.isStreaming).toBe(false);
    expect(scoped(view, 'Escape')).toBe(false);
    expect(history.hidden).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('lets session search and IME consume Escape before cancelling the active turn', async () => {
    const { view, manager, contentEl } = await openView({ width: 640 });
    const tab = manager.getActiveTab()!;
    const release = holdResponse(tab.session.runtime.turns);
    const search = contentEl.querySelector<HTMLInputElement>('.claudian-session-sidebar .claudian-session-search-input')!;
    fireEvent.input(search, { target: { value: 'two' } });
    fireEvent.compositionStart(search);
    expect(scoped(view, 'Escape')).toBeUndefined();
    expect(tab.state.isStreaming).toBe(true);
    expect(tab.session.turns.cancelRequested).toBe(false);
    fireEvent.compositionEnd(search);
    expect(scoped(view, 'Escape')).toBe(false);
    expect(search.value).toBe('');
    expect(tab.state.isStreaming).toBe(true);
    expect(tab.session.turns.cancelRequested).toBe(false);
    scoped(view, 'Escape');
    expect(tab.session.turns.cancelRequested).toBe(true);
    await release();
    expect(tab.state.isStreaming).toBe(false);
  });

});
