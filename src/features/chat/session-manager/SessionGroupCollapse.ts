import { isLineageFoldKey } from '@/features/chat/session-manager/SessionLineage';

/** Tracks collapsed history groups and explicit choices for lineage folds. */
export class SessionGroupCollapse {
  /** Keys toggled away from their default state. */
  readonly #toggled = new Set<string>();
  /** Folds the user opened or closed; their default changes with the current session, so the choice is kept as is. */
  readonly #foldChoices = new Map<string, boolean>();

  isCollapsed(groupKey: string, defaultCollapsed = true): boolean {
    if (isLineageFoldKey(groupKey)) return this.#foldChoices.get(groupKey) ?? defaultCollapsed;
    return this.#toggled.has(groupKey);
  }

  setCollapsed(groupKey: string, collapsed: boolean): void {
    if (isLineageFoldKey(groupKey)) {
      this.#foldChoices.set(groupKey, collapsed);
      return;
    }
    if (collapsed) {
      this.#toggled.add(groupKey);
    } else {
      this.#toggled.delete(groupKey);
    }
  }
}
