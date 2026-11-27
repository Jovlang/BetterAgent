import type { TFile, ViewStateResult, WorkspaceLeaf } from 'obsidian';
import { ItemView, Menu, Notice, Scope, setIcon } from 'obsidian';

import { StartupProfiler } from '@/core/performance/StartupProfiler';
import { getHiddenCommandSet } from '@/core/providers/commands/hiddenCommands';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { ProviderId } from '@/core/providers/types';
import { VIEW_TYPE_CLAUDIAN } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { SessionManagerSurface } from '@/features/chat/session-manager/SessionManagerSurface';
import { SessionNavigation } from '@/features/chat/session-manager/SessionNavigation';
import { bindMenuToggle, showMenuAt } from '@/features/chat/session-manager/SessionSurfaceShared';
import { getSessionProviderId } from '@/features/chat/sessions/sessionProvider';
import type { ChatTab } from '@/features/chat/tabs/ChatTab';
import { TabWorkspaceLifecycle } from '@/features/chat/tabs/persistence/TabWorkspaceLifecycle';
import {
  cancelSelectedDestinationTurn,
  handleComposerMenuKeydown,
  sendTabInputMessageFromExplicitEnterShortcut,
} from '@/features/chat/tabs/TabInputEvents';
import { TabManager } from '@/features/chat/tabs/TabManager';
import type { TabLayoutPolicy } from '@/features/chat/tabs/types';
import { ChatPresentationPlacement } from '@/features/chat/view/ChatPresentationPlacement';
import { DualPaneLayout, type DualPaneLayoutElements } from '@/features/chat/view/DualPaneLayout';
import { t } from '@/i18n/i18n';
import { VaultMentionDataProvider } from '@/shared/mention/VaultMentionDataProvider';

const MOUSE_BACK_BUTTON = 3;

type LoadableView = {
  containerEl?: HTMLElement;
  load: () => Promise<void> | void;
};

export class ClaudianView extends ItemView {
  private plugin: ChatFeatureHost;

  // Tab management
  private tabManager: TabManager | null = null;
  private tabContentEl: HTMLElement | null = null;
  private viewContainerEl: HTMLElement | null = null;
  private readonly mentionDataProvider: VaultMentionDataProvider;
  private releaseMentionCacheEvents: (() => void) | null = null;
  private closing: Promise<void> | null = null;


  // Debouncing for tab bar updates
  private readonly tabWorkspace: TabWorkspaceLifecycle;
  private readonly sessionNavigation: SessionNavigation;
  private readonly sessions: SessionManagerSurface;
  private readonly layout: DualPaneLayout;
  private readonly presentation: ChatPresentationPlacement;

  constructor(
    leaf: WorkspaceLeaf,
    plugin: ChatFeatureHost,
  ) {
    super(leaf);
    this.plugin = plugin;
    this.mentionDataProvider = new VaultMentionDataProvider(plugin.app);
    this.tabWorkspace = this.createTabWorkspace();
    this.sessionNavigation = new SessionNavigation({
      plugin,
      view: this,
      getTabManager: () => this.tabManager,
    });
    this.sessions = new SessionManagerSurface({
      plugin,
      navigation: {
        getConversationStatus: id => this.sessionNavigation.getConversationStatus(id),
        openConversation: async (id, options) => {
          await this.tabManager?.openConversation(id, options);
        },
        openSessionConversation: async (id) => {
          await this.tabManager?.viewerSlot.show(id);
          this.layout.closeHistory(true);
        },
        startLinkedContentConversation: async (contentPath) => {
          if (!this.tabManager) throw new Error('Chat tabs are unavailable');
          await this.tabManager.viewerSlot.startDraft({ linkedContentPath: contentPath });
        },
        contentExists: contentPath => this.sessionNavigation.contentExists(contentPath),
      },
      getActiveTab: () => this.getActiveTab(),
      isSidebarVisible: () => this.layout.historyVisible,
      flatHistory: true,
      canCreateTab: () => this.tabManager?.canCreateTab() ?? null,
      requestNew: () => this.requestDualNew(),
      notifyOtherViews: () => this.notifyOtherViews(),
    });
    this.layout = new DualPaneLayout({
      renderSidebar: () => this.sessions.renderSidebar(),
      focusHistorySearch: () => this.sessions.focusSearch(),
      onHideSidebar: () => this.sessions.hideHistory(),
    });
    this.presentation = new ChatPresentationPlacement({
      getActiveTab: () => this.getActiveTab(),
      isWide: () => true,
      getTabCount: () => this.tabManager?.getTabCount() ?? null,
    });

    // Hover Editor compatibility: Define load as an instance method that can't be
    // overwritten by prototype patching. Hover Editor patches ClaudianView.prototype.load
    // after our class is defined, but instance methods take precedence over prototype methods.
    const prototype = Object.getPrototypeOf(this) as LoadableView;
    const originalLoad = prototype.load.bind(this);
    Object.defineProperty(this, 'load', {
      value: async () => {
        // Ensure containerEl exists before any patched load code tries to use it
        if (!this.containerEl) {
          (this as LoadableView).containerEl = createDiv({ cls: 'view-content' });
        }
        // Wrap in try-catch to prevent Hover Editor errors from breaking our view
        try {
          return await originalLoad();
        } catch {
          // Hover Editor may throw if its DOM setup fails - continue anyway
        }
      },
      writable: false,
      configurable: false,
    });
  }

