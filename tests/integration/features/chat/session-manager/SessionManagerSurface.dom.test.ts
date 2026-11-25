/** @vitest-environment jsdom */
import '@/providers';

import { axe } from '@test/helpers/accessibility';
import { createSessionBrowserHost } from '@test/helpers/features/chat/SessionBrowserTestHarness';
import { createObsidianWorkspace } from '@test/helpers/ObsidianWorkspace';
import { testDate } from '@test/helpers/testClock';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { App, Menu } from 'obsidian';

import type { ConversationMeta } from '@/core/types';
import { SessionBrowser } from '@/features/chat/session-manager/SessionBrowser';
import { SessionManagerSurface } from '@/features/chat/session-manager/SessionManagerSurface';


function conversation(id: string, overrides: Partial<ConversationMeta> = {}): ConversationMeta {
  const at = testDate({ hours: -1 }).getTime();
  return {
    id,
    providerId: 'codex',
    title: id,
    createdAt: at,
    lastActivityAt: at,
    messageCount: 1,
    preview: '',
    ...overrides,
  };
}

async function createSurface(active = false) {
  // Active rows carry their own Archive action; an archived-only list keeps navigation names unique.
  const conversations = [conversation('archived', { isArchived: !active })];
  const workspace = createObsidianWorkspace(document.body);
  const app = new App();
  Object.assign(app.workspace, workspace);
  const { plugin } = await createSessionBrowserHost({ conversations, host: {
    app, settings: { enableAutoTitleGeneration: false },
    renameConversation: async (id, title) => {
      const record = conversations.find(conversation => conversation.id === id);
      if (record) record.title = title;
    },
  } });
  const requestNew = vi.fn();
  const openConversation = vi.fn().mockResolvedValue(undefined);
  const surface = new SessionManagerSurface({
    plugin,
    navigation: {
      contentExists: () => true,
      getConversationStatus: () => ({ openState: 'closed', isRunning: false }),
      openConversation,
      openSessionConversation: vi.fn().mockResolvedValue(undefined),
      startLinkedContentConversation: vi.fn().mockResolvedValue(undefined),
    },
    getActiveTab: () => null,
    isSidebarVisible: () => true,
    canCreateTab: () => true,
    requestNew,
    notifyOtherViews: vi.fn(),
  });
  const host = document.body.createDiv();
  onTestFinished(() => surface.dispose());
  surface.mountSidebar(host);
  surface.renderSidebar();
  return { host, requestNew, surface, workspace, conversations, plugin, openConversation };
}

afterEach(() => {
  document.body.replaceChildren();
});

it('follows the left sidebar theme token through theme changes and releases its listener', async () => {
  const navigation = document.body.createDiv({ cls: 'mod-left-split' });
  navigation.style.setProperty('--nav-item-background-active', 'rgba(100, 100, 100, 0.2)');
  const { host, surface, workspace } = await createSurface();
  const background = () => host.style.getPropertyValue('--claudian-session-background-active');
  try {
    expect(background()).toBe('rgba(100, 100, 100, 0.2)');
    navigation.style.setProperty('--nav-item-background-active', 'transparent');
    workspace.trigger('css-change');
    expect(background()).toBe('transparent');
    navigation.style.setProperty('--nav-item-background-active', 'rgb(30, 30, 30)');
    workspace.trigger('css-change');
    expect(background()).toBe('rgb(30, 30, 30)');
    navigation.remove();
    workspace.trigger('css-change');
    expect(background()).toBe('');
  } finally {
    surface.dispose();
  }
  expect(workspace.listenerCount()).toBe(0);
});

