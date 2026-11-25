// @test-ci {"inputs":["src/style/components/history.css"]}
/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { createHarness as createExecutionHarness, deferred } from '@test/helpers/ChatExecutionHarness';
import { holdResponse } from '@test/helpers/ConversationPorts';
import { useNextTaskAnimationFrames } from '@test/helpers/dom/animationFrames';
import { triggerResize } from '@test/helpers/dom/ResizeObserver';
import { createFeatureHostFixture } from '@test/helpers/FeatureHostFixture';
import { registerChatTestProvider } from '@test/helpers/features/chat/ChatProviderFixture';
import { createClaudianView } from '@test/helpers/features/chat/ClaudianViewHarness';
import { conversationRecord } from '@test/helpers/features/chat/ConversationFixture';
import { createSessionBrowserHost } from '@test/helpers/features/chat/SessionBrowserTestHarness';
import { testDate } from '@test/helpers/testClock';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { Menu, Platform, Scope, TFile } from 'obsidian';

import { ChatModelSelectionCoordinator } from '@/app/settings/ChatModelSelectionCoordinator';
import { BUILT_IN_COMMANDS } from '@/core/commands/builtInCommands';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { TabManager } from '@/features/chat/tabs/TabManager';
import type { TabLayoutPolicy } from '@/features/chat/tabs/types';
import { ViewerSlot } from '@/features/chat/tabs/ViewerSlot';
import { createChatTabCommands } from '@/features/chat/workspace/ChatTabCommands';
import { setLocale, t } from '@/i18n/i18n';

beforeEach(() => {
  useNextTaskAnimationFrames();
  registerChatTestProvider('claude');
});

const { Scope: HostScope } = await vi.importActual<typeof import('@test/__mocks__/obsidian')>('obsidian');

const openedViews: Awaited<ReturnType<typeof createClaudianView>>[] = [];

