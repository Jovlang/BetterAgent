import '@/providers';

import { TEST_CODEX_CATALOG } from '@test/helpers/codexModels';

import { getProviderSettingsSnapshotWithModel, resolveConversationModel } from '@/core/providers/conversationModel';
import type { Conversation } from '@/core/types';

describe('Codex unavailable model projections', () => {
  it('shows the same unavailable native model that execution will receive', () => {
    const settings = {
      model: 'gpt-5.5', settingsProvider: 'codex',
      providerConfigs: { codex: {
        discoveredModels: TEST_CODEX_CATALOG,
        visibleModels: ['gpt-5.5'],
      } },
    };
    const conversation = { providerId: 'codex', selectedModel: 'old-native-model' } as Conversation;
    const resolution = resolveConversationModel(settings, 'codex', conversation);
    expect(resolution.model).toBe('old-native-model');
    const snapshot = getProviderSettingsSnapshotWithModel(settings, 'codex', resolution.model);
    expect(snapshot.model).toBe('old-native-model');
    expect(settings.model).toBe('gpt-5.5');
  });
});
