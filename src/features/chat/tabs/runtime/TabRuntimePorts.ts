import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import type { TabComposerPort, TabLinkedContentPort, TabPlacementPort } from '@/features/chat/tabs/ChatTab';
import type { TabRuntimeControllerBundle } from '@/features/chat/tabs/runtime/TabRuntimeConstruction';
import { refreshTabContextUsage } from '@/features/chat/tabs/tabProviderUI';
import type { AssembledTabRuntime, TabDOMElements, TabUIComponents } from '@/features/chat/tabs/types';

export interface TabRuntimePorts {
  readonly composer: TabComposerPort;
  readonly linkedContent: TabLinkedContentPort;
  readonly placement: TabPlacementPort;
  refreshProviderControls(): void;
}

/** Builds the host-view surface of a tab over its assembled UI, DOM, and controllers. */
export function buildTabRuntimePorts(
  dom: TabDOMElements,
  ui: TabUIComponents,
  controllerBundle: Pick<TabRuntimeControllerBundle, 'controllers'>,
  plugin: ChatFeatureHost,
  getRuntime: () => AssembledTabRuntime,
): TabRuntimePorts {
  const { controllers } = controllerBundle;
  return {
    composer: createTabComposerPort(dom.inputEl, ui),
    linkedContent: ui.linkedContentController,
    placement: createTabPlacementPort(
      dom,
      hostEl => controllers.sideChatController.setCollapsedHost(hostEl),
      hostEl => controllers.sideChatController.setFullHeightHost(hostEl),
    ),
    refreshProviderControls: () => {
      refreshTabContextUsage(getRuntime());
      ui.modelSelector.updateDisplay();
      ui.modelSelector.renderOptions();
      ui.effortSelector.updateDisplay();
      ui.permissionToggle.updateDisplay();
      ui.serviceTierToggle.updateDisplay();
    },
  };
}

/** Composer operations over a tab's own input and toolbar controls. */
export function createTabComposerPort(
  inputEl: TabDOMElements['inputEl'],
  ui: Pick<TabUIComponents, 'toolbarMenus' | 'composerDropdown' | 'fileContextManager'>,
): TabComposerPort {
  let previousFocus: HTMLElement | null = null;
  const isFocused = () => inputEl.contains(inputEl.ownerDocument.activeElement);
  return {
    focus: () => inputEl.focus(),
    isFocused,
    isVisible: () => inputEl.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
    toggleFocus: () => {
      if (isFocused()) {
        if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
        else inputEl.focus();
        return;
      }
      previousFocus = inputEl.ownerDocument.activeElement as HTMLElement | null;
      inputEl.focus();
    },
    appendText: (text) => {
      if (!text) return false;
      const currentValue = inputEl.value;
      const separator = currentValue && !/\s$/.test(currentValue) ? ' ' : '';
      if (inputEl.replaceText) inputEl.replaceText(currentValue.length, currentValue.length, `${separator}${text}`);
      else inputEl.value = `${currentValue}${separator}${text}`;

      const cursorPosition = inputEl.value.length;
      inputEl.selectionStart = cursorPosition;
      inputEl.selectionEnd = cursorPosition;

      const EventConstructor = inputEl.ownerDocument.defaultView?.Event ?? Event;
      inputEl.dispatchEvent(new EventConstructor('input', { bubbles: true }));
      inputEl.focus();
      return true;
    },
    closeOpenMenu: () => ui.toolbarMenus.closeOpenMenu(),
    dismissDropdownFor: (target) => {
      const dropdown = ui.composerDropdown;
      if (!dropdown.containsElement(target as Node) && target !== inputEl) dropdown.hide();
    },
    setHiddenCommands: commands => ui.composerDropdown.setHiddenCommands(commands),
  };
}

/** Placement over a tab's own composer and transcript nodes; nothing is rebuilt or cloned. */
export function createTabPlacementPort(
  dom: Pick<TabDOMElements, 'contentEl' | 'inputComposerEl' | 'inputEl' | 'infoRowEl'>,
  setSideChatChipHost: (hostEl: HTMLElement | null) => void,
  setSideChatFullHeightHost: (hostEl: HTMLElement | null) => void,
): TabPlacementPort {
  const { contentEl, inputComposerEl: composerEl } = dom;
  return {
    placeComposer: (slotEl) => {
      const ownerDocument = composerEl.ownerDocument;
      const hadFocus = ownerDocument ? composerEl.contains(ownerDocument.activeElement) : false;
      slotEl.appendChild(composerEl);
      // Reparenting drops focus; restore it only when the composer already owned it.
      if (hadFocus && !composerEl.contains(ownerDocument.activeElement)) dom.inputEl.focus();
    },
    isComposerPlacedIn: slotEl => composerEl.parentElement === slotEl,
    placeComposerActions: (actions) => {
      if (actions[0] && actions[0].parentElement !== dom.infoRowEl) {
        dom.infoRowEl.append(...actions);
      }
    },
    restoreComposer: () => {
      contentEl.appendChild(composerEl);
    },
    setSideChatChipHost,
    setSideChatFullHeightHost,
  };
}
