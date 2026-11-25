import type { ChatTab } from '@/features/chat/tabs/ChatTab';

export interface ChatPresentationContext {
  getActiveTab(): ChatTab | null;
  isWide(): boolean;
  getTabCount(): number | null;
}

/**
 * The view's placement authority: where the active tab's composer, transcript,
 * and side-chat chip live in the view footer.
 */
export class ChatPresentationPlacement {
  private chatPanelEl: HTMLElement | null = null;
  private inputFooterEl: HTMLElement | null = null;
  private sideChatChipHostEl: HTMLElement | null = null;
  private inputNavRowHostEl: HTMLElement | null = null;
  private activeInputSlotEl: HTMLElement | null = null;
  private composerActions: readonly HTMLButtonElement[] = [];
  private navRowContentEl: HTMLElement | null = null;
  /**
   * The runtime whose composer sits in the active input slot. Held by reference, not by id: a
   * rebind installs a new runtime under the same tab id, so an id match cannot tell whether the
   * composer in the slot still belongs to the active tab.
   */
  private activeInputTab: ChatTab | null = null;
  private sideChatChipTab: ChatTab | null = null;

  constructor(private readonly context: ChatPresentationContext) {}

  /** Builds the view-owned footer: chip slot, navigation row host, and composer slot. */
  mount(chatPanelEl: HTMLElement, composerActions: readonly HTMLButtonElement[] = []): void {
    this.composerActions = composerActions;
    this.chatPanelEl = chatPanelEl;
    this.inputFooterEl = chatPanelEl.createDiv({ cls: 'claudian-input-footer' });
    this.sideChatChipHostEl = this.inputFooterEl.createDiv({ cls: 'claudian-side-chat-chip-slot' });
    this.inputNavRowHostEl = composerActions.length === 0 ? this.inputFooterEl.createDiv({
      cls: 'claudian-input-nav-row claudian-view-input-nav-row',
    }) : null;
    this.activeInputSlotEl = this.inputFooterEl.createDiv({ cls: 'claudian-active-input-slot' });
    this.navRowContentEl = null;
  }

  /** Moves the shared navigation row content into the footer's navigation host. */
  attachNavRow(navRowContentEl: HTMLElement): void {
    this.navRowContentEl = navRowContentEl;
    this.inputNavRowHostEl?.appendChild(navRowContentEl);
  }

  /** View controls that keep the active tab's selection context while focused. */
  getSharedFocusScopeEls(): HTMLElement[] {
    return this.inputNavRowHostEl ? [this.inputNavRowHostEl] : [...this.composerActions];
  }

  /** Places the active composer in the footer slot. */
  update(): void {
    const activeTab = this.context.getActiveTab();
    const activeInputSlotEl = this.activeInputSlotEl;
    if (!activeInputSlotEl) return;
    this.updateChip();
    if (activeTab) activeTab.placement.placeComposerActions(this.composerActions);
    else this.removeComposerActions();

    if (!activeTab) {
      activeInputSlotEl.empty();
      this.activeInputTab = null;
      return;
    }

    if (this.activeInputTab && this.activeInputTab !== activeTab) {
      this.activeInputTab.placement.restoreComposer();
    }

    if (this.activeInputTab === activeTab) {
      if (!activeTab.placement.isComposerPlacedIn(activeInputSlotEl)) {
        activeTab.placement.placeComposer(activeInputSlotEl);
      }
      return;
    }

    activeInputSlotEl.empty();
    activeTab.placement.placeComposer(activeInputSlotEl);
    this.activeInputTab = activeTab;
  }

  private removeComposerActions(): void {
    for (const action of this.composerActions) action.remove();
  }

  /** Lends the side-chat chip and full height hosts to the active tab for the current layout. */
  updateChip(): void {
    const hostEl = this.sideChatChipHostEl;
    if (!hostEl) return;
    const isWide = this.context.isWide();
    if (this.navRowContentEl && this.inputFooterEl && this.inputNavRowHostEl) {
      const useNavRow = !isWide && this.context.getTabCount() === 1;
      const parent = useNavRow ? this.navRowContentEl : this.inputFooterEl;
      if (hostEl.parentElement !== parent) {
        parent.insertBefore(hostEl, useNavRow ? parent.firstChild : this.inputNavRowHostEl);
      }
    }
    const chipTab = this.context.getActiveTab();
    if (this.sideChatChipTab !== chipTab) {
      this.sideChatChipTab?.placement.setSideChatChipHost(null);
      this.sideChatChipTab?.placement.setSideChatFullHeightHost(null);
    }
    this.sideChatChipTab = chipTab;
    chipTab?.placement.setSideChatChipHost(isWide ? null : hostEl);
    chipTab?.placement.setSideChatFullHeightHost(this.chatPanelEl);
  }

  /** Returns the chip and the active composer to their tab-owned locations. */
  restoreAll(): void {
    this.removeComposerActions();
    this.sideChatChipTab?.placement.setSideChatChipHost(null);
    this.sideChatChipTab?.placement.setSideChatFullHeightHost(null);
    this.sideChatChipTab = null;
    if (!this.activeInputTab) return;

    this.activeInputTab.placement.restoreComposer();
    this.activeInputSlotEl?.empty();
    this.activeInputTab = null;
  }
}