it.each([
  { finish: 'save', key: 'Enter', calls: [['archived', 'My uncommitted title']], title: 'My uncommitted title' },
  { finish: 'cancel', key: 'Escape', calls: [], title: 'archived' },
])('retains an inline title draft through passive list invalidations until $finish', async ({ key, calls, title }) => {
  const { host, surface, plugin, conversations, openConversation } = await createSurface(true);
  const ui = within(host);
  const rename = vi.spyOn(plugin, 'renameConversation');
  fireEvent.contextMenu(ui.getByRole('button', { name: /^archived/ }));
  const menu = (Menu as typeof Menu & { instances: Array<{ items: Array<{ title: string; clickHandler: (() => void) | null }> }> }).instances.at(-1)!;
  menu.items.find(item => item.title === 'Rename')!.clickHandler!();
  const input = await ui.findByRole('textbox', { name: 'Conversation title' }) as HTMLInputElement;
  fireEvent.input(input, { target: { value: 'My uncommitted title' } });
  input.setSelectionRange(3, 9, 'backward');
  conversations.push(conversation('Arrived while editing'));
  surface.invalidate();
  const current = ui.getByRole('textbox', { name: 'Conversation title' }) as HTMLInputElement;
  expect(current).toBe(input);
  expect(current.value).toBe('My uncommitted title');
  expect(document.activeElement).toBe(current);
  expect([current.selectionStart, current.selectionEnd, current.selectionDirection]).toEqual([3, 9, 'backward']);
  expect(ui.getByRole('button', { name: /^Arrived while editing/ })).toBeDefined();
  expect(rename).not.toHaveBeenCalled();
  expect(await axe(host)).toHaveNoViolations();
  fireEvent.click(current);
  fireEvent.keyDown(current, { key });
  expect(openConversation).not.toHaveBeenCalled();
  await waitFor(() => expect(ui.queryByRole('textbox', { name: 'Conversation title' })).toBeNull());
  expect(rename.mock.calls).toEqual(calls);
  expect(ui.getByRole('button', { name: new RegExp(`^${title}`) })).toBeDefined();
});

it.each(['delete', 'archive'] as const)('releases an inline title draft when its row leaves the active list (%s)', async action => {
  const { host, surface, plugin, conversations } = await createSurface(true);
  const ui = within(host);
  const rename = vi.spyOn(plugin, 'renameConversation');
  fireEvent.contextMenu(ui.getByRole('button', { name: /^archived/ }));
  const menu = (Menu as typeof Menu & { instances: Array<{ items: Array<{ title: string; clickHandler: (() => void) | null }> }> }).instances.at(-1)!;
  menu.items.find(item => item.title === 'Rename')!.clickHandler!();
  const input = await ui.findByRole('textbox', { name: 'Conversation title' }) as HTMLInputElement;
  fireEvent.input(input, { target: { value: 'Do not persist this draft' } });
  if (action === 'delete') conversations.length = 0;
  else conversations[0].isArchived = true;
  surface.invalidate();
  expect(ui.queryByRole('textbox', { name: 'Conversation title' })).toBeNull();
  expect(input.isConnected).toBe(false);
  expect(surface.handleEscape()).toBe(false);
  expect(rename).not.toHaveBeenCalled();
});

it.each(['editing query', 'list invalidation'])('preserves the search caret and selection while %s', async action => {
  const { host, surface } = await createSurface();
  const ui = within(host);
  try {
    fireEvent.click(ui.getByRole('button', { name: 'Search' }));
    fireEvent.input(ui.getByRole('searchbox', { name: 'Search sessions' }), { target: { value: 'abcdef' } });
    const input = ui.getByRole('searchbox', { name: 'Search sessions' }) as HTMLInputElement;
    if (action === 'editing query') {
      input.value = 'abXcdef';
      input.setSelectionRange(3, 3);
      fireEvent.input(input);
    } else {
      input.setSelectionRange(1, 4, 'backward');
      surface.invalidate();
    }
    const current = ui.getByRole('searchbox', { name: 'Search sessions' }) as HTMLInputElement;
    expect(document.activeElement).toBe(current);
    expect([current.selectionStart, current.selectionEnd, current.selectionDirection]).toEqual(
      action === 'editing query' ? [3, 3, 'none'] : [1, 4, 'backward'],
    );
    expect(current.value).toBe(action === 'editing query' ? 'abXcdef' : 'abcdef');
    expect(await axe(host)).toHaveNoViolations();
  } finally {
    surface.dispose();
  }
});