async function createView(options: {
  width?: number;
  singleViewer?: boolean;
  records?: ReturnType<typeof conversationRecord>[];
  fixture?: Awaited<ReturnType<typeof createFeatureHostFixture>>;
  host?: Omit<NonNullable<NonNullable<Parameters<typeof createSessionBrowserHost>[0]>['host']>, 'fixture' | 'app'>;
} = {}) {
  const records = options.records ?? ['one', 'two'].map(id => conversationRecord(id));
  const { settings, ...overrides } = options.host ?? {};
  const fixture = options.fixture ?? await createFeatureHostFixture({ settings: { restoreTabsOnStartup: true, enableAutoTitleGeneration: false, ...settings } });
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
  const view = await createClaudianView({ host: plugin, contentEl, singleViewer: options.singleViewer });
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
  it('waits for Obsidian state delivery, then restores all identities before publishing the active composer', async () => {
    const { view, manager, contentEl } = await createView();
    expect(manager.getTabCount()).toBe(0);
    await view.setState(workspaceState(), { history: false });
    expect(manager.getTabIdentities().map(tab => tab.id)).toEqual(['restored-1', 'restored-2']);
    expect(manager.getActiveTab()?.id).toBe('restored-2');
    expect(view.getState()).toMatchObject(workspaceState());
    expect(contentEl.contains(manager.getActiveTab()!.dom.inputEl)).toBe(true);
    // Later host deliveries cannot replace already-admitted membership.
    await view.setState(workspaceState(['stale']), { history: false });
    expect(manager.getTabCount()).toBe(2);
  });

  it('abandons deferred metadata restoration when the view closes', async () => {
    const metadata = deferred<void>();
    const entered = deferred<void>();
    const { view, manager, plugin } = await createView({ host: {
      ensureConversationMetadataLoaded: () => { entered.resolve(); return metadata.promise; },
    } });
    const restoring = view.setState({ tabWorkspace: { version: 1, activeTabId: 'bound', openTabs: [{ tabId: 'bound', conversationId: 'one' }] } }, { history: false });
    await entered.promise;
    const closing = view.onClose();
    expect(manager.canCreateTab()).toBe(false);
    expect(vi.mocked(plugin.app.vault.offref).mock.calls.map(([ref]) => (ref as unknown as { name: string }).name)).toEqual(expect.arrayContaining(['create', 'delete', 'modify', 'rename']));
    metadata.resolve();
    await Promise.all([restoring, closing]);
    expect(manager.getTabCount()).toBe(0);
    expect(view.getTabManager()).toBeNull();
  });

  it('shares one shutdown drain and snapshots an identity created by admitted work before flushing', async () => {
    const { view, manager, saved, saveLayout } = await openView();
    const tab = manager.getActiveTab()!;
    const started = deferred<void>();
    const release = deferred<void>();
    const turn = tab.session.runtime.turns.run(async () => {
      started.resolve();
      await release.promise;
      tab.session.setConversationId('one');
    });
    await started.promise;
    const first = view.prepareForPluginUnload();
    const second = view.prepareForPluginUnload();
    expect(manager.canCreateTab()).toBe(false);
    expect(saved).toEqual([]);
    release.resolve();
    await Promise.all([turn, first, second]);
    expect(saved).toEqual([{ tabWorkspace: expect.objectContaining({ openTabs: [expect.objectContaining({ tabId: tab.id, conversationId: 'one' })] }) }]);
    expect(saveLayout).toHaveBeenCalledTimes(1);
  });

  it('keeps the final identity visible while the host save blocks teardown', async () => {
    const { view, manager, saveLayout } = await openView({}, workspaceState());
    vi.useFakeTimers();
    onTestFinished(() => { vi.useRealTimers(); });
    const entered = deferred<void>();
    const save = deferred<void>();
    saveLayout.mockImplementation(() => { entered.resolve(); return save.promise; });
    const final = view.getState();
    const duringRemoval: unknown[] = [];
    const tabRoot = manager.getActiveTab()!.dom.contentEl;
    const remove = tabRoot.remove.bind(tabRoot);
    vi.spyOn(tabRoot, 'remove').mockImplementation(() => { duringRemoval.push(view.getState()); remove(); });
    let prepared = false;
    const preparing = view.prepareForPluginUnload().then(() => { prepared = true; });
    let closed = false;
    const closing = view.onClose().then(() => { closed = true; });
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(0);
      expect(prepared).toBe(false);
      expect(closed).toBe(false);
      expect(view.getState()).toEqual(final);
      expect(manager.canCreateTab()).toBe(false);
      expect(manager.getTabCount()).toBe(2);
    } finally {
      save.resolve();
      await Promise.all([preparing, closing]);
    }
    expect(manager.getTabCount()).toBe(0);
    expect(view.getTabManager()).toBeNull();
    expect(view.scope).toBeNull();
    expect(view.getState()).toEqual(final);
    expect(duringRemoval).toEqual([final]);
  });

  it('reopens wide only after the closing snapshot and keeps the new lifecycle after old cleanup', async () => {
    const { view, manager, saveLayout, resize } = await openView({}, workspaceState());
    const entered = deferred<void>();
    const save = deferred<void>();
    saveLayout.mockImplementationOnce(() => { entered.resolve(); return save.promise; });
    const persistence = view['tabWorkspace'].currentPersistence;
    const closing = view.onClose();
    await entered.promise;
    resize(640);
    const opening = view.onOpen();
    expect(view.getTabManager()).toBe(manager);
    save.resolve();
    await Promise.all([closing, opening]);
    const reopened = view.getTabManager() as TabManager;
    expect(reopened).not.toBe(manager);
    expect(reopened.getTabIdentities().map(tab => tab.id)).toEqual(expect.arrayContaining(['restored-1', 'restored-2']));
    expect(reopened.getTabCount()).toBe(3);
    expect(reopened.getActiveTab()!.conversationId).toBeNull();
    expect(view['tabWorkspace'].currentPersistence).toBe(persistence);
    expect(view.scope).toBeInstanceOf(Scope);
    expect(view['releaseMentionCacheEvents']).toEqual(expect.any(Function));
    expect(view.getState()).toMatchObject({ tabWorkspace: { openTabs: expect.arrayContaining(workspaceState().tabWorkspace.openTabs) } });
    // Reused persistence must remain writable after the old close finalizer runs.
    await reopened.createTab();
    await view.prepareForPluginUnload();
    expect(saveLayout).toHaveBeenCalledTimes(2);
  });

  it('waits for admitted identity settlement before reopening, even with startup restoration disabled', async () => {
    const { view, manager } = await openView({ host: { settings: { restoreTabsOnStartup: false } } });
    const tab = manager.getActiveTab()!;
    const started = deferred<void>();
    const release = deferred<void>();
    const turning = tab.session.runtime.turns.run(async () => {
      started.resolve();
      await release.promise;
      tab.session.setConversationId('one');
    });
    await started.promise;
    const closing = view.onClose();
    const opening = view.onOpen();
    expect(view.getTabManager()).toBe(manager);
    expect(manager.canCreateTab()).toBe(false);
    release.resolve();
    await Promise.all([turning, closing, opening]);
    const restored = view.getTabManager() as TabManager;
    expect(restored).not.toBe(manager);
    expect(restored.getTabIdentities()).toEqual(expect.arrayContaining([expect.objectContaining({ id: tab.id, conversationId: 'one' })]));
    expect(view.getState()).toMatchObject({ tabWorkspace: { openTabs: expect.arrayContaining([expect.objectContaining({ tabId: tab.id, conversationId: 'one' })]) } });
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
  it('refreshes changed-provider controls and every blank tab, then refreshes all providers on a global change', async () => {
    registerChatTestProvider('codex');
    registerChatTestProvider('opencode');
    const { view, manager, records } = await openView({ host: { settings: { providerConfigs: { codex: { enabled: true }, opencode: { enabled: true } } } } });
    records[0].providerId = 'codex';
    records[1].providerId = 'opencode';
    const codex = (await manager.createTab('one'))!;
    const opencode = (await manager.createTab('two'))!;
    const blank = (await manager.createTab(null, undefined, { providerId: 'opencode' }))!;
    const refreshCodex = vi.spyOn(codex, 'refreshProviderControls');
    const refreshOpenCode = vi.spyOn(opencode, 'refreshProviderControls');
    const refreshBlank = vi.spyOn(blank, 'refreshProviderControls');
    view.refreshModelSelector('codex');
    expect(refreshCodex).toHaveBeenCalledTimes(1);
    expect(refreshOpenCode).not.toHaveBeenCalled();
    expect(refreshBlank).toHaveBeenCalledTimes(1);
    view.refreshModelSelector();
    expect(refreshOpenCode).toHaveBeenCalledTimes(1);
  });

  it('moves the composer and chip placement with the real compact/wide transition and keeps the sidebar after the chat panel', async () => {
    const { view, manager, contentEl, resize } = await openView();
    const tab = manager.getActiveTab()!;
    const chip = vi.spyOn(tab.controllers.sideChatController, 'setCollapsedHost');
    view['presentation'].update();
    const slot = contentEl.querySelector('.claudian-side-chat-chip-slot');
    expect(chip).toHaveBeenLastCalledWith(slot);
    expect(contentEl.querySelector('.claudian-active-input-slot')?.contains(tab.dom.inputComposerEl)).toBe(true);
    const panels = [...contentEl.children];
    expect(panels.map(element => element.className)).toEqual(['claudian-chat-panel', 'claudian-session-resizer', 'claudian-session-sidebar']);
    expect(panels[1].getAttribute('role')).toBe('separator');
    expect(panels[2].querySelectorAll('.claudian-session-surface')).toHaveLength(1);
    const enter = vi.spyOn(manager.viewerSlot, 'enter');
    resize(640);
    await enter.mock.results[0].value;
    expect(chip).toHaveBeenLastCalledWith(null);
    const release = vi.spyOn(manager.viewerSlot, 'release');
    resize(400);
    await release.mock.results[0].value;
    await Promise.resolve();
    const active = manager.getActiveTab()!;
    expect(contentEl.querySelector('.claudian-active-input-slot')?.contains(active.dom.inputComposerEl)).toBe(true);
  });

  it('hides and restores history without replacing the active composer when a pane resizes', async () => {
    const style = document.head.createEl('style', {
      text: readFileSync(path.resolve('src/style/components/history.css'), 'utf8'),
    });
    onTestFinished(() => style.remove());
    const { view, manager, plugin, contentEl, resize } = await openView({
      width: 400,
      singleViewer: true,
      host: { settings: { enableDualPane: false, dualPaneSide: 'left', sessionManagerOrganization: 'linked-content' } },
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
    expect(view.getCompactTabManager()).toBeNull();
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
    expect(view.getCompactTabManager()).toBeNull();

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

  it.each([400, 800])('closes history from the mouse Back button at %i px without navigating away', async width => {
    const { view, manager, contentEl } = await openView({ width, singleViewer: true });
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

    expect(dispatchButton(toggle, 'pointerup', 3).defaultPrevented).toBe(false);
    expect(hostPointerUp).toHaveBeenCalledTimes(3);
  });

  it('automatically shows history alongside chat above 600 px without taking composer focus', async () => {
    const { view, manager, contentEl, resize } = await openView({ width: 601, singleViewer: true });
    await manager.viewerSlot.show('one');
    const tab = manager.getActiveTab()!;
    const chat = tab.dom.messagesEl.closest('.claudian-chat-panel')!;
    const history = contentEl.querySelector<HTMLElement>('.claudian-session-sidebar')!;
    const toggle = within(tab.dom.infoRowEl).getByRole('button', { name: 'Conversation history' });

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(within(history).getByText('two')).toBeTruthy();
    expect(chat.hasAttribute('inert')).toBe(false);

    resize(600);
    expect(history.hidden).toBe(true);
    expect(chat.hasAttribute('inert')).toBe(false);
    tab.dom.inputEl.value = 'Keep typing';
    tab.dom.inputEl.focus();
    const composerFocus = document.activeElement;
    expect(tab.dom.inputEl.contains(composerFocus)).toBe(true);
    tab.dom.messagesEl.scrollTop = 120;

    resize(601);
    expect(history.hidden).toBe(false);
    expect(chat.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(composerFocus);
    expect(view.getActiveTab()).toBe(tab);
    expect(tab.dom.inputEl.value).toBe('Keep typing');
    expect(tab.dom.messagesEl.scrollTop).toBe(120);

    fireEvent.click(toggle);
    resize(640);
    expect(history.hidden).toBe(true);
    resize(590);
    resize(640);
    expect(history.hidden).toBe(false);
  });

  it('routes picked sessions and /new through the real viewer only while wide', async () => {
    const enter = vi.spyOn(ViewerSlot.prototype, 'enter');
    const { manager, resize, contentEl } = await openView({ width: 640 });
    // Cold restoration enters the real viewer once; the view must not enter it a second time.
    expect(enter).toHaveBeenCalledTimes(1);
    const policy = (manager as unknown as { layoutPolicy: TabLayoutPolicy }).layoutPolicy;
    expect(policy.forkTarget()).toBe('viewer');
    const source = manager.getActiveTab()!;
    expect(await policy.openPicked('two', source)).toBe(true);
    expect(manager.getActiveTab()!.conversationId).toBe('two');
    expect(await policy.startNew(manager.getActiveTab()!, {})).toBe(true);
    expect(manager.getActiveTab()!.conversationId).toBeNull();
    const release = vi.spyOn(manager.viewerSlot, 'release');
    resize(400);
    await release.mock.results[0].value;
    await Promise.resolve();
    expect(contentEl.classList.contains('claudian-wide-session-layout')).toBe(false);
    expect(policy.forkTarget()).toBe('ask');
    const current = manager.getActiveTab();
    expect(await policy.openPicked('one', current!)).toBe(false);
    expect(await policy.startNew(current!, {})).toBe(false);
    expect(manager.getActiveTab()).toBe(current);
    resize(640);
    expect(enter).toHaveBeenCalledTimes(2);
    await enter.mock.results[1].value;
  });

  it('notifies other open views when the real session publishes work or attention changes', async () => {
    const { view, manager, plugin } = await openView();
    const other = await createClaudianView({ host: plugin });
    other.load();
    openedViews.push(other);
    const notify = vi.spyOn(other, 'notifyConversationListChanged');
    plugin.getAllViews = () => [view, other];
    const tab = manager.getActiveTab()!;
    const release = holdResponse(tab.session.runtime.turns);
    expect(notify).toHaveBeenCalled();
    await release();
    notify.mockClear();
    tab.session.runtime.attention.markReviewRequired('completed');
    expect(notify).toHaveBeenCalled();
  });
});

describe('ClaudianView tab controls and layout', () => {
  it.each(['en', 'zh-CN'] as const)('uses native %s navigation buttons, creates and focuses a real tab, and opens history', async locale => {
    setLocale('en');
    const englishNewTab = t('chat.tabNavigation.newTab');
    setLocale(locale);
    const newTabName = t('chat.tabNavigation.newTab');
    const newConversationName = t('chat.tabNavigation.newConversation');
    expect(newTabName !== englishNewTab).toBe(locale !== 'en');
    const { view, manager, contentEl } = await openView({ host: { settings: { locale } } });
    await manager.openConversation('one');
    const first = manager.getActiveTab()!;
    expect(first.conversationId).toBe('one');
    const controls = within(contentEl);
    const newTab = controls.getByRole('button', { name: newTabName });
    const newConversation = controls.getByRole('button', { name: newConversationName });
    const history = controls.getByRole('button', { name: 'Chat history' });
    for (const button of [newTab, newConversation, history]) expect(button.getAttribute('type')).toBe('button');
    const created = vi.spyOn(manager, 'createTab');
    fireEvent.click(newTab);
    const tab = await created.mock.results[0].value;
    expect(manager.getTabCount()).toBe(2);
    expect(manager.getActiveTab()).toBe(tab);
    expect(tab.dom.inputEl.contains(document.activeElement) || document.activeElement === tab.dom.inputEl).toBe(true);
    expect(manager.getTab(first.id)?.conversationId).toBe('one');
    await manager.openConversation('two');
    expect(manager.getActiveTab()).toMatchObject({ id: tab.id, conversationId: 'two' });
    const replacement = vi.spyOn(manager, 'createNewConversation');
    fireEvent.click(newConversation);
    await replacement.mock.results[0].value;
    expect(manager.getActiveTab()).toMatchObject({ id: tab.id, conversationId: null });
    expect(manager.getTab(first.id)?.conversationId).toBe('one');
    fireEvent.click(history);
    expect(contentEl.querySelector('.claudian-history-menu')?.classList.contains('visible')).toBe(true);
    const navRow = contentEl.querySelector('.claudian-view-input-nav-row');
    expect(navRow?.contains(newTab)).toBe(true);
    expect(view.getSharedSelectionFocusScopeEls!()).toEqual([navRow]);
  });

  it.each(['en', 'zh-CN'] as const)('runs the %s palette commands through the real compact navigation', async locale => {
    setLocale('en');
    const englishCommandNames = [
      t('chat.tabNavigation.commandNew'),
      t('chat.tabNavigation.commandReplace'),
      t('chat.tabNavigation.commandClose'),
    ];
    setLocale(locale);
    const commandNames = [
      t('chat.tabNavigation.commandNew'),
      t('chat.tabNavigation.commandReplace'),
      t('chat.tabNavigation.commandClose'),
    ];
    expect(commandNames.some((commandName, index) => commandName !== englishCommandNames[index])).toBe(locale !== 'en');
    const { view, manager, records } = await openView({ host: { settings: { locale } } }, workspaceState());
    records[0].title = 'Archive';
    await manager.openConversation('one');
    expect(manager.getTabCount()).toBe(2);
    const active = manager.getActiveTab()!;
    expect(active).toMatchObject({ id: 'restored-2', conversationId: 'one' });
    const commands = () => createChatTabCommands({
      workspace: { getLeavesOfType: () => [] },
      views: { getView: () => view, activateView: vi.fn() },
    });
    const [create, replace, close] = commands();
    expect([create.id, replace.id, close.id]).toEqual([
      'new-tab', 'new-session', 'close-current-tab',
    ]);
    expect([create.name, replace.name, close.name]).toEqual(commandNames);
    const before = structuredClone(view.getState());
    const start = vi.spyOn(view, 'startNewConversation');
    const replacement = vi.spyOn(manager, 'createNewConversation');
    const closed = vi.spyOn(manager, 'closeTab');
    for (const command of [create, replace, close]) expect(command.checkCallback!(true)).toBe(true);
    expect(view.getState()).toEqual(before);
    expect(start).not.toHaveBeenCalled();
    expect(replacement).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();

    expect(replace.checkCallback!(false)).toBe(true);
    await replacement.mock.results[0].value;
    expect(manager.getActiveTab()).toMatchObject({ id: active.id, conversationId: null });
    expect(manager.getTabIdentities().map(tab => tab.id)).toEqual(['restored-1', active.id]);

    await manager.openConversation('two');
    expect(manager.getActiveTab()).toMatchObject({ id: active.id, conversationId: 'two' });
    expect(create.checkCallback!(false)).toBe(true);
    await start.mock.results[0].value;
    const created = manager.getActiveTab()!;
    expect(created.id).not.toBe(active.id);
    expect(created.conversationId).toBeNull();
    expect(manager.getTabCount()).toBe(3);
    expect(manager.getTab(active.id)?.conversationId).toBe('two');
    expect(created.dom.inputEl.contains(document.activeElement) || document.activeElement === created.dom.inputEl).toBe(true);
    expect(close.checkCallback!(false)).toBe(true);
    await closed.mock.results[0].value;
    expect(manager.getTabIdentities().map(tab => tab.id)).toEqual(['restored-1', active.id]);
    expect(manager.getActiveTabId()).toBe(active.id);

    await manager.closeTab('restored-1');
    view.refreshTabControls();
    setLocale('en');
    expect(commands().map(command => command.name)).toEqual(englishCommandNames);
  });

  it.each([
    [400, 'en'],
    [640, 'en'],
    [640, 'zh-CN'],
  ] as const)('starts %s px %s New through the correct owner', async (width, locale) => {
    setLocale('en');
    const englishName = t('chat.tabNavigation.commandNew');
    setLocale(locale);
    const name = t('chat.tabNavigation.commandNew');
    expect(name !== englishName).toBe(locale !== 'en');
    const { view, manager, contentEl } = await openView({ width, host: { settings: { locale } } });
    if (width === 640) await manager.viewerSlot.show('two');
    else await manager.openConversation('two');
    expect(manager.getActiveTab()?.conversationId).toBe('two');
    const compactIds = () => manager.getTabIdentities().filter(tab => tab.lifecycleState === 'open').map(tab => tab.id);
    const before = compactIds();
    const draft = vi.spyOn(manager.viewerSlot, 'startDraft');
    const createTab = vi.spyOn(manager, 'createTab');
    const start = vi.spyOn(view, 'startNewConversation');
    const [create, ...otherCommands] = createChatTabCommands({
      workspace: { getLeavesOfType: () => [] },
      views: { getView: () => view, activateView: vi.fn() },
    });
    expect(create.name).toBe(name);
    expect(create.checkCallback!(true)).toBe(true);
    expect(otherCommands.map(command => command.checkCallback!(true))).toEqual(width === 640 ? [false, false] : [true, true]);
    expect(start).not.toHaveBeenCalled();
    expect(create.checkCallback!(false)).toBe(true);
    await start.mock.results[0].value;
    expect(draft).toHaveBeenCalledTimes(width === 640 ? 1 : 0);
    expect(createTab).toHaveBeenCalledTimes(width === 640 ? 0 : 1);
    const active = manager.getActiveTab()!;
    expect(active.conversationId).toBeNull();
    expect(contentEl.contains(active.dom.inputEl)).toBe(true);
    expect(view.getCompactTabManager()).toBe(width === 640 ? null : manager);
    expect(compactIds()).toEqual(width === 640 ? before : [...before, active.id]);
  });

  it('keeps compact controls hidden until real viewer cleanup completes, and closes search immediately', async () => {
    const { view, manager, contentEl, resize } = await openView();
    fireEvent.click(within(contentEl).getByRole('button', { name: 'Chat history' }));
    const historyMenu = contentEl.querySelector('.claudian-history-menu')!;
    expect(historyMenu.classList.contains('visible')).toBe(true);
    const enter = vi.spyOn(manager.viewerSlot, 'enter');
    resize(640);
    await enter.mock.results[0].value;
    expect(contentEl.classList.contains('claudian-wide-session-layout')).toBe(true);
    expect(historyMenu.classList.contains('visible')).toBe(false);
    fireEvent.click(contentEl.querySelector<HTMLElement>('.claudian-session-search-control')!);
    expect(contentEl.querySelector('.claudian-session-sidebar .claudian-session-search-input')).not.toBeNull();
    const released = vi.spyOn(manager.viewerSlot, 'release');
    resize(400);
    expect(contentEl.querySelector('.claudian-session-sidebar .claudian-session-search-input')).toBeNull();
    expect(contentEl.classList.contains('claudian-wide-session-layout')).toBe(true);
    await released.mock.results[0].value;
    // The layout's continuation follows the owner's fulfilled release promise.
    await Promise.resolve();
    expect(contentEl.classList.contains('claudian-wide-session-layout')).toBe(false);
    expect(view.getCompactTabManager()).toBe(manager);
  });

  it('routes active-file and metadata changes only to the active real Linked content owner', async () => {
    const { manager, plugin } = await openView();
    const inactive = manager.getActiveTab()!;
    const active = (await manager.createTab())!;
    const inactiveFile = vi.spyOn(inactive.linkedContent, 'handleActiveFileChanged');
    const activeFile = vi.spyOn(active.linkedContent, 'handleActiveFileChanged');
    const activeMetadata = vi.spyOn(active.linkedContent, 'handleActiveFileMetadataChanged');
    const inactiveMetadata = vi.spyOn(inactive.linkedContent, 'handleActiveFileMetadataChanged');
    const file = new TFile();
    Object.assign(file, { path: 'Projects/Plan.md', extension: 'md', name: 'Plan.md', basename: 'Plan' });
    plugin.app.workspace.trigger('file-open', file);
    plugin.app.workspace.trigger('file-open', null);
    plugin.app.metadataCache.trigger('changed', file);
    plugin.app.metadataCache.trigger('resolve', file);
    plugin.app.metadataCache.trigger('resolved');
    expect(activeFile.mock.calls).toEqual([[file, true], [null, true]]);
    expect(activeMetadata.mock.calls).toEqual([[file], [file], [null]]);
    expect(inactiveFile).not.toHaveBeenCalled();
    expect(inactiveMetadata).not.toHaveBeenCalled();
  });

  it('releases mention invalidation listeners on close and replaces them on reopen', async () => {
    const { view, plugin } = await openView();
    const markFilesDirty = vi.spyOn(view['mentionDataProvider'], 'markFilesDirty');
    plugin.app.vault.trigger('create');
    expect(markFilesDirty).toHaveBeenCalledTimes(1);
    await view.onClose();
    markFilesDirty.mockClear();
    plugin.app.vault.trigger('create');
    expect(markFilesDirty).not.toHaveBeenCalled();
    await view.onOpen();
    markFilesDirty.mockClear();
    plugin.app.vault.trigger('create');
    expect(markFilesDirty).toHaveBeenCalledTimes(1);
    const previousManager = view.getTabManager() as TabManager;
    await view.onOpen();
    markFilesDirty.mockClear();
    plugin.app.vault.trigger('create');
    expect(markFilesDirty).toHaveBeenCalledTimes(1);
    await previousManager.destroy();
    expect(vi.mocked(plugin.app.vault.offref).mock.calls.map(([ref]) => (ref as unknown as { name: string }).name)).toEqual(expect.arrayContaining(['create', 'delete', 'modify', 'rename']));
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

  it.each([['Hello', 'Hello @projects/plan.md '], ['Hello ', 'Hello @projects/plan.md ']])('appends to %j and focuses the real composer', async (existing, expected) => {
    const { view, manager } = await openView();
    const tab = manager.getActiveTab()!;
    tab.controllers.drafts.restore('main', { content: existing, images: [] });
    expect(view.appendToActiveInput('@projects/plan.md ')).toBe(true);
    expect(tab.controllers.drafts.capture('main').content).toBe(expected);
    view.focusActiveInput();
    expect(tab.dom.inputEl.contains(document.activeElement) || tab.dom.inputEl === document.activeElement).toBe(true);
  });

  it('returns false when the view has no admitted composer', async () => {
    const { view } = await createView();
    expect(view.appendToActiveInput('text')).toBe(false);
  });

  it('handles Escape in the view scope and cancels an active real turn only once', async () => {
    const { view, manager } = await openView();
    const tab = manager.getActiveTab()!;
    const cancel = vi.spyOn(tab.session.turns, 'cancel');
    const release = holdResponse(tab.session.runtime.turns);
    expect(view.scope).toBeInstanceOf(Scope);
    assert(view.scope instanceof HostScope);
    expect(view.scope.parent).toBe(view.app.scope);
    expect(view.registerDomEvent).not.toHaveBeenCalledWith(expect.anything(), 'keydown', expect.any(Function), { capture: true });
    expect(scoped(view, 'Escape', { defaultPrevented: true })).toBe(false);
    expect(tab.state.isStreaming).toBe(true);
    expect(tab.session.turns.cancelRequested).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
    expect(scoped(view, 'Escape')).toBe(false);
    expect(tab.session.turns.cancelRequested).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    await release();
    expect(tab.state.isStreaming).toBe(false);
    expect(scoped(view, 'Escape')).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('lets session search and IME consume Escape before cancelling the active turn', async () => {
    const { view, manager, contentEl } = await openView({ width: 640 });
    const tab = manager.getActiveTab()!;
    const release = holdResponse(tab.session.runtime.turns);
    fireEvent.click(contentEl.querySelector<HTMLElement>('.claudian-session-search-control')!);
    const search = contentEl.querySelector<HTMLInputElement>('.claudian-session-sidebar .claudian-session-search-input')!;
    fireEvent.compositionStart(search);
    expect(scoped(view, 'Escape')).toBeUndefined();
    expect(tab.state.isStreaming).toBe(true);
    expect(tab.session.turns.cancelRequested).toBe(false);
    fireEvent.compositionEnd(search);
    expect(scoped(view, 'Escape')).toBe(false);
    expect(contentEl.querySelector('.claudian-session-sidebar .claudian-session-search-input')).toBeNull();
    expect(tab.state.isStreaming).toBe(true);
    expect(tab.session.turns.cancelRequested).toBe(false);
    scoped(view, 'Escape');
    expect(tab.session.turns.cancelRequested).toBe(true);
    await release();
    expect(tab.state.isStreaming).toBe(false);
  });

  it.each(['toolbar', 'resume', 'composer'] as const)('dismisses the real %s surface before stopping a turn', async surface => {
    const { view, manager, contentEl } = await openView({}, workspaceState());
    const tab = manager.getActiveTab()!;
    const release = holdResponse(tab.session.runtime.turns);
    let isOpen: () => boolean;
    if (surface === 'toolbar') {
      const button = tab.dom.inputWrapper.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!;
      fireEvent.click(button);
      isOpen = () => button.getAttribute('aria-expanded') === 'true';
    } else if (surface === 'resume') {
      await tab.controllers.builtInCommandController.execute(BUILT_IN_COMMANDS.find(command => command.action === 'resume')!, ProviderRegistry.getCapabilities('claude'));
      isOpen = () => tab.controllers.builtInCommandController.isResumeDropdownVisible();
    } else {
      tab.dom.inputEl.value = '/';
      tab.dom.inputEl.selectionStart = 1;
      tab.ui.composerDropdown.handleInputChange();
      await within(contentEl).findByRole('listbox');
      isOpen = () => tab.ui.composerDropdown.isVisible();
    }
    expect(isOpen()).toBe(true);
    expect(scoped(view, 'Escape')).toBe(false);
    expect(isOpen()).toBe(false);
    expect(tab.state.isStreaming).toBe(true);
    expect(tab.session.turns.cancelRequested).toBe(false);
    scoped(view, 'Escape');
    expect(tab.session.turns.cancelRequested).toBe(true);
    await release();
    expect(tab.state.isStreaming).toBe(false);
  });

  it('dismisses the conversation directory through the host keymap before stopping a turn', async () => {
    const { view, manager } = await openView();
    const tab = manager.getActiveTab()!;
    const release = holdResponse(tab.session.runtime.turns);
    const prompt = { id: 'question', role: 'user' as const, content: 'Plan the note', timestamp: testDate().getTime() };
    tab.state.messages = [prompt];
    tab.renderer.renderMessages(tab.state.messages, () => '');
    Object.defineProperty(tab.dom.messagesEl, 'scrollHeight', { configurable: true, value: 2_000 });
    Object.defineProperty(tab.dom.messagesEl, 'clientHeight', { configurable: true, value: 400 });
    tab.ui.navigationSidebar.updateVisibility();
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const toggle = within(tab.dom.contentEl).getByRole('button', { name: 'Conversation directory' });
    fireEvent.click(toggle);
    const entry = within(tab.dom.contentEl).getByRole('button', { name: '1. Plan the note' });
    entry.focus();
    view.app.keymap.pushScope(view.scope!);
    try {
      fireEvent.keyDown(entry, { key: 'Escape' });
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(document.activeElement).toBe(toggle);
      expect(tab.session.turns.cancelRequested).toBe(false);
      fireEvent.keyDown(toggle, { key: 'Escape' });
      expect(tab.session.turns.cancelRequested).toBe(true);
    } finally {
      view.app.keymap.popScope(view.scope!);
      await release();
    }
  });

  it('dismisses inline session rename before handling the scoped stop action', async () => {
    const { view, manager, contentEl } = await openView();
    const tab = manager.getActiveTab()!;
    const release = holdResponse(tab.session.runtime.turns);
    fireEvent.click(within(contentEl).getByRole('button', { name: 'Chat history' }));
    const item = contentEl.querySelector<HTMLElement>('.claudian-history-menu .claudian-history-item')!;
    fireEvent.contextMenu(item);
    const menu = (Menu as typeof Menu & { instances: Array<{ items: Array<{ title: string; clickHandler?: () => void }> }> }).instances.at(-1)!;
    menu.items.find(action => action.title === 'Rename')!.clickHandler!();
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    expect(within(contentEl).getByRole('textbox', { name: 'Conversation title' })).toBeTruthy();
    expect(scoped(view, 'Escape')).toBe(false);
    expect(within(contentEl).queryByRole('textbox', { name: 'Conversation title' })).toBeNull();
    expect(tab.state.isStreaming).toBe(true);
    expect(tab.session.turns.cancelRequested).toBe(false);
    await release();
  });

  it.each([true, false])('scoped Mod+Enter sends only with composer focus (focused=%s)', async focused => {
    const priorPlatform = Platform.isMacOS;
    Platform.isMacOS = true;
    try {
      const { view, manager } = await openView();
      const tab = manager.getActiveTab()!;
      const send = vi.spyOn(tab.controllers.inputController, 'sendMessage');
      if (focused) tab.composer.focus();
      else { const outside = document.body.createEl('button'); outside.focus(); }
      const preventDefault = vi.fn();
      expect(scoped(view, 'Enter', { metaKey: true, preventDefault })).toBe(focused ? false : undefined);
      expect(preventDefault).toHaveBeenCalledTimes(focused ? 1 : 0);
      expect(send).toHaveBeenCalledTimes(focused ? 1 : 0);
      if (focused) await send.mock.results[0].value;
    } finally { Platform.isMacOS = priorPlatform; }
  });


  it('scoped Escape stops published provider background work without a foreground turn', async () => {
    const native = registerChatTestProvider('claude');
    const { view, manager } = await openView();
    const tab = manager.getActiveTab()!;
    await tab.executionCoordinator.bindConversation({ conversationId: 'one', providerId: 'claude' });
    await tab.executionCoordinator.prepare();
    const session = native.sessions[0];
    session.emit({ type: 'background_turn_started', scope: { kind: 'background', sessionInstanceId: session.sessionInstanceId, turnId: 'background', sequence: 1 } });
    await tab.session.runtime.awaitBackgroundWork();
    expect(tab.state.isStreaming).toBe(false);
    expect(tab.session.hasMainBackgroundWork).toBe(true);
    expect(scoped(view, 'Escape')).toBe(false);
    expect(session.cancelCalls).toBe(1);
  });

});
