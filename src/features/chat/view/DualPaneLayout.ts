import { Notice } from 'obsidian';

import { t } from '@/i18n/i18n';

const WIDE_SESSION_LAYOUT_MIN_WIDTH = 600;
const MIN_CHAT_PANEL_WIDTH = 320;
const MIN_SESSION_SIDEBAR_WIDTH = 180;
const SESSION_RESIZER_WIDTH = 5;
const SESSION_RESIZE_KEYBOARD_STEP = 16;

// Each Obsidian leaf owns a history panel and disclosure button.
let nextHistoryPanelId = 0;

export interface DualPaneLayoutSettings {
  enableDualPane?: boolean;
  dualPaneSide?: 'left' | 'right';
}

export interface DualPaneLayoutElements {
  containerEl: HTMLElement;
  sidebarEl: HTMLElement;
  resizerEl?: HTMLElement;
  history?: {
    chatPanelEl: HTMLElement;
    toggleEl: HTMLButtonElement;
    backEl: HTMLButtonElement;
    searchEl: HTMLButtonElement;
  };
}

export interface DualPaneLayoutHooks {
  getSettings(): DualPaneLayoutSettings | undefined;
  /** The wide flag flipped; presentation that depends on it must follow. */
  onWideChanged(): void;
  /** A wide layout was requested; single-pane surfaces must close. */
  onEnterWide(): void;
  /** The session sidebar should render its current state. */
  renderSidebar(): void;
  /** End transient sidebar interactions when it is hidden. */
  onHideSidebar(): void;
  /** Releases the viewer slot (retaining what must survive) before compact controls return. */
  releaseViewerSlot(): Promise<void> | void;
}

/**
 * Owns the dual-pane decision for one view: the measured width request, the
 * revisioned compact transition, and the session sidebar width. It is the only
 * writer of `isWide`.
 */
export class DualPaneLayout {
  private elements: DualPaneLayoutElements | null = null;
  private wide = false;
  private requestedWide = false;
  private requestRevision = 0;
  /** The latest request to leave the wide layout; only it reports a failed preview cleanup. */
  private compactRequestRevision = 0;
  private resizeObserver: ResizeObserver | null = null;
  private resizeCleanup: (() => void) | null = null;
  private sidebarWidth: number | null = null;

  constructor(
    private readonly hooks: DualPaneLayoutHooks,
    private readonly options?: { singleViewer?: boolean },
  ) {}

  get isWide(): boolean {
    return this.wide;
  }

  /** Adopts this open's DOM and measures it without rendering the sidebar. */
  initialize(elements: DualPaneLayoutElements): void {
    this.elements = elements;
    const { containerEl, resizerEl, sidebarEl, history } = elements;
    if (resizerEl) {
      resizerEl.setAttribute('role', 'separator');
      resizerEl.setAttribute('aria-label', t('chat.tabNavigation.resize'));
      resizerEl.setAttribute('aria-orientation', 'vertical');
      resizerEl.setAttribute('tabindex', '0');
      resizerEl.addEventListener('pointerdown', (event) => this.startResize(event));
      resizerEl.addEventListener('keydown', (event) => this.handleResizeKeydown(event));
    }
    if (history) {
      sidebarEl.id = `claudian-history-panel-${++nextHistoryPanelId}`;
      sidebarEl.hidden = true;
      history.toggleEl.setAttribute('aria-controls', sidebarEl.id);
      history.toggleEl.setAttribute('aria-expanded', 'false');
      history.toggleEl.addEventListener('click', () => this.setHistoryVisible(sidebarEl.hasAttribute('hidden')));
      history.backEl.addEventListener('click', () => this.closeHistory());
    }

    this.requestedWide = false;
    this.wide = false;
    containerEl.removeClass('claudian-wide-session-layout');
    this.update(containerEl.getBoundingClientRect().width, { renderSidebar: false });
  }

  get historyVisible(): boolean {
    return !!this.elements?.history && !this.elements.sidebarEl.hidden;
  }

  closeHistory(narrowOnly = false): boolean {
    const history = this.elements?.history;
    if (!history || !this.historyVisible) return false;
    if (narrowOnly && !history.chatPanelEl.hasAttribute('inert')) return false;
    this.setHistoryVisible(false);
    history.toggleEl.focus();
    return true;
  }

