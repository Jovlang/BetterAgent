/** @vitest-environment jsdom */


import type { ChatTab } from '@/features/chat/tabs/ChatTab';
import { createTabPlacementPort } from '@/features/chat/tabs/runtime/TabRuntimePorts';
import { ChatPresentationPlacement } from '@/features/chat/view/ChatPresentationPlacement';

/** A tab fake whose placement is the real port over DOM nodes. */
function createPlacedTab(id: string) {
  const contentEl = document.body.createDiv();
  const messagesWrapperEl = contentEl.createDiv({ cls: 'messages' });
  const inputComposerEl = contentEl.createDiv({ cls: 'composer' });
  const setSideChatChipHost = vi.fn();
  const setSideChatFullHeightHost = vi.fn();
  const dom = {
    contentEl,
    inputComposerEl,
    messagesWrapperEl,
    inputEl: inputComposerEl.createEl('textarea'),
    infoRowEl: inputComposerEl.createDiv(),
  };
  const tab = { id, dom, placement: createTabPlacementPort(dom, setSideChatChipHost, setSideChatFullHeightHost) };
  return { dom, setSideChatChipHost, setSideChatFullHeightHost, tab: tab as unknown as ChatTab };
}

function createPlacement(tabs: ReturnType<typeof createPlacedTab>[]) {
  let active: ChatTab | null = tabs[0]?.tab ?? null;
  let isWide = false;
  const placement = new ChatPresentationPlacement({
    getActiveTab: () => active,
    isWide: () => isWide,
    getTabCount: () => tabs.length,
  });
  const chatPanelEl = document.body.createDiv();
  placement.mount(chatPanelEl);
  const footerEl = chatPanelEl.querySelector<HTMLElement>('.claudian-input-footer')!;
  return {
    chatPanelEl,
    chipHostEl: footerEl.querySelector<HTMLElement>('.claudian-side-chat-chip-slot')!,
    footerEl,
    navHostEl: footerEl.querySelector<HTMLElement>('.claudian-view-input-nav-row')!,
    placement,
    setActive: (tab: ChatTab | null) => { active = tab; },
    setWide: (wide: boolean) => { isWide = wide; },
    slotEl: footerEl.querySelector<HTMLElement>('.claudian-active-input-slot')!,
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('ChatPresentationPlacement', () => {
  it('moves only the active tab composer into the stable input slot', () => {
    const first = createPlacedTab('tab-1');
    const second = createPlacedTab('tab-2');
    const harness = createPlacement([first, second]);

    harness.placement.update();
    harness.setActive(second.tab);
    harness.placement.update();

    expect(second.dom.inputComposerEl.parentElement).toBe(harness.slotEl);
    expect(first.dom.inputComposerEl.parentElement).toBe(first.dom.contentEl);
  });

  it('preserves active pending prompt siblings during same-tab updates', () => {
    const entry = createPlacedTab('tab-1');
    const harness = createPlacement([entry]);
    harness.placement.update();
    const pendingPromptEl = entry.dom.inputComposerEl.createDiv({ cls: 'claudian-ask-question-inline' });

    harness.placement.update();

    expect(entry.dom.inputComposerEl.parentElement).toBe(harness.slotEl);
    expect(pendingPromptEl.parentElement).toBe(entry.dom.inputComposerEl);
  });

  it('replaces the footer composer when the active tab is rebound under the same id', () => {
    const original = createPlacedTab('tab-1');
    const tabs = [original];
    const harness = createPlacement(tabs);
    harness.placement.update();
    expect(harness.slotEl.children).toHaveLength(1);

    // Starting a new conversation rebuilds the runtime in place: same tab id, new DOM.
    const rebound = createPlacedTab('tab-1');
    tabs[0] = rebound;
    harness.setActive(rebound.tab);
    harness.placement.update();

    expect(Array.from(harness.slotEl.children)).toEqual([rebound.dom.inputComposerEl]);
    // The superseded composer returns to its own tab root, so destroying that root removes it.
    expect(original.dom.inputComposerEl.parentElement).toBe(original.dom.contentEl);
  });

  it('keeps exactly one footer composer across repeated same-id rebinds', () => {
    const tabs = [createPlacedTab('tab-1')];
    const harness = createPlacement(tabs);
    harness.placement.update();

    for (let i = 0; i < 3; i++) {
      const previous = tabs[0];
      const rebound = createPlacedTab('tab-1');
      tabs[0] = rebound;
      harness.setActive(rebound.tab);
      harness.placement.update();
      // The view then destroys the superseded runtime's root.
      previous.dom.contentEl.remove();
    }

    expect(harness.slotEl.children).toHaveLength(1);
  });

  it('clears the stable input slot when no tab is active', () => {
    const entry = createPlacedTab('tab-1');
    const harness = createPlacement([entry]);
    harness.placement.update();
    harness.setActive(null);

    harness.placement.update();

    expect(harness.slotEl.childElementCount).toBe(0);
    // A later activation of the same tab places it again rather than assuming it is placed.
    harness.setActive(entry.tab);
    harness.placement.update();
    expect(entry.dom.inputComposerEl.parentElement).toBe(harness.slotEl);
  });

  it('places the chip in the footer for compact views and inside the composer when wide', () => {
    const entry = createPlacedTab('tab-1');
    const harness = createPlacement([entry, createPlacedTab('tab-2')]);

    harness.placement.updateChip();
    expect(entry.setSideChatChipHost).toHaveBeenLastCalledWith(harness.chipHostEl);

    harness.setWide(true);
    harness.placement.updateChip();
    expect(entry.setSideChatChipHost).toHaveBeenLastCalledWith(null);
  });

  it('returns the chip and composer to the tab on restoreAll', () => {
    const entry = createPlacedTab('tab-1');
    const harness = createPlacement([entry]);
    harness.placement.update();

    harness.placement.restoreAll();

    expect(entry.dom.inputComposerEl.parentElement).toBe(entry.dom.contentEl);
    expect(entry.setSideChatChipHost).toHaveBeenLastCalledWith(null);
    expect(harness.slotEl.childElementCount).toBe(0);
  });

  it('keeps navigation controls in the footer host as the shared focus scope', () => {
    const harness = createPlacement([]);
    const navRowContentEl = document.createElement('div');

    harness.placement.attachNavRow(navRowContentEl);

    expect(navRowContentEl.parentElement).toBe(harness.navHostEl);
    expect(harness.placement.getSharedFocusScopeEls()).toEqual([harness.navHostEl]);
  });
});