  getViewType(): string {
    return VIEW_TYPE_CLAUDIAN;
  }

  getDisplayText(): string {
    return t('plugin.name');
  }

  getIcon(): string {
    return 'bot';
  }

  getState(): Record<string, unknown> {
    return this.tabWorkspace.getState();
  }

  async setState(state: unknown, _result: ViewStateResult): Promise<void> {
    await this.tabWorkspace.setState(state);
  }

  private createTabWorkspace(): TabWorkspaceLifecycle {
    return new TabWorkspaceLifecycle({
      getPlugin: () => this.plugin,
      getTabManager: () => this.tabManager,
      onInitialized: () => {
        this.syncProviderBrandColor();
        this.presentation.update();
        this.notifyConversationNavigationChanged();
        this.layout.startObserving();
      },
    });
  }

  /** Refreshes model-dependent UI across all tabs (used after settings/env changes). */
  refreshModelSelector(changedProviderId?: ProviderId): void {
    this.tabManager?.reconcileProviderAvailability();
    for (const tab of this.tabManager?.getAllTabs() ?? []) {
      const providerId = getSessionProviderId(tab, this.plugin);
      if (
        changedProviderId
        && tab.conversationId !== null
        && providerId !== changedProviderId
      ) {
        continue;
      }
      tab.refreshProviderControls();
    }
  }

  invalidateProviderCommandCaches(providerIds?: ProviderId[]): void {
    this.tabManager?.invalidateProviderCommandCaches(providerIds);
  }

  invalidateProviderResources(providerIds: ProviderId[], generation: number): void {
    this.tabManager?.invalidateProviderResources(providerIds, generation);
  }

  /** Updates hidden commands on all tabs after settings changes. */
  updateHiddenCommands(): void {
    const hiddenCommands = getHiddenCommandSet(this.plugin.settings);
    for (const tab of this.tabManager?.getAllTabs() ?? []) {
      tab.composer.setHiddenCommands(hiddenCommands);
    }
  }

  async onOpen() {
    const span = StartupProfiler.start('view-open');
    try {
      await this.onOpenImpl();
    } finally {
      StartupProfiler.finish(span);
    }
  }