  setHistoryVisible(visible: boolean): void {
    const elements = this.elements;
    if (!elements?.history || visible === this.historyVisible) return;
    elements.sidebarEl.hidden = !visible;
    elements.history.toggleEl.setAttribute('aria-expanded', String(visible));
    this.updateHistoryPresentation();
    if (visible) {
      this.hooks.renderSidebar();
      if (!elements.history.backEl.hidden) elements.history.backEl.focus();
    } else {
      this.hooks.onHideSidebar();
    }
  }

  private updateHistoryPresentation(): void {
    const elements = this.elements;
    const history = elements?.history;
    if (!history) return;
    const replacesChat = this.historyVisible
      && elements.containerEl.classList.contains('claudian-chat-body--compact');
    const focused = elements.containerEl.ownerDocument.activeElement;
    history.chatPanelEl.toggleAttribute('inert', replacesChat);
    history.backEl.hidden = !replacesChat;
    history.searchEl.hidden = !replacesChat;
    if (replacesChat && (focused === history.toggleEl || history.chatPanelEl.contains(focused))) {
      history.backEl.focus();
    } else if (!replacesChat && (focused === history.backEl || focused === history.searchEl)) {
      history.toggleEl.focus();
    }
  }

  /** Follows the container width once the tab workspace is initialized. */
  startObserving(): void {
    const containerEl = this.elements?.containerEl;
    if (!containerEl) return;

    const ResizeObserverConstructor = containerEl.ownerDocument.defaultView?.ResizeObserver;
    if (typeof ResizeObserverConstructor === 'function') {
      this.resizeObserver = new ResizeObserverConstructor((entries) => {
        const entry = entries.at(-1);
        this.update(entry?.contentRect.width ?? containerEl.getBoundingClientRect().width);
      });
      this.resizeObserver.observe(containerEl);
    }

    this.update(containerEl.getBoundingClientRect().width);
  }

  /** Re-applies settings that affect the layout to the current width. */
  refresh(): void {
    const containerEl = this.elements?.containerEl;
    if (!containerEl) return;
    this.update(containerEl.getBoundingClientRect().width);
  }

  /** Supersedes any pending transition and releases observers and resize listeners. */
  dispose(): void {
    this.requestRevision += 1;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.stopResize();
  }

  private update(width: number, options: { renderSidebar?: boolean } = {}): void {
    const containerEl = this.elements?.containerEl;
    if (!containerEl) return;
    const singleViewer = this.options?.singleViewer === true;
    // A hidden view reports zero width. Select the viewer on first mount, but don't
    // rearrange its history when the host hides the already-mounted chat.
    if (width <= 0 && (!singleViewer || this.requestedWide)) return;
    const history = this.elements?.history;
    if (history) {
      containerEl.toggleClass('claudian-chat-body--compact', width < WIDE_SESSION_LAYOUT_MIN_WIDTH);
      this.updateHistoryPresentation();
    }
    const renderSidebar = options.renderSidebar ?? true;
    const settings = this.hooks.getSettings();

    containerEl.toggleClass('claudian-session-sidebar-left', this.isHistoryOnLeft());

    const shouldUseWideLayout = singleViewer || ((settings?.enableDualPane ?? true)
      && width >= WIDE_SESSION_LAYOUT_MIN_WIDTH);
    if (shouldUseWideLayout === this.requestedWide) {
      if (shouldUseWideLayout && this.wide) {
        if (this.sidebarWidth !== null && width >= WIDE_SESSION_LAYOUT_MIN_WIDTH) {
          this.setSidebarWidth(this.sidebarWidth);
        }
        if (renderSidebar && !this.elements?.sidebarEl.hidden) this.hooks.renderSidebar();
      }
      return;
    }

    this.requestedWide = shouldUseWideLayout;
    const requestRevision = ++this.requestRevision;

    if (shouldUseWideLayout) {
      if (!this.wide) {
        this.wide = true;
        containerEl.addClass('claudian-wide-session-layout');
        this.hooks.onWideChanged();
      }
      this.hooks.onEnterWide();
      if (renderSidebar) this.hooks.renderSidebar();
      return;
    }

    if (!this.wide) return;

    this.hooks.onHideSidebar();
    this.stopResize();
    this.compactRequestRevision = requestRevision;
    void this.completeCompactTransition(requestRevision);
  }

