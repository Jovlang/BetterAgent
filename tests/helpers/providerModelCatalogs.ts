import { TEST_CODEX_CATALOG } from '@test/helpers/codexModels';

import type { ProviderRuntimeHost } from '@/core/providers/ProviderRuntimeHost';
import { assertCodexModelAvailable } from '@/providers/codex/runtime/CodexModelAvailability';
import { getCodexProviderSettings, updateCodexProviderSettings } from '@/providers/codex/settings';

const availabilityGuards = {
  codex: assertCodexModelAvailable,
};

/** Runs a provider's execution-time model guard against a settings document. */
export function assertCatalogModelAvailable(
  providerId: keyof typeof availabilityGuards,
  host: ProviderRuntimeHost,
  model: string | undefined,
): void {
  availabilityGuards[providerId](host, model);
}

export const modelCatalogCases = [
  {
    id: 'codex' as const, selected: 'gpt-5.5',
    populate(settings: Record<string, unknown>) {
      updateCodexProviderSettings(settings, { enabled: true, visibleModels: ['gpt-5.5'], discoveredModels: [
        { ...TEST_CODEX_CATALOG[0], inputModalities: ['text'] }, { ...TEST_CODEX_CATALOG[1], inputModalities: ['text'], model: 'unselected-catalog-entry' },
      ] });
    },
    read: (settings: Record<string, unknown>) => getCodexProviderSettings(settings).discoveredModels,
  },
];
