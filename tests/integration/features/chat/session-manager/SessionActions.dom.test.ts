/** @vitest-environment jsdom */

import { createSessionBrowserHost } from '@test/helpers/features/chat/SessionBrowserTestHarness';
import { testDate } from '@test/helpers/testClock';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { Menu } from 'obsidian';
import type { Mock } from 'vitest';

import type { ConversationMeta } from '@/core/types';
import { SessionActions } from '@/features/chat/session-manager/SessionActions';
import { SessionBrowser } from '@/features/chat/session-manager/SessionBrowser';
import type { HistoryConversationStatus } from '@/features/chat/session-manager/SessionStatusPresentation';


type MockMenu = {
  items: Array<{ title: string; icon: string; disabled: boolean; clickHandler: (() => void) | null }>;
};

function lastMenu(): MockMenu {
  return (Menu as unknown as { instances: MockMenu[] }).instances.at(-1)!;
}

function session(id: string, title: string, extra: Partial<ConversationMeta> = {}): ConversationMeta {
  return {
    id, providerId: 'codex', title, messageCount: 1, preview: '',
    createdAt: testDate({ days: -3 }).getTime(), lastActivityAt: testDate({ days: -1 }).getTime(), ...extra,
  };
}

function selectedCount(container: HTMLElement): number {
  return within(container).queryAllByText('Selected').length;
}

const conversations = [
  session('alpha', 'Alpha session'),
  session('beta', 'Beta session'),
  session('gamma', 'Gamma session'),
  session('running', 'Running session'),
  session('pinned', 'Pinned session', { isPinned: true }),
  session('pinned-too', 'Second pinned session', { isPinned: true }),
];

async function renderList(options: {
  onSelectConversation?: Mock;
  onSetConversationsArchived?: Mock;
} = {}) {
  const { plugin, lifecycle } = await createSessionBrowserHost({ conversations: structuredClone(conversations) });
  const onSetConversationsPinned = vi.spyOn(lifecycle, 'setPinned');
  const onSetConversationsArchived = vi.spyOn(lifecycle, 'archive');
  const controller = new SessionBrowser({
    plugin,
    getCurrentConversationId: () => null,
    getTitleGenerationService: () => null,
    onListChanged: () => undefined,
  });
  onTestFinished(() => controller.dispose());
  const container = document.createElement('div');
  document.body.append(container);
  const onSelectConversation = options.onSelectConversation ?? vi.fn().mockResolvedValue(undefined);
  const render = (): void => controller.renderHistoryDropdown(container, {
    onSelectConversation,


    onRerender: render,
    showMetadataPopover: true,
    sessionActionMode: 'active',
    getConversationStatus: (id): HistoryConversationStatus => ({
      openState: 'closed',
      isRunning: id === 'running',
    }),
  });
  await render();
  const button = (name: string): HTMLElement => within(container).getByRole('button', {
    name: new RegExp(`^${name}`),
  });
  return {
    controller, container, button, onSelectConversation, onSetConversationsArchived, onSetConversationsPinned, render,
  };
}

describe('SessionActions selection menu', () => {
  afterEach(() => {
    document.body.replaceChildren();
    (Menu as unknown as { instances: MockMenu[] }).instances.length = 0;
  });

  it('pins the unpinned sessions in a mixed selection', async () => {
    const { container, button, onSetConversationsPinned } = await renderList();

    fireEvent.click(button('Alpha session'), { altKey: true });
    fireEvent.click(button('Pinned session'), { altKey: true });
    fireEvent.click(button('Running session'), { altKey: true });
    expect(selectedCount(container)).toBe(3);
    fireEvent.contextMenu(button('Alpha session'));
    const menu = lastMenu();
    expect(menu.items[0].title).toBe('Pin 2 sessions');
    menu.items[0].clickHandler?.();

    expect(onSetConversationsPinned).toHaveBeenCalledWith(['alpha', 'running'], true);
    expect(selectedCount(container)).toBe(0);
  });
});