  private async onOpenImpl() {
    const opening = this.tabWorkspace.beginOpen();
    const lifecycleRevision = opening.revision;
    if (this.closing) {
      // The snapshot is ready before teardown releases the old session attachment.
      await this.closing.catch(() => undefined);
      if (!this.tabWorkspace.isCurrent(lifecycleRevision)) return;
    }

    // Guard: Hover Editor and similar plugins may call onOpen before DOM is ready.
    // containerEl must exist before we can access contentEl or create elements.
    if (!this.containerEl) {
      return;
    }

    // Use contentEl (standard Obsidian API) as primary target.
    // Hover Editor and other plugins may modify the DOM structure,
    // so we need fallbacks to handle non-standard scenarios.
    let container: HTMLElement | null =
      this.contentEl ?? (this.containerEl.children[1] as HTMLElement | null);

    if (!container) {
      // Last resort: create our own container inside containerEl
      container = this.containerEl.createDiv();
    }

    this.viewContainerEl = container;
    this.viewContainerEl.empty();
    this.viewContainerEl.addClass('claudian-container');

    const layoutElements = this.buildViewLayout(this.viewContainerEl);
    if (!this.tabContentEl) return;
    // Measure before restoration so restored tabs and the nav row see the final layout.
    this.layout.initialize(layoutElements);

    const tabStatePersistence = await this.tabWorkspace.preparePersistence(opening);
    if (!tabStatePersistence) return;

    const isTabWorkspaceInitialized = (): boolean => this.tabWorkspace.isInitialized(lifecycleRevision);
    const persist = (): void => this.tabWorkspace.persist(tabManager, tabStatePersistence);
    const refreshActiveTabPresentationIfInitialized = (): void => {
      if (!isTabWorkspaceInitialized()) return;
      this.notifyConversationNavigationChanged();
      this.presentation.update();
      this.syncProviderBrandColor();
    };
    const tabManager: TabManager = new TabManager(
      this.plugin,
      this.tabContentEl,
      this,
      {
        onTabCreated: () => {
          refreshActiveTabPresentationIfInitialized();
          persist();
        },
        onActiveTabChanged: () => {
          refreshActiveTabPresentationIfInitialized();
        },
        onActiveTabCommitted: () => {
          persist();
        },
        onTabSwitched: refreshActiveTabPresentationIfInitialized,
        onTabClosed: () => {
          if (isTabWorkspaceInitialized()) {
            this.notifyConversationNavigationChanged();
            this.presentation.update();
          }
          persist();
        },
        onTabStreamingChanged: () => {
          if (isTabWorkspaceInitialized()) {
            this.notifyConversationNavigationChanged();
          }
        },
        onTabLabelChanged: () => {
          persist();
        },
        onTabOrderChanged: () => {
          if (isTabWorkspaceInitialized()) {
            this.notifyConversationNavigationChanged();
          }
          persist();
        },
        onTabWorkChanged: () => {
          if (isTabWorkspaceInitialized()) {
            this.notifyConversationNavigationChanged();
          }
        },
        onTabAttentionChanged: () => {
          if (isTabWorkspaceInitialized()) {
            this.notifyConversationNavigationChanged();
          }
        },
        onTabConversationChanged: () => {
          if (
            this.tabManager === tabManager
            && this.tabWorkspace.isCurrent(lifecycleRevision)
            && isTabWorkspaceInitialized()
          ) {
            this.notifyConversationNavigationChanged();
            this.syncProviderBrandColor();
          }
          persist();
        },
        onTabDraftChanged: () => {
          persist();
        },
        onTabProviderChanged: () => {
          if (isTabWorkspaceInitialized()) {
            this.syncProviderBrandColor();
          }
        },
      },
      this.mentionDataProvider,
      this.createLayoutPolicy(() => tabManager),
    );
    this.tabManager = tabManager;
    this.releaseMentionCacheEvents?.();
    this.releaseMentionCacheEvents = this.mentionDataProvider.register(this.plugin.app.vault);
    this.mentionDataProvider.initializeInBackground();

    this.wireEventHandlers();
    await this.tabWorkspace.completeOpen(opening);
  }

  onClose(): Promise<void> {
    return this.closing ??= this.closeView().finally(() => { this.closing = null; });
  }

  private async closeView(): Promise<void> {
    const lifecycleRevision = this.tabWorkspace.beginClose();
    const tabManager = this.tabManager;
    const scope = this.scope;
    const tabStatePersistence = this.tabWorkspace.currentPersistence;
    tabManager?.beginShutdown();
    this.layout.dispose();
    this.sessions.dispose();
    this.releaseMentionCacheEvents?.();
    this.releaseMentionCacheEvents = null;
    this.presentation.restoreAll();

    const shutdownSnapshot = this.tabWorkspace.snapshotForShutdown(
      tabManager,
      tabStatePersistence,
    );
    try {
      await shutdownSnapshot;
      this.tabWorkspace.releaseClosedPersistence(lifecycleRevision, tabStatePersistence);
      if (this.tabManager === tabManager) this.tabManager = null;
      try {
        await tabManager?.destroy();
      } finally {
        if (this.tabManager === tabManager) this.tabManager = null;
        if (this.scope === scope) this.scope = null;
      }
    } finally {
      this.tabWorkspace.settleShutdownSnapshot(shutdownSnapshot);
    }
  }

