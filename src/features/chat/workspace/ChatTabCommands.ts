import type { Command, Workspace } from 'obsidian';

import { VIEW_TYPE_CLAUDIAN } from '@/core/types';
import type { ChatViewHost } from '@/features/chat/ChatFeatureHost';
import { t } from '@/i18n/i18n';

export interface ChatTabCommandsDeps {
  readonly workspace: Pick<Workspace, 'getLeavesOfType'>;
  readonly views: {
    getView(): ChatViewHost | null;
    activateView(): Promise<void>;
  };
}

/** Starts a new conversation in the focused chat view. The command ID preserves hotkeys. */
export function createChatTabCommands(deps: ChatTabCommandsDeps): Command[] {
  const { views } = deps;

  const canStartNewChat = (): boolean => {
    if (views.getView()?.getTabManager()) return true;
    // A mounted leaf whose view has not initialized its tabs cannot take the command yet.
    return deps.workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN).length === 0;
  };

  const startNew = async (): Promise<void> => {
    const existingView = views.getView();
    if (existingView) {
      await existingView.startNewConversation();
      return;
    }
    await views.activateView();
    views.getView()?.focusActiveInput();
  };

  return [
    {
      id: 'new-tab',
      name: t('chat.tabNavigation.commandNew'),
      checkCallback: (checking: boolean) => {
        if (!canStartNewChat()) return false;
        if (!checking) void startNew();
        return true;
      },
    },
  ];
}
