import type { App } from 'obsidian';

import type { TabId } from '@/features/chat/ChatFeatureHost';
import type { DraftSessionHold } from '@/features/chat/sessions/SessionRuntimePool';
import type { ParkedDrafts } from '@/features/chat/tabs/ParkedDrafts';
import type { NavigationRequestCheck, TabConversationNavigation } from '@/features/chat/tabs/TabConversationNavigation';
import { commitProvisionalTab } from '@/features/chat/tabs/TabLifecycle';
import type { AssembledTabRuntime, DraftSeed, TabMembershipView } from '@/features/chat/tabs/types';

/** Whether Linked content still exists; vaults without path lookup accept every path. */
export function linkedContentExists(app: Pick<App, 'vault'>, contentPath: string): boolean {
  const { vault } = app;
  return typeof vault.getAbstractFileByPath !== 'function'
    || vault.getAbstractFileByPath(contentPath) !== null;
}

/** Manager-owned operations the slot drives and revalidates after every await. */
export interface ViewerSlotHost {
  readonly app: Pick<App, 'vault'>;
  readonly membership: TabMembershipView;
  /** The manager's navigation queue; slot requests supersede and are superseded by its opens. */
  readonly navigation: TabConversationNavigation;
  /** Unsent text no presentation shows; assemblies and rebinds take what is held for them. */
  readonly parkedDrafts: ParkedDrafts;
  /** A seed is applied before the preview is published, so no first input can be admitted without it. */
  createPreview(conversationId: string | null, draftSessionKey?: string, seed?: DraftSeed): Promise<AssembledTabRuntime | null>;
  /** Keeps a draft session alive while nothing shows it. */
  holdDraft(tab: AssembledTabRuntime): DraftSessionHold;
  switchToTab(tabId: TabId): Promise<void>;
  closeTab(tabId: TabId): Promise<boolean>;
  discardTab(tabId: TabId): Promise<boolean>;
  /** Rebinds a preview, parking its unsent text with the session it leaves. */
  rebind(tab: AssembledTabRuntime, conversationId: string, isCurrent: NavigationRequestCheck): Promise<AssembledTabRuntime | null>;

}

export interface ViewerSlotRequest {
  /** The tab whose command issued the request; the request lapses once it stops being live. */
  sourceTab?: AssembledTabRuntime | null;
  /** Further validity the request keeps through the destination's assembly and hydration. */
  isValid?: () => boolean;
}

/** Replaces the shown conversation without stopping its session or losing its draft. */
export class ViewerSlot {
  /** The wide layout's new session while another session is shown; New returns to it. */
  #newSession: DraftSessionHold | null = null;

  constructor(private readonly host: ViewerSlotHost) {}

  /** Shows a session: its live owner elsewhere or a preview already showing it, otherwise the preview. */
  async show(conversationId: string, request: ViewerSlotRequest = {}): Promise<void> {
    const { isValid = () => true } = request;
    await this.host.navigation.enqueue(request.sourceTab ?? null, async (isCurrent) => {
      await this.#show(conversationId, () => isCurrent() && isValid());
    });
  }

  /**
   * Replaces the preview with a blank draft, optionally linked to `linkedContentPath`.
   */
  async startDraft(options: ViewerSlotRequest & DraftSeed = {}): Promise<void> {
    const { linkedContentPath, sourceTab = null } = options;
    if (sourceTab && !this.host.membership.isTabAlive(sourceTab)) return;
    this.#assertLinkedContentExists(linkedContentPath);

    await this.host.navigation.enqueue(null, async (isCurrent) => {
      await this.#startDraft(isCurrent, { linkedContentPath });
    });
  }

  /** Ends the slot's hold on the wide layout's new session when the view's tabs are destroyed. */
  dispose(): void {
    this.#newSession?.release();
    this.#newSession = null;
  }

  async #show(conversationId: string, isCurrent: NavigationRequestCheck): Promise<void> {
    const { host } = this;
    const { membership } = host;
    if (await host.navigation.focusOwner(conversationId, isCurrent, { previewsOnly: true }) || !isCurrent()) return;

    const preview = this.#livePreviews()[0];
    if (preview) {
      if (!preview.conversationId) this.#rememberNewSession(preview);
      const switched = await host.rebind(preview, conversationId, isCurrent);
      if (switched && membership.isTabAlive(switched)) {
        await host.switchToTab(switched.id);
        return;
      }
      if (!isCurrent()) return;
    }