  prepareForPluginUnload(): Promise<void> {
    return this.tabWorkspace.prepareForPluginUnload();
  }

  // ============================================
  // UI Building
  // ============================================

  private buildViewLayout(containerEl: HTMLElement): DualPaneLayoutElements {
    containerEl.addClass('claudian-chat-body');
    const chatPanelEl = containerEl.createDiv({ cls: 'claudian-chat-panel' });
    this.tabContentEl = chatPanelEl.createDiv({ cls: 'claudian-tab-content-container' });
    const controls = this.buildComposerActions();
    this.presentation.mount(chatPanelEl, controls.actions);

    const sidebarEl = containerEl.createDiv({ cls: 'claudian-session-sidebar' });
    this.sessions.mountSidebar(sidebarEl, controls.backEl);
    return { containerEl, sidebarEl, history: { chatPanelEl, toggleEl: controls.toggleEl, backEl: controls.backEl } };
  }

  private buildComposerActions(): {
    actions: HTMLButtonElement[];
    backEl: HTMLButtonElement;
    toggleEl: HTMLButtonElement;
  } {
    const button = (icon: string, label: string): HTMLButtonElement => {
      const el = createEl('button', {
        cls: 'claudian-input-nav-btn',
        attr: { type: 'button', 'aria-label': label },
      });
      const glyph = el.createSpan({ attr: { 'aria-hidden': 'true' } });
      setIcon(glyph, icon);
      return el;
    };

    const newChat = button('square-pen', t('chat.tabNavigation.newChat'));
    newChat.addEventListener('click', () => {
      void this.startNewConversation()
        .catch(() => new Notice(t('chat.tabNavigation.startConversationFailed')));
    });
    const toggleEl = button('history', t('chat.tabNavigation.historyToggle'));
    const more = button('ellipsis', t('chat.tabNavigation.moreActions'));
    more.setAttribute('aria-haspopup', 'menu');
    bindMenuToggle(more, event => {
      const menu = new Menu().setUseNativeMenu(false);
      this.sessions.addHistoryMenuItems(menu, () => this.layout.setHistoryVisible(true));
      showMenuAt(menu, more, event);
      return menu;
    });

    const actions = [newChat, toggleEl, more];
    for (const action of actions) action.addClass('claudian-composer-action');
    const backEl = button('arrow-left', t('chat.tabNavigation.backToConversation'));
    return { actions, backEl, toggleEl };
  }

  private requestDualNew(): void {
    void this.startNewConversation()
      .catch(() => new Notice(t('chat.tabNavigation.startConversationFailed')));
  }

  /** Navigation always uses the one conversation viewer, independent of pane width. */
  private createLayoutPolicy(getTabManager: () => TabManager): TabLayoutPolicy {
    return {
      forkTarget: () => 'viewer',
      openPicked: async (conversationId, sourceTab) => {
        await getTabManager().viewerSlot.show(conversationId, { sourceTab });
        return true;
      },
      startNew: async (sourceTab, seed) => {
        await getTabManager().viewerSlot.startDraft({ sourceTab, ...seed });
        return true;
      },
      showsPreviews: () => true,
    };
  }

  async startNewConversation(): Promise<void> {
    await this.tabManager?.viewerSlot.startDraft();
  }

  /** Sets `data-provider` on the root container so CSS brand color follows the active provider. */
  private syncProviderBrandColor(): void {
    if (!this.viewContainerEl) return;
    const providerId = this.resolveBrandProviderId();
    if (providerId) this.viewContainerEl.dataset.provider = providerId;
    else delete this.viewContainerEl.dataset.provider;
  }

  private resolveBrandProviderId(): ProviderId | null {
    const activeTab = this.tabManager?.getActiveTab();
    return activeTab ? getSessionProviderId(activeTab, this.plugin) : ProviderRegistry.getDefaultProviderId();
  }

  // ============================================
  // Linked content events
  // ============================================

  private handleWorkspaceFileOpen(file: TFile | null): void {
    this.tabManager?.getActiveTab()?.linkedContent.handleActiveFileChanged(file, true);
  }

  private handleLinkedContentMetadataChanged(file: TFile | null): void {
    this.tabManager?.getActiveTab()?.linkedContent.handleActiveFileMetadataChanged(file);
  }

  // ============================================
  // Event Wiring
  // ============================================

