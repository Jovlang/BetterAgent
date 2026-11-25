import '@/providers';

import { getProviderSettingsSnapshotWithModel, resolveConversationModel } from '@/core/providers/conversationModel';
import type { Conversation } from '@/core/types';

describe('Claude unavailable model projections', () => {
  it('shows the same unavailable native model that execution will receive', () => {
    const settings = {
      model: 'sonnet', settingsProvider: 'codex',
      providerConfigs: { codex: {
        discoveredModels: [{ value: 'sonnet', label: 'Sonnet', description: '' }],
        visibleModels: ['sonnet'], defaultModel: 'sonnet',
      } },
    };
    const conversation = { providerId: 'codex', selectedModel: 'old-native-model' } as Conversation;
    const resolution = resolveConversationModel(settings, 'codex', conversation);
    expect(resolution.model).toBe('old-native-model');
    const snapshot = getProviderSettingsSnapshotWithModel(settings, 'codex', resolution.model);
    expect(snapshot.model).toBe('old-native-model');
    expect(settings.model).toBe('sonnet');
  });
});