  private async completeCompactTransition(requestRevision: number): Promise<void> {
    // The viewer slot owns preview cleanup and joins overlapping requests to one run.
    try {
      await this.hooks.releaseViewerSlot();
    } catch {
      // Overlapping requests share one cleanup, so only the latest one reports its failure.
      if (requestRevision === this.compactRequestRevision) {
        new Notice(t('chat.tabNavigation.previewCloseFailed'));
      }
    }
    const containerEl = this.elements?.containerEl;
    if (requestRevision !== this.requestRevision || this.requestedWide || !containerEl) return;

    this.wide = false;
    containerEl.removeClass('claudian-wide-session-layout');
    this.hooks.onWideChanged();
  }

  private startResize(event: PointerEvent): void {
    const elements = this.elements;
    if (!this.wide || event.button !== 0 || !elements) return;

    event.preventDefault();
    this.stopResize();

    const ownerDocument = (event.currentTarget as HTMLElement).ownerDocument;
    const startX = event.clientX;
    const startWidth = this.sidebarWidth ?? elements.sidebarEl.getBoundingClientRect().width;

    const handlePointerMove = (moveEvent: PointerEvent): void => {
      const direction = this.isHistoryOnLeft() ? 1 : -1;
      this.setSidebarWidth(startWidth + direction * (moveEvent.clientX - startX));
    };
    const handlePointerEnd = (): void => this.stopResize();

    ownerDocument.addEventListener('pointermove', handlePointerMove);
    ownerDocument.addEventListener('pointerup', handlePointerEnd);
    ownerDocument.addEventListener('pointercancel', handlePointerEnd);
    elements.containerEl.addClass('claudian-resizing-session-sidebar');
    this.resizeCleanup = () => {
      ownerDocument.removeEventListener('pointermove', handlePointerMove);
      ownerDocument.removeEventListener('pointerup', handlePointerEnd);
      ownerDocument.removeEventListener('pointercancel', handlePointerEnd);
      elements.containerEl.removeClass('claudian-resizing-session-sidebar');
    };
  }

  private stopResize(): void {
    const cleanup = this.resizeCleanup;
    this.resizeCleanup = null;
    cleanup?.();
  }

  private handleResizeKeydown(event: KeyboardEvent): void {
    const elements = this.elements;
    if (!this.wide || !elements) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;

    event.preventDefault();
    const currentWidth = this.sidebarWidth ?? elements.sidebarEl.getBoundingClientRect().width;
    const growsToward = this.isHistoryOnLeft()
      ? 'ArrowRight'
      : 'ArrowLeft';
    const delta = event.key === growsToward
      ? SESSION_RESIZE_KEYBOARD_STEP
      : -SESSION_RESIZE_KEYBOARD_STEP;
    this.setSidebarWidth(currentWidth + delta);
  }

  private isHistoryOnLeft(): boolean {
    return !this.options?.singleViewer && this.hooks.getSettings()?.dualPaneSide === 'left';
  }

  private setSidebarWidth(requestedWidth: number): void {
    const elements = this.elements;
    if (!elements) return;

    const totalWidth = elements.containerEl.getBoundingClientRect().width;
    const maxWidth = Math.max(
      MIN_SESSION_SIDEBAR_WIDTH,
      totalWidth - MIN_CHAT_PANEL_WIDTH - SESSION_RESIZER_WIDTH,
    );
    const width = Math.round(Math.min(
      Math.max(requestedWidth, MIN_SESSION_SIDEBAR_WIDTH),
      maxWidth,
    ));

    this.sidebarWidth = width;
    elements.containerEl.style.setProperty('--claudian-session-sidebar-width', `${width}px`);
    elements.resizerEl?.setAttribute('aria-valuenow', String(width));
    elements.resizerEl?.setAttribute('aria-valuemin', String(MIN_SESSION_SIDEBAR_WIDTH));
    elements.resizerEl?.setAttribute('aria-valuemax', String(Math.round(maxWidth)));
  }
}