  private wireEventHandlers(): void {
    const activeDocument = this.containerEl.ownerDocument;
    const viewWindow = activeDocument.defaultView;

    if (viewWindow) {
      const handleMouseBack = (event: PointerEvent): void => {
        const container = this.viewContainerEl;
        if (event.button !== MOUSE_BACK_BUTTON || !container || !event.composedPath().includes(container)) return;

        // Consume both phases before Obsidian can handle the button as workspace Back.
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.type === 'pointerup' && !this.layout.closeHistory()) {
          this.layout.setHistoryVisible(true);
        }
      };
      this.registerDomEvent(viewWindow, 'pointerdown', handleMouseBack, true);
      this.registerDomEvent(viewWindow, 'pointerup', handleMouseBack, true);
    }

    // View scopes are the Obsidian-owned boundary for main-area tab hotkeys.
    // Returning false consumes Escape before Obsidian uses it for pane navigation.
    this.scope = new Scope(this.app.scope);
    this.scope.register([], 'Escape', (e: KeyboardEvent) => {
      if (e.isComposing || this.sessions.isComposing) return;
      const activeTab = this.tabManager?.getActiveTab();
      if (this.sessions.handleEscape()) return false;
      if (activeTab?.ui.navigationSidebar.handleEscape()) return false;
      // Menus also consume Escape in the capture phase; this covers a keymap that sees it first.
      if (activeTab?.composer.closeOpenMenu()) return false;
      if (!e.defaultPrevented && activeTab) {
        if (!handleComposerMenuKeydown(activeTab, e)) cancelSelectedDestinationTurn(activeTab);
      }
      return false;
    });
    this.scope.register(['Mod'], 'Enter', (e: KeyboardEvent) => {
      if (e.isComposing || e.defaultPrevented) return;
      const activeTab = this.tabManager?.getActiveTab();
      if (!activeTab) return;
      if (sendTabInputMessageFromExplicitEnterShortcut(activeTab, e, { requireInputFocus: true })) {
        return false;
      }
    });

    // File open event
    this.registerEvent(
      this.plugin.app.workspace.on('file-open', (file) => {
        this.handleWorkspaceFileOpen(file);
      })
    );
    this.registerEvent(
      this.plugin.app.metadataCache.on('changed', (file) => {
        this.handleLinkedContentMetadataChanged(file);
      })
    );
    this.registerEvent(
      this.plugin.app.metadataCache.on('resolve', (file) => {
        this.handleLinkedContentMetadataChanged(file);
      })
    );
    this.registerEvent(
      this.plugin.app.metadataCache.on('resolved', () => {
        this.handleLinkedContentMetadataChanged(null);
      })
    );

    // Click outside to close the unified composer dropdown.
    this.registerDomEvent(activeDocument, 'click', (e) => {
      this.tabManager?.getActiveTab()?.composer.dismissDropdownFor(e.target);
    });
  }

  // ============================================
  // Public API
  // ============================================

  /** Gets the currently active tab. */
  getActiveTab(): ChatTab | null {
    return this.tabManager?.getActiveTab() ?? null;
  }

  /** Focuses the active tab's composer. */
  focusActiveInput(): void {
    this.tabManager?.getActiveTab()?.composer.focus();
  }

  /** Appends text to the active composer without sending it. */
  appendToActiveInput(text: string): boolean {
    const activeTab = this.tabManager?.getActiveTab();
    if (!activeTab || !text) return false;
    return activeTab.composer.appendText(text);
  }

  notifyConversationListChanged(): void {
    // A held draft session may have created its conversation while its blank tab was unloaded.
    this.sessions.invalidate();
    // Unloaded tabs read their running and attention state from session status changes.
  }

  private notifyConversationNavigationChanged(): void {
    this.sessions.invalidate();
    this.notifyOtherViews();
  }

  private notifyOtherViews(): void {
    for (const view of this.plugin.getAllViews()) {
      if (view !== this) {
        view.notifyConversationListChanged();
      }
    }
  }

  /** Gets the tab manager. */
  getTabManager(): TabManager | null {
    return this.tabManager;
  }

  /** Gets shared view controls that should preserve active tab selection context. */
  getSharedSelectionFocusScopeEls(): HTMLElement[] {
    return this.presentation.getSharedFocusScopeEls();
  }
}
