import { setIcon } from 'obsidian';

import { t } from '@/i18n/i18n';

/** Read-only conversation fact shown in the info row; it may still be opened or, before the first message, removed. */
export interface ComposerInfoItem {
  label: string;
  icon?: string;
  ariaLabel?: string;
  missing?: boolean;
  onActivate: (anchorEl: HTMLElement) => void;
  onRemove?: () => void;
}

/** Owns the Linked content chip below the composer. */
export class ComposerInfoRow {
  private readonly linkedSlotEl: HTMLElement;

  constructor(private readonly containerEl: HTMLElement) {
    this.containerEl.addClass('claudian-input-info-row');
    this.linkedSlotEl = this.containerEl.createDiv({ cls: 'claudian-input-info-linked' });
  }

  setLinkedContent(item: ComposerInfoItem | null): void {
    this.#renderSlot(this.linkedSlotEl, item);
  }

  destroy(): void {
    this.linkedSlotEl.empty();
  }

  #renderSlot(slotEl: HTMLElement, item: ComposerInfoItem | null): void {
    const active = slotEl.ownerDocument.activeElement;
    const focusClass = active && slotEl.contains(active)
      ? active.classList.contains('claudian-input-info-linked-remove')
        ? 'claudian-input-info-linked-remove' : 'claudian-input-info-linked-main'
      : null;
    slotEl.empty();
    slotEl.toggleClass('claudian-input-info-linked--missing', item?.missing === true);
    if (!item) return;
    const label = item.ariaLabel ?? item.label;
    const mainEl = slotEl.createEl('button', {
      cls: 'claudian-input-info-linked-main',
      attr: { type: 'button', 'aria-label': label },
    });
    mainEl.addEventListener('click', () => item.onActivate(mainEl));
    if (item.icon) {
      const iconEl = mainEl.createSpan({ cls: 'claudian-input-info-linked-icon' });
      iconEl.setAttribute('aria-hidden', 'true');
      setIcon(iconEl, item.icon);
    }
    mainEl.createSpan({ cls: 'claudian-input-info-linked-label', text: item.label });

    if (item.onRemove) {
      const removeEl = slotEl.createEl('button', {
        cls: 'claudian-input-info-linked-remove',
        text: '×',
        attr: { type: 'button', 'aria-label': t('chat.removeItem', { item: label }) },
      });
      removeEl.addEventListener('click', item.onRemove);
    }
    if (focusClass) slotEl.querySelector<HTMLElement>(`.${focusClass}`)?.focus({ preventScroll: true });
  }
}
