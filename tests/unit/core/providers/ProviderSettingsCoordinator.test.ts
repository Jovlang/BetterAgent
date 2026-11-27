import '@test/helpers/registeredCodex';

import { codexCatalogFixture } from '@test/helpers/codexModels';
import { TEST_CODEX_CATALOG, TEST_CODEX_MODEL } from '@test/helpers/codexModels';

import { getProviderSettingsSnapshotWithModel } from '@/core/providers/conversationModel';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import type { ProviderSettingsReconciler } from '@/core/providers/types';
import { DEFAULT_CODEX_PROVIDER_CONFIG } from '@/providers/codex/config';


describe('ProviderSettingsCoordinator', () => {
  it('commits Codex reasoning without overwriting the model or unrelated settings', () => {
    const settings = {
      settingsProvider: 'codex', model: TEST_CODEX_MODEL, effortLevel: 'low', locale: 'en',
      savedProviderModel: { codex: TEST_CODEX_MODEL }, savedProviderEffort: { codex: 'low' },
      providerConfigs: { codex: { enabled: true, discoveredModels: TEST_CODEX_CATALOG } },
    };
    const before = getProviderSettingsSnapshotWithModel(settings, 'codex', TEST_CODEX_MODEL);
    const after = { ...structuredClone(before), effortLevel: 'high', locale: 'fr' };
    ProviderSettingsCoordinator.commitProviderSettingsChange(settings, 'codex', before, after);
    expect(settings).toMatchObject({
      model: `openai-codex/${TEST_CODEX_MODEL}`, locale: 'en', savedProviderEffort: { codex: 'high' },
    });
  });

  describe('conversation model projection', () => {
    it('preserves a valid explicit reasoning choice when reading an existing conversation', () => {
      const settings: Record<string, unknown> = {
        settingsProvider: 'codex',
        model: TEST_CODEX_MODEL,
        effortLevel: 'low',
        serviceTier: 'default',
        savedProviderModel: { codex: TEST_CODEX_MODEL },
        savedProviderEffort: { codex: 'low' },
        providerConfigs: {
          codex: {
            enabled: true,
            discoveredModels: TEST_CODEX_CATALOG,
          },
        },
      };

      const snapshot = getProviderSettingsSnapshotWithModel(
        settings,
        'codex',
        TEST_CODEX_MODEL,
      );

      expect(snapshot.effortLevel).toBe('low');
      expect(settings.effortLevel).toBe('low');
    });

    it('preserves an opted-in ultra effort across Codex provider and conversation projections', () => {
      const ultraModel = {
        ...TEST_CODEX_CATALOG[0],
        model: 'gpt-5.6-sol',
        supportedReasoningEfforts: [
          { value: 'max', description: 'Maximum reasoning' },
          { value: 'ultra', description: 'Automatic task delegation' },
        ],
        defaultReasoningEffort: 'max',
      };
      const settings: Record<string, unknown> = {
        settingsProvider: 'claude',
        model: 'haiku',
        effortLevel: 'high',
        serviceTier: 'default',
        savedProviderModel: { codex: ultraModel.model },
        savedProviderEffort: { codex: 'ultra' },
        savedProviderServiceTier: { codex: 'default' },
        providerConfigs: {
          codex: {
            enabled: true,
            enableUltraEffort: true,
            discoveredModels: [ultraModel],
          },
        },
      };

      const conversationSnapshot = getProviderSettingsSnapshotWithModel(
        settings,
        'codex',
        ultraModel.model,
      );
      ProviderSettingsCoordinator.projectProviderState(settings, 'codex');

      expect(conversationSnapshot.effortLevel).toBe('ultra');
      expect(settings.effortLevel).toBe('ultra');
    });

    it.each([
      {
        caseName: 'legacy Fast with no catalog default',
        storedServiceTier: 'fast',
        defaultServiceTier: null,
        expectedServiceTier: 'priority',
      },
      {
        caseName: 'explicit Standard with a Fast catalog default',
        storedServiceTier: 'default',
        defaultServiceTier: 'priority',
        expectedServiceTier: 'default',
      },
      {
        caseName: 'an advertised tier beyond Fast',
        storedServiceTier: 'ultrafast',
        defaultServiceTier: null,
        extraServiceTiers: [{ id: 'ultrafast', name: 'Ultrafast', description: 'Lowest latency' }],
        expectedServiceTier: 'ultrafast',
      },
    ])('canonicalizes $caseName for a model snapshot', ({
      storedServiceTier,
      defaultServiceTier,
      extraServiceTiers = [],
      expectedServiceTier,
    }) => {
      const discoveredModels = TEST_CODEX_CATALOG.map(model => model.model === TEST_CODEX_MODEL
        ? { ...model, defaultServiceTier, serviceTiers: [...model.serviceTiers, ...extraServiceTiers] }
        : model);
      const settings: Record<string, unknown> = {
        settingsProvider: 'codex',
        model: TEST_CODEX_MODEL,
        effortLevel: 'medium',
        serviceTier: storedServiceTier,
        providerConfigs: {
          codex: {
            enabled: true,
            discoveredModels,
          },
        },
      };

      const conversationSnapshot = getProviderSettingsSnapshotWithModel(
        settings,
        'codex',
        TEST_CODEX_MODEL,
      );

      expect(conversationSnapshot.serviceTier).toBe(expectedServiceTier);
    });
  });

  describe('selected model snapshot', () => {
    it('clamps reasoning and service tier values to the selected model metadata', () => {
      const settings: Record<string, unknown> = {
        model: TEST_CODEX_MODEL,
        effortLevel: 'unsupported',
        serviceTier: 'priority',
        providerConfigs: {
          codex: {
            enabled: true,
            discoveredModels: TEST_CODEX_CATALOG,
          },
        },
      };

      const snapshot = getProviderSettingsSnapshotWithModel(settings, 'codex', 'gpt-5.4-mini');

      expect(snapshot.model).toBe('openai-codex/gpt-5.4-mini');
      expect(snapshot.effortLevel).toBe('high');
      expect(snapshot.serviceTier).toBe('default');
      expect(settings.model).toBe(TEST_CODEX_MODEL);
      expect(settings.effortLevel).toBe('unsupported');
      expect(settings.serviceTier).toBe('priority');
    });
  });

  describe('normalizeProviderSelection', () => {

    it('falls back to Codex for unknown providers', () => {
      const settings: Record<string, unknown> = {
        settingsProvider: 'mystery-provider',
        providerConfigs: {
          codex: { enabled: true, discoveredModels: TEST_CODEX_CATALOG },
        },
      };

      const changed = ProviderSettingsCoordinator.normalizeProviderSelection(settings);

      expect(changed).toBe(true);
      expect(settings.settingsProvider).toBe('codex');
    });

    it('returns false when already normalized (no-op)', () => {
      const settings: Record<string, unknown> = {
        settingsProvider: 'codex',
        providerConfigs: {
          codex: { enabled: false },
        },
      };
      expect(ProviderSettingsCoordinator.normalizeProviderSelection(settings)).toBe(false);
    });
  });

  describe('applyProviderEnablement', () => {
    it('preflights the sole enabled provider without mutating settings', () => {
      const settings: Record<string, unknown> = {
        providerConfigs: {
          codex: { ...DEFAULT_CODEX_PROVIDER_CONFIG, enabled: true },
        },
      };

      expect(ProviderSettingsCoordinator.canApplyProviderEnablement(
        settings,
        'codex',
        false,
      )).toBe(false);
      expect(ProviderSettingsCoordinator.canApplyProviderEnablement(
        settings,
        'codex',
        true,
      )).toBe(true);
      expect(ProviderRegistry.isEnabled('codex', settings)).toBe(true);
    });

    it('keeps the sole enabled provider enabled', () => {
      const settings: Record<string, unknown> = {
        settingsProvider: 'codex',
        model: 'sonnet',
        titleGenerationModel: '',
        providerConfigs: {
          codex: { ...DEFAULT_CODEX_PROVIDER_CONFIG, enabled: true },
        },
      };

      const accepted = ProviderSettingsCoordinator.applyProviderEnablement(
        settings,
        'codex',
        false,
      );

      expect(accepted).toBe(false);
      expect(ProviderRegistry.isEnabled('codex', settings)).toBe(true);
      expect(ProviderRegistry.getEnabledProviderIds(settings)).toEqual(['codex']);
      expect(settings.settingsProvider).toBe('codex');
    });
  });

  describe('reconcileProviders', () => {
    it('reports exactly the providers whose runtime inputs changed', () => {
      const changedReconciler: ProviderSettingsReconciler = {
        reconcileModelWithEnvironment: vi.fn(() => ({ changed: true })),
        normalizeModelVariantSettings: vi.fn(() => false),
      };
      const unchangedReconciler: ProviderSettingsReconciler = {
        reconcileModelWithEnvironment: vi.fn(() => ({ changed: false })),
        normalizeModelVariantSettings: vi.fn(() => false),
      };
      const originalGetSettingsReconciler = ProviderRegistry.getSettingsReconciler.bind(
        ProviderRegistry,
      );
      const originalGetChatUIConfig = ProviderRegistry.getModelPolicy.bind(ProviderRegistry);
      const reconcilerSpy = vi.spyOn(ProviderRegistry, 'getSettingsReconciler')
        .mockImplementation((providerId) => {
          if (providerId === 'fake-changed') return changedReconciler;
          if (providerId === 'fake-unchanged') return unchangedReconciler;
          return originalGetSettingsReconciler(providerId);
        });
      const settingsProviderSpy = vi.spyOn(ProviderRegistry, 'resolveSettingsProviderId')
        .mockReturnValue('fake-changed');
      const uiConfigSpy = vi.spyOn(ProviderRegistry, 'getModelPolicy')
        .mockImplementation((providerId) => (
          providerId === 'fake-changed' || providerId === 'fake-unchanged'
            ? originalGetChatUIConfig('codex')
            : originalGetChatUIConfig(providerId)
        ));
      const result = ProviderSettingsCoordinator.reconcileProviders(
        { model: 'haiku' },
        ['fake-unchanged', 'fake-changed'],
      );
      reconcilerSpy.mockRestore();
      settingsProviderSpy.mockRestore();
      uiConfigSpy.mockRestore();

      expect(result).toEqual({ changed: true, environmentChangedProviderIds: ['fake-changed'] });
    });
  });

  describe('normalizeAllModelVariants', () => {
    it('preserves the active Codex model when it is absent from discovery', () => {
      const settings: Record<string, unknown> = {
        settingsProvider: 'codex',
        model: 'gpt-5.4',
        providerConfigs: {
          codex: { enabled: true, discoveredModels: TEST_CODEX_CATALOG },
        },
        savedProviderModel: { codex: 'gpt-5.4' },
      };

      expect(ProviderSettingsCoordinator.normalizeAllModelVariants(settings)).toBe(false);
      expect(settings.model).toBe('gpt-5.4');
      expect(settings.savedProviderModel).toEqual({ codex: 'gpt-5.4' });
    });
  });

  describe('reconcileTitleGenerationModelSelection', () => {
    it('stores a Claude title model without inferring environment provenance', () => {
      const settings: Record<string, unknown> = {
        titleGenerationModel: '',
        providerConfigs: {
          claude: {
            ...DEFAULT_CODEX_PROVIDER_CONFIG,
            environmentVariables: 'ANTHROPIC_DEFAULT_FABLE_MODEL=gpt-4.1',
          },
        },
      };

      ProviderSettingsCoordinator.applyTitleGenerationModelSelection(
        settings,
        'claude-code/gpt-4.1',
      );

      expect(settings.titleGenerationModel).toBe('claude-code/gpt-4.1');
    });

    it('preserves titleGenerationModel when no provider exposes the saved model', () => {
      const settings: Record<string, unknown> = {
        titleGenerationModel: 'claude-opus-4-6',
        providerConfigs: {
          claude: {
            ...DEFAULT_CODEX_PROVIDER_CONFIG,
            customModels: '',
          },
        },
      };

      expect(
        ProviderSettingsCoordinator.reconcileTitleGenerationModelSelection(settings),
      ).toBe(false);
      expect(settings.titleGenerationModel).toBe('claude-opus-4-6');
    });

    it('preserves stale provider-qualified custom title models', () => {
      const settings: Record<string, unknown> = {
        titleGenerationModel: 'openai-codex/my-custom-model',
        providerConfigs: {
          codex: {
            enabled: true,
            customModels: '',
          },
        },
      };

      expect(
        ProviderSettingsCoordinator.reconcileTitleGenerationModelSelection(settings),
      ).toBe(false);
      expect(settings.titleGenerationModel).toBe('openai-codex/my-custom-model');
    });

    it('preserves title models owned by a disabled provider', () => {
      const settings: Record<string, unknown> = {
        titleGenerationModel: TEST_CODEX_MODEL,
        providerConfigs: {
          codex: {
            discoveredModels: TEST_CODEX_CATALOG,
            enabled: false,
          },
        },
      };

      expect(
        ProviderSettingsCoordinator.reconcileTitleGenerationModelSelection(settings),
      ).toBe(false);
      expect(settings.titleGenerationModel).toBe(TEST_CODEX_MODEL);
    });

    it('preserves unavailable raw custom title IDs', () => {
      const settings: Record<string, unknown> = {
        titleGenerationModel: 'my-custom-model',
        providerConfigs: {
          codex: {
            enabled: true,
            customModels: 'my-custom-model',
          },
        },
      };

      expect(
        ProviderSettingsCoordinator.reconcileTitleGenerationModelSelection(settings),
      ).toBe(false);
      expect(settings.titleGenerationModel).toBe('my-custom-model');
    });
  });

  describe('projectActiveProviderState', () => {
    it.each(['auto', 'manual', 'acceptEdits', 'yolo'])('defaults a new Codex selection to automatic review without inheriting Claude %s', permissionMode => {
      const settings = { settingsProvider: 'claude', permissionMode };
      expect(ProviderSettingsCoordinator.getProviderSettingsSnapshot(settings, 'codex').permissionMode)
        .toBe('auto-review');
      expect(settings.permissionMode).toBe(permissionMode);
    });

    it.each(['normal', 'auto-review', 'yolo'])('preserves the saved Codex permission %s', permissionMode => {
      const snapshot = ProviderSettingsCoordinator.getProviderSettingsSnapshot({
        settingsProvider: 'claude', permissionMode: 'normal',
        savedProviderPermissionMode: { codex: permissionMode },
      }, 'codex');
      expect(snapshot.permissionMode).toBe(permissionMode);
    });

    it.each(['codex'] as const)(
      'projects legacy plan permissions as Safe for %s',
      (providerId) => {
        for (const permissionMode of ['plan', 'yolo']) {
          const settings = {
            settingsProvider: providerId,
            permissionMode,
            savedProviderPermissionMode: { [providerId]: 'plan' },
          };
          const snapshot = ProviderSettingsCoordinator.getProviderSettingsSnapshot(settings, providerId);
          expect(snapshot.permissionMode).toBe('normal');
        }
      },
    );

    it.each(['codex'] as const)(
      'projects an unsaved legacy plan selection as Safe for %s',
      (providerId) => {
        const snapshot = ProviderSettingsCoordinator.getProviderSettingsSnapshot({
          settingsProvider: providerId,
          permissionMode: 'plan',
        }, providerId);
        expect(snapshot.permissionMode).toBe('normal');
      },
    );

    it.each([false, null, {}, 1])('fails a malformed saved Codex permission mode %o closed instead of reusing YOLO', (saved) => {
      const settings: Record<string, unknown> = {
        settingsProvider: 'codex',
        permissionMode: 'yolo',
        savedProviderPermissionMode: { codex: saved },
      };

      expect(ProviderSettingsCoordinator.getProviderSettingsSnapshot(settings, 'codex').permissionMode).toBe('normal');
      ProviderSettingsCoordinator.projectActiveProviderState(settings);
      expect(settings.permissionMode).toBe('normal');
    });

    it('projects saved model and effort for the settings provider', () => {
      const settings: Record<string, unknown> = {
        settingsProvider: 'codex',
        providerConfigs: {
          codex: { enabled: true, discoveredModels: TEST_CODEX_CATALOG },
        },
        permissionMode: 'yolo',
        model: 'haiku',
        effortLevel: 'high',
        serviceTier: 'default',
        savedProviderModel: { codex: TEST_CODEX_MODEL, claude: 'haiku' },
        savedProviderEffort: { codex: 'medium', claude: 'high' },
        savedProviderServiceTier: { codex: 'fast', claude: 'default' },
        savedProviderPermissionMode: { codex: 'normal', claude: 'yolo' },
      };

      ProviderSettingsCoordinator.projectActiveProviderState(settings);

      expect(settings.model).toBe(`openai-codex/${TEST_CODEX_MODEL}`);
      expect(settings.effortLevel).toBe('medium');
      expect(settings.serviceTier).toBe('fast');
      expect(settings.permissionMode).toBe('normal');
    });

    it('preserves a saved unavailable Codex model when projecting provider state', () => {
      const settings: Record<string, unknown> = {
        settingsProvider: 'claude',
        model: 'haiku',
        effortLevel: 'high',
        serviceTier: 'default',
        providerConfigs: {
          codex: { enabled: true, discoveredModels: TEST_CODEX_CATALOG },
        },
        savedProviderModel: { claude: 'haiku', codex: 'gpt-5.4' },
        savedProviderEffort: { claude: 'high', codex: 'medium' },
        savedProviderServiceTier: { claude: 'default', codex: 'fast' },
      };

      const snapshot = ProviderSettingsCoordinator.getProviderSettingsSnapshot(settings, 'codex');

      expect(snapshot.model).toBe('gpt-5.4');
      expect(snapshot.serviceTier).toBe('fast');
    });

    it('rejects arrays as provider projection maps when creating a snapshot', () => {
      const arrayProjection = Object.assign([], { codex: 'array-owned-value' });
      const settings: Record<string, unknown> = {
        settingsProvider: 'claude',
        model: 'haiku',
        effortLevel: 'high',
        serviceTier: 'default',
        providerConfigs: {
          codex: { enabled: true, discoveredModels: TEST_CODEX_CATALOG },
        },
        savedProviderModel: arrayProjection,
        savedProviderEffort: arrayProjection,
        savedProviderServiceTier: arrayProjection,
        savedProviderPermissionMode: arrayProjection,
      };

      const snapshot = ProviderSettingsCoordinator.getProviderSettingsSnapshot(settings, 'codex');

      expect(snapshot.savedProviderModel).toEqual({});
      expect(snapshot.savedProviderEffort).toEqual({});
      expect(snapshot.savedProviderServiceTier).toEqual({});
      expect(snapshot.savedProviderPermissionMode).toEqual({});
    });

    it('defaults to Codex when settingsProvider is not set', () => {
      const settings: Record<string, unknown> = {
        model: 'old-model',
        effortLevel: 'low',
        serviceTier: 'default',
        savedProviderModel: { codex: 'gpt-5.5' },
        savedProviderEffort: { codex: 'high' },
        savedProviderServiceTier: { codex: 'default' },
      };

      ProviderSettingsCoordinator.projectActiveProviderState(settings);

      expect(settings.model).toBe('gpt-5.5');
      expect(settings.effortLevel).toBe('high');
      expect(settings.serviceTier).toBe('default');
    });

    it('does not overwrite when no saved values exist', () => {
      const settings: Record<string, unknown> = {
        settingsProvider: 'codex',
        model: 'haiku',
        effortLevel: 'high',
        serviceTier: 'default',
        savedProviderModel: {},
        savedProviderEffort: {},
        savedProviderServiceTier: {},
      };

      ProviderSettingsCoordinator.projectActiveProviderState(settings);

      expect(settings.model).toBe('haiku');
      expect(settings.effortLevel).toBe('high');
    });

    it('handles missing saved maps gracefully', () => {
      const settings: Record<string, unknown> = {
        settingsProvider: 'codex',
        model: 'haiku',
        effortLevel: 'high',
        serviceTier: 'default',
      };

      // Should not throw
      ProviderSettingsCoordinator.projectActiveProviderState(settings);

      expect(settings.model).toBe('haiku');
    });

    it('normalizes saved effort values that the projected Codex model no longer supports', () => {
      const settings: Record<string, unknown> = {
        settingsProvider: 'codex',
        providerConfigs: { codex: codexCatalogFixture(['gpt-5.5'], ['low', 'medium', 'high']) },
        model: 'gpt-5.5',
        effortLevel: 'xhigh',
        serviceTier: 'default',
        savedProviderModel: { codex: 'gpt-5.5' },
        savedProviderEffort: { codex: 'xhigh' },
        savedProviderServiceTier: { codex: 'default' },
      };

      ProviderSettingsCoordinator.projectActiveProviderState(settings);

      expect(settings.model).toBe('openai-codex/gpt-5.5');
      expect(settings.effortLevel).toBe('high');
    });
  });

  describe('persistProjectedProviderState', () => {
    it('stores the current top-level projection for the settings provider', () => {
      const settings: Record<string, unknown> = {
        settingsProvider: 'codex',
        providerConfigs: {
          codex: { enabled: true, discoveredModels: TEST_CODEX_CATALOG },
        },
        permissionMode: 'normal',
        model: TEST_CODEX_MODEL,
        effortLevel: 'low',
        serviceTier: 'fast',
        savedProviderModel: { claude: 'haiku' },
        savedProviderEffort: { claude: 'high' },
        savedProviderServiceTier: { claude: 'default' },
        savedProviderPermissionMode: { claude: 'yolo' },
      };

      ProviderSettingsCoordinator.persistProjectedProviderState(settings);

      expect(settings.savedProviderModel).toEqual({
        claude: 'haiku',
        codex: `openai-codex/${TEST_CODEX_MODEL}`,
      });
      expect(settings.savedProviderEffort).toEqual({
        claude: 'high',
        codex: 'low',
      });
      expect(settings.savedProviderServiceTier).toEqual({
        claude: 'default',
        codex: 'fast',
      });
      expect(settings.savedProviderPermissionMode).toEqual({
        claude: 'yolo',
        codex: 'normal',
      });
    });
  });

  describe('projectProviderState', () => {
    it('seeds a provider projection from provider defaults when no saved values exist', () => {
      const settings: Record<string, unknown> = {
        settingsProvider: 'codex',
        providerConfigs: {
          codex: {
            enabled: true,
            discoveredModels: TEST_CODEX_CATALOG,
            environmentVariables: '',
          },
        },
        model: '',
        effortLevel: 'high',
        serviceTier: 'default',
        savedProviderModel: {},
        savedProviderEffort: {},
        savedProviderServiceTier: {},
      };

      ProviderSettingsCoordinator.projectProviderState(settings, 'codex');

      expect(settings.model).toBe(`openai-codex/${TEST_CODEX_MODEL}`);
      expect(settings.effortLevel).toBe('high');
      expect(settings.serviceTier).toBe('default');
    });

    it('preserves saved service tier when the projected model hides the toggle', () => {
      const settings: Record<string, unknown> = {
        settingsProvider: 'codex',
        providerConfigs: {
          codex: {
            enabled: true,
            environmentVariables: '',
          },
        },
        model: 'gpt-5.4-mini',
        effortLevel: 'medium',
        serviceTier: 'default',
        savedProviderModel: { codex: 'gpt-5.4-mini' },
        savedProviderEffort: { codex: 'medium' },
        savedProviderServiceTier: { codex: 'fast' },
      };

      ProviderSettingsCoordinator.projectProviderState(settings, 'codex');

      expect(settings.model).toBe('gpt-5.4-mini');
      expect(settings.serviceTier).toBe('fast');
    });
  });
});