it.each([false, true])('opens selectable history rows by keyboard (metadata popovers: %s)', async showMetadataPopover => {
  const onSelectConversation = vi.fn().mockResolvedValue(undefined);
  const browser = new SessionBrowser({
    plugin: (await createSessionBrowserHost({ conversations: [conversation('Keyboard session'), conversation('current', { title: 'Active conversation' })], host: { settings: { enableAutoTitleGeneration: false } } })).plugin,
    getCurrentConversationId: () => 'current',
    getTitleGenerationService: () => null,
    onListChanged: () => undefined,
  });
  const host = document.body.createDiv();
  try {
    browser.renderHistoryDropdown(host, { onSelectConversation, showMetadataPopover });
    const view = within(host);
    const selectable = view.getByRole('button', { name: /^Keyboard session/ });
    selectable.focus();
    expect(document.activeElement).toBe(selectable);
    for (const key of ['Enter', ' ']) fireEvent.keyDown(selectable, { key });
    expect(onSelectConversation.mock.calls).toEqual([['Keyboard session'], ['Keyboard session']]);
    expect((await axe(selectable)).violations).toEqual([]);

    const current = view.getByText('Active conversation').parentElement!;
    expect(view.queryByRole('button', { name: /^Active conversation/ })).toBeNull();
    fireEvent.keyDown(current, { key: 'Enter' });
    expect(onSelectConversation).toHaveBeenCalledTimes(2);

    browser.renderHistoryDropdown(host, {
      onSelectConversation, showMetadataPopover,
      allowConversationSelection: false, sessionActionMode: 'archived',
    });
    const archived = view.getByText('Keyboard session').parentElement!;
    expect(view.queryByRole('button', { name: /^Keyboard session/ })).toBeNull();
    fireEvent.keyDown(archived, { key: 'Enter' });
    expect(onSelectConversation).toHaveBeenCalledTimes(2);
  } finally {
    browser.dispose();
    host.remove();
  }
});

it.each([false, true])('keeps session navigation named and operable without tooltips (archive: %s)', async archived => {
  const { host, requestNew, surface } = await createSurface();
  const sidebar = within(host);
  if (archived) {
    fireEvent.keyDown(sidebar.getByRole('button', { name: 'Archive' }), { key: 'Enter' });
  }
  const archiveName = archived ? 'Sessions' : 'Archive';
  const list = host.querySelector('.claudian-history-list')!;
  expect(within(list as HTMLElement).getByText(archived ? 'Archived' : 'Sessions')).toBeTruthy();

  for (const name of ['New', 'Search', archiveName]) {
    const button = sidebar.getByRole('button', { name });
    expect(button.hasAttribute('aria-label')).toBe(false);
    expect(button.hasAttribute('title')).toBe(false);
    // Navigation sits above the session list and its header.
    expect(button.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    button.focus();
    expect(document.activeElement).toBe(button);
  }
  expect((await axe(host)).violations).toEqual([]);

  fireEvent.keyDown(sidebar.getByRole('button', { name: 'Search' }), { key: 'Enter' });
  const searchBox = sidebar.getByRole('searchbox', {
    name: archived ? 'Search archived sessions' : 'Search sessions',
  });
  expect(document.activeElement).toBe(searchBox);
  expect(sidebar.queryByRole('button', { name: 'Search' })).toBeNull();
  expect((await axe(host)).violations).toEqual([]);

  fireEvent.keyDown(sidebar.getByRole('button', { name: archiveName }), { key: 'Enter' });
  expect(sidebar.getByRole('button', { name: archived ? 'Archive' : 'Sessions' })).toBeTruthy();
  expect(sidebar.queryByRole('searchbox')).toBeNull();

  fireEvent.keyDown(sidebar.getByRole('button', { name: 'New' }), { key: 'Enter' });
  expect(requestNew).toHaveBeenCalledTimes(1);
  // New always returns to active sessions.
  expect(sidebar.getByRole('button', { name: 'Archive' })).toBeTruthy();

  surface.dispose();
});