describe('SessionActions recency divider groups', () => {
  afterEach(() => { document.body.replaceChildren(); });

  async function render(
    groupByRecency: boolean,
    items: ConversationMeta[],
    extra: Partial<Parameters<SessionBrowser['renderHistoryDropdown']>[1]> & { archive?: (ids: readonly string[]) => Promise<void> } = {},
  ): Promise<HTMLElement> {
    const controller = new SessionBrowser({
      plugin: (await createSessionBrowserHost({ conversations: items, store: extra.archive ? { archiveConversationsIf: async ids => { await extra.archive?.(ids); return ids.length; } } : undefined })).plugin,
      getCurrentConversationId: () => null,
      getTitleGenerationService: () => null,
      onListChanged: () => undefined,
    });
    onTestFinished(() => controller.dispose());
  const container = document.createElement('div');
    document.body.append(container);
    controller.renderHistoryDropdown(container, {
      onSelectConversation: vi.fn().mockResolvedValue(undefined),
      showMetadataPopover: true,
      showPinnedSection: true,
      groupByRecency,
      ...extra,
    });
    return container;
  }


  const recent = (id: string, days: number, extra: Partial<ConversationMeta> = {}): ConversationMeta => ({
    ...session(id, `${id} session`, extra),
    lastActivityAt: testDate({ days: -days }).getTime(),
  });

  it('archives every non-running session in a group from its divider menu', async () => {
    const onSetConversationsArchived = vi.fn().mockResolvedValue(undefined);
    const container = await render(true, [
      recent('fresh', 2), recent('stale', 60), recent('stale-running', 70), recent('ancient', 400),
    ], {
      sessionActionMode: 'active',
      archive: onSetConversationsArchived,
      getConversationStatus: (id: string): HistoryConversationStatus => ({
        openState: 'closed', isRunning: id === 'stale-running',
      }),
    });
    fireEvent.contextMenu(within(container).getByText('Older'));
    const menu = lastMenu();
    expect(menu.items.map(item => item.title)).toEqual(['Archive all sessions']);
    menu.items[0].clickHandler?.();

    await waitFor(() => expect(onSetConversationsArchived).toHaveBeenCalledWith(['stale', 'ancient']));
  });
});

describe('SessionActions archived bulk actions', () => {
  afterEach(() => {
    document.body.replaceChildren();
    (Menu as unknown as { instances: MockMenu[] }).instances.length = 0;
  });

  async function renderArchived() {
    const archived = [
      session('one', 'First archived', { isArchived: true }),
      session('two', 'Second archived', { isArchived: true }),
      session('three', 'Third archived', { isArchived: true }),
    ];
    const { plugin, lifecycle } = await createSessionBrowserHost({ conversations: archived });
    const onRestoreConversations = vi.spyOn(lifecycle, 'restore');
    const deleteConversation = vi.spyOn(lifecycle, 'delete');
    const controller = new SessionBrowser({
      plugin,
      getCurrentConversationId: () => null,
      getTitleGenerationService: () => null,
      onListChanged: () => undefined,
    });
    onTestFinished(() => controller.dispose());
  const container = document.createElement('div');
    document.body.append(container);
    const onRerender = vi.fn();
    controller.renderHistoryDropdown(container, {
      onSelectConversation: vi.fn().mockResolvedValue(undefined),


      onRerender,
      showMetadataPopover: true,
      showArchivedSection: true,
      sessionScope: 'archived',
      sessionActionMode: 'archived',
      allowConversationSelection: false,
    });
    const item = (title: string): HTMLElement => within(container).getByText(title);
    return { container, item, onRestoreConversations, onRerender, deleteConversation, archived };
  }

  it.each([true, false])('deletes the selected archived sessions only after confirmation (%s)', async (confirmed) => {
    const { item, onRerender, deleteConversation, archived } = await renderArchived();
    const deletion = vi.spyOn(SessionActions.prototype, 'deleteSessions');
    onTestFinished(() => deletion.mockRestore());

    fireEvent.click(item('First archived'), { altKey: true });
    fireEvent.click(item('Second archived'), { altKey: true });
    fireEvent.contextMenu(item('First archived'));
    expect(lastMenu().items[1].title).toBe('Delete 2 sessions');
    lastMenu().items[1].clickHandler?.();
    const dialog = within(document.body).getByRole('dialog', { name: 'Confirm' });
    expect(dialog.textContent).toContain('Permanently delete 2 sessions?');
    fireEvent.click(within(dialog).getByRole('button', { name: confirmed ? 'Delete' : 'Cancel' }));
    await waitFor(() => expect(dialog.isConnected).toBe(false));
    await deletion.mock.results.at(-1)!.value;
    expect(deleteConversation.mock.calls).toEqual(confirmed ? [[['one', 'two']]] : []);
    expect(onRerender.mock.calls.length > 0).toBe(confirmed);
    expect(archived.map(record => record.id)).toEqual(confirmed ? ['three'] : ['one', 'two', 'three']);
  });
});