    // Selections never rebind a narrow tab: when no preview can show the session, create one.
    const createdTab = await host.createPreview(conversationId);
    if (!isCurrent() && createdTab) await this.#discardUnowned(createdTab, conversationId);
  }

  /**
   * Shows a new draft or returns to the draft remembered when browsing History.
   */
  async #startDraft(
    isCurrent: NavigationRequestCheck,
    seed: DraftSeed,
  ): Promise<AssembledTabRuntime | null> {
    const { membership, parkedDrafts } = this.host;
    const { linkedContentPath } = seed;
    this.#assertLinkedContentExists(linkedContentPath);
    const reuseDraft = linkedContentPath === undefined;
    const active = this.#activePreview();
    // The shown blank draft already is the new session.
    if (active && !active.conversationId && reuseDraft) {
      active.linkedContent.reopenAutoDraft();
      active.composer.focus();
      return active;
    }
    const held = this.#currentNewSession();
    const newSession = reuseDraft ? held : null;
    for (const preview of this.#livePreviews()) {
      // A blank draft this one replaces becomes the new session New can return to, unless one is being reused.
      if (!preview.conversationId && !newSession) this.#rememberNewSession(preview);
      parkedDrafts.park(preview);
    }
    const tab = await this.host.createPreview(null, newSession?.key, seed);
    if (!tab) throw new Error('Failed to create a provisional chat tab');
    // Attached again, the new session no longer needs the slot's hold.
    if (this.#newSession?.key === tab.session.runtime.sessionKey) {
      this.#newSession.release();
      this.#newSession = null;
    }
    if (!isCurrent()) {
      await this.#discardUnowned(tab, null);
      return null;
    }
    try {
      if (newSession) tab.linkedContent.reopenAutoDraft();
      // Assembly applied the seed before publishing the draft.
      if (membership.getActiveTabId() === tab.id) tab.composer.focus();
    } catch (error) {
      await this.host.closeTab(tab.id).catch(() => false);
      throw error;
    }
    // One preview per view: the draft replaces every earlier one.
    await this.#closePreviews(tab.id);
    return tab;
  }

  /** The held new session, released once it has created its conversation: it is no longer new. */
  #currentNewSession(): DraftSessionHold | null {
    if (this.#newSession?.runtime.conversationId) {
      this.#newSession.release();
      this.#newSession = null;
    }
    return this.#newSession;
  }

  /** Holds a blank preview's draft session so New can return to it after another is shown. */
  #rememberNewSession(preview: AssembledTabRuntime): void {
    if (this.#newSession?.key === preview.session.runtime.sessionKey) return;
    this.#newSession?.release();
    this.#newSession = this.host.holdDraft(preview);
  }

  #activePreview(): AssembledTabRuntime | null {
    const { membership } = this.host;
    const activeId = membership.getActiveTabId();
    const active = activeId ? membership.getTab(activeId) : null;
    return active && membership.isTabAlive(active) && active.lifecycleState === 'provisional' ? active : null;
  }

  #livePreviews(): AssembledTabRuntime[] {
    const { membership } = this.host;
    return membership.getAllTabs()
      .filter(tab => membership.isTabAlive(tab) && tab.lifecycleState === 'provisional');
  }

  async #closePreviews(keptTabId: TabId): Promise<void> {
    const { membership } = this.host;
    const previewIds = membership.getAllTabs()
      .filter(tab => tab.lifecycleState === 'provisional' && tab.id !== keptTabId)
      .map(tab => tab.id);
    for (const tabId of previewIds) {
      const tab = membership.getTab(tabId);
      if (!tab || !membership.isTabAlive(tab) || tab.lifecycleState !== 'provisional') continue;
      if (await this.host.closeTab(tabId)) continue;
      const refused = membership.getTab(tabId);
      if (refused && membership.isTabAlive(refused)) commitProvisionalTab(refused);
    }
  }

  /** Removes a preview a superseded request created, unless the user already claimed it. */
  async #discardUnowned(tab: AssembledTabRuntime, conversationId: string | null): Promise<void> {
    if (
      this.host.membership.getTab(tab.id) === tab
      && tab.conversationId === conversationId
      && !tab.session.isUserClaimed
    ) {
      await this.host.discardTab(tab.id);
    }
  }

  #assertLinkedContentExists(contentPath: string | undefined): void {
    if (contentPath !== undefined && !linkedContentExists(this.host.app, contentPath)) {
      throw new Error('Linked content is no longer available');
    }
  }
}
