import type { Menu } from 'obsidian';

import { StartupProfiler } from '@/core/performance/StartupProfiler';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { SessionBrowser } from '@/features/chat/session-manager/SessionBrowser';
import { SessionSidebar } from '@/features/chat/session-manager/SessionSidebar';
import type { SessionSurfaceNavigation } from '@/features/chat/session-manager/SessionSurfaceShared';
import type { ChatTab } from '@/features/chat/tabs/ChatTab';

export interface SessionManagerSurfaceDeps {
  plugin: ChatFeatureHost;
  navigation: SessionSurfaceNavigation;
  getActiveTab(): ChatTab | null;
  isSidebarVisible(): boolean;
  flatHistory?: boolean;
  /** Whether another tab fits; null while the view has no tabs. */
  canCreateTab(): boolean | null;
  requestNew(): void;
  /** Session presentation settings changed; other views must re-render their lists. */
  notifyOtherViews(): void;
}

/** Owns the view’s conversation history, including search, archive, and invalidation. */
export class SessionManagerSurface {
  private readonly browser: SessionBrowser;
  private readonly sidebar: SessionSidebar;

  private isArchiveView = false;
  private hasRenderedList = false;

  constructor(private readonly deps: SessionManagerSurfaceDeps) {
    this.browser = new SessionBrowser({
      plugin: deps.plugin,
      getCurrentConversationId: () => deps.getActiveTab()?.conversationId ?? null,
      getTitleGenerationService: () => deps.getActiveTab()?.services.titleGenerationService ?? null,
      onListChanged: () => this.invalidate(),
    });
    const shared = {
      browser: this.browser,
      isArchiveView: () => this.isArchiveView,
      setArchiveView: (isArchiveView: boolean) => this.setArchiveView(isArchiveView),
      invalidate: () => this.invalidate(),
      profileListRender: (render: () => void) => this.profileListRender(render),
    };
    this.sidebar = new SessionSidebar({
      plugin: deps.plugin,
      navigation: deps.navigation,
      shared,
      isVisible: () => deps.isSidebarVisible(),
      canCreateTab: () => deps.canCreateTab(),
      requestNew: () => deps.requestNew(),
      flatHistory: deps.flatHistory,
      notifyOtherViews: () => deps.notifyOtherViews(),
    });
  }

  /** True while session search is composing IME input; Escape belongs to the composition. */
  get isComposing(): boolean {
    return this.sidebar.isComposing;
  }

  /** Builds the dual-pane sidebar surface inside `sidebarEl`. */
  mountSidebar(sidebarEl: HTMLElement, backEl?: HTMLButtonElement): void {
    this.sidebar.mount(sidebarEl, backEl);
  }

  /** Marks the history stale and re-renders it if visible. */
  invalidate(): void {
    this.sidebar.markDirty();
    if (this.deps.isSidebarVisible()) this.sidebar.render();
  }

  /** A hidden sidebar ends search; the toolbar always reopens the active history list. */
  hideHistory(): void {
    this.sidebar.leave();
    if (this.deps.flatHistory) this.setArchiveView(false);
  }

  addHistoryMenuItems(menu: Menu, showHistory: () => void): void {
    this.sidebar.addHistoryMenuItems(menu, showHistory);
  }

  focusSearch(): void {
    this.sidebar.activateSearch();
  }

  renderSidebar(): void {
    this.sidebar.render();
  }

  /** Handles Escape for inline rename and search; returns whether it was consumed. */
  handleEscape(): boolean {
    return this.browser.cancelInlineRename() || this.sidebar.dismissSearch();
  }

  /** Shows New only while another tab can be created. */
  refreshNewAvailability(): void {
    this.sidebar.refreshNewAvailability();
  }

  dispose(): void {
    this.browser.dispose();
    this.sidebar.dispose();
  }

  /** Switches between active and archived sessions; the switch always ends search. */
  private setArchiveView(isArchiveView: boolean): void {
    if (this.isArchiveView === isArchiveView) return;
    this.sidebar.discardSearch();
    this.isArchiveView = isArchiveView;
    this.sidebar.markDirty();
    if (this.deps.isSidebarVisible()) this.sidebar.render();
  }

  private profileListRender(render: () => void): void {
    const span = this.hasRenderedList ? null : StartupProfiler.start('history-list-render');
    this.hasRenderedList = true;
    try {
      render();
    } finally {
      if (span) StartupProfiler.finish(span);
    }
  }
}
