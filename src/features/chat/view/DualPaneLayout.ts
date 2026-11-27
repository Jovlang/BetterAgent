const WIDE_SESSION_LAYOUT_MIN_WIDTH = 600;
type HistoryVisibility = 'closed' | 'manual' | 'automatic';

// Each Obsidian leaf owns a history panel and disclosure button.
let nextHistoryPanelId = 0;

export interface DualPaneLayoutElements {
  containerEl: HTMLElement;
  sidebarEl: HTMLElement;
  history: {
    chatPanelEl: HTMLElement;
    toggleEl: HTMLButtonElement;
    backEl: HTMLButtonElement;
  };
}

export interface DualPaneLayoutHooks {
  /** The session sidebar should render its current state. */
  renderSidebar(): void;
  focusHistorySearch?(): void;
  /** End transient sidebar interactions when it is hidden. */
  onHideSidebar(): void;
}

/** Positions history without participating in conversation or composer lifecycle. */
export class DualPaneLayout {
  private elements: DualPaneLayoutElements | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private historyVisibility: HistoryVisibility = 'closed';

  constructor(private readonly hooks: DualPaneLayoutHooks) {}

  /** Adopts this open's DOM and measures it without rendering the sidebar. */
  initialize(elements: DualPaneLayoutElements): void {
    this.elements = elements;
    const { containerEl, sidebarEl, history } = elements;
    sidebarEl.id = `claudian-history-panel-${++nextHistoryPanelId}`;
    containerEl.addClass('claudian-chat-body--compact');
    this.setHistoryVisibility('closed');
    history.toggleEl.setAttribute('aria-controls', sidebarEl.id);
    history.toggleEl.addEventListener('click', () => this.setHistoryVisible(!this.historyVisible));
    history.backEl.addEventListener('click', () => this.closeHistory());

    containerEl.addClass('claudian-wide-session-layout');
    this.updateResponsiveHistory(containerEl.getBoundingClientRect().width);
  }

  get historyVisible(): boolean {
    return this.historyVisibility !== 'closed';
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
    if (!this.elements?.history || visible === this.historyVisible) return;
    this.setHistoryVisibility(visible ? 'manual' : 'closed');
    this.updateHistoryPresentation();
    if (visible) {
      this.hooks.renderSidebar();
      this.hooks.focusHistorySearch?.();
    } else {
      this.hooks.onHideSidebar();
    }
  }

  private setHistoryVisibility(visibility: HistoryVisibility): void {
    const elements = this.elements;
    if (!elements) return;
    this.historyVisibility = visibility;
    elements.sidebarEl.hidden = !this.historyVisible;
    elements.history.toggleEl.setAttribute('aria-expanded', String(this.historyVisible));
  }

  private updateResponsiveHistory(width: number): void {
    const elements = this.elements;
    if (!elements || width <= 0) return;
    const { containerEl, sidebarEl, history } = elements;
    const wasCompact = containerEl.classList.contains('claudian-chat-body--compact');
    const isCompact = width <= WIDE_SESSION_LAYOUT_MIN_WIDTH;
    containerEl.toggleClass('claudian-chat-body--compact', isCompact);

    if (wasCompact && !isCompact && !this.historyVisible) {
      // A resize can expose history, but must not interrupt typing in the composer.
      this.setHistoryVisibility('automatic');
    } else if (isCompact && this.historyVisibility === 'automatic') {
      const hadHistoryFocus = sidebarEl.contains(sidebarEl.ownerDocument.activeElement);
      this.setHistoryVisibility('closed');
      this.hooks.onHideSidebar();
      if (hadHistoryFocus) history.toggleEl.focus({ preventScroll: true });
    }
    this.updateHistoryPresentation();
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
    if (replacesChat && (focused === history.toggleEl || history.chatPanelEl.contains(focused))) {
      history.backEl.focus();
    } else if (!replacesChat && focused === history.backEl) {
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

  dispose(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.elements = null;
  }

  private update(width: number): void {
    this.updateResponsiveHistory(width);
    if (this.historyVisible) this.hooks.renderSidebar();
  }
}
