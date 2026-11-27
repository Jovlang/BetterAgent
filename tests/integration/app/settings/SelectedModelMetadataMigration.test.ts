import '@test/helpers/registeredCodex';

import { modelCatalogCases as cases } from '@test/helpers/providerModelCatalogs';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';

import { migrateSelectedModelMetadata } from '@/app/settings/SelectedModelMetadataMigration';
import { CLAUDIAN_SETTINGS_PATH } from '@/core/bootstrap/storagePaths';
import {
  ProviderModelCatalogController,
  type ProviderModelCatalogPatch,
  type ProviderModelCatalogState,
  type ProviderModelCatalogStore,
} from '@/core/providers/models/ProviderModelCatalog';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { updateCodexProviderSettings } from '@/providers/codex/settings';




/** A catalog store persisting selections through the settings document, as the migration sees them. */
function documentStore(
  host: ProviderHost,
  read: (settings: ProviderHost['settings']) => ProviderModelCatalogState,
  update: (settings: import('@/core/types').ClaudianSettings, patch: ProviderModelCatalogPatch) => void,
): ProviderModelCatalogStore {
  return {
    read: () => read(host.settings),
    write: change => host.mutateSettings(settings => { update(settings, change(read(settings))); }),
    notifyChatOptionsChanged: () => undefined,
  };
}

async function makeHost() {
  const fixture = await createProviderHostFixture();
  for (const id of ProviderRegistry.getRegisteredProviderIds()) ProviderRegistry.setEnabled(id, fixture.settings, false);
  return {
    host: fixture.host, storage: fixture.settingsStorage,
    read: async () => JSON.parse(await fixture.vault.read(CLAUDIAN_SETTINGS_PATH)),
  };
}

beforeEach(() => {
  vi.spyOn(ProviderWorkspaceRegistry, 'ensureInitialized').mockResolvedValue();
});
afterEach(() => {
  for (const { id } of cases) ProviderWorkspaceRegistry.setServices(id, undefined);
  vi.restoreAllMocks();
});

function catalogWith(overrides: Partial<import('@/core/providers/models/ProviderModelCatalog').ProviderModelCatalog>) {
  return Object.assign(new ProviderModelCatalogController({
    providerName: 'Test',
    store: {
      read: () => ({ enabled: true, models: [], selectedIds: [], aliases: {} }),
      write: async () => {}, notifyChatOptionsChanged: () => {},
    },
    discover: async () => ({ changed: false }),
  }), overrides);
}

it.each(cases.flatMap(entry => [false, true].map(deselectDuringQuery => ({ ...entry, deselectDuringQuery }))))(
  '$id fills missing metadata and respects deselection during query: $deselectDuringQuery', async ({ id, populate, deselectDuringQuery }) => {
  const { host, storage, read } = await makeHost();
  populate(host.settings);
  const config = host.settings.providerConfigs[id]!;
  const selectedIds = [...config.visibleModels as string[]];
  const complete = structuredClone(host.settings);
  config.discoveredModels = [];
  const discover = vi.fn(async () => {
    await host.mutateSettings(settings => {
      if (deselectDuringQuery) updateCodexProviderSettings(settings, { visibleModels: [] });
      const currentSelection = settings.providerConfigs[id]!.visibleModels;
      settings.providerConfigs[id] = { ...complete.providerConfigs[id], visibleModels: currentSelection };
    });
    return { changed: true };
  });
  const catalog = new ProviderModelCatalogController({
    providerName: id, discover,
    store: documentStore(host, settings => ({
      enabled: true, selectedIds: settings.providerConfigs[id]!.visibleModels as string[], models: [], aliases: {},
    }), (settings, patch) => updateCodexProviderSettings(settings, patch)),
  });
  ProviderWorkspaceRegistry.setServices(id, { modelCatalog: catalog });
  expect(ProviderRegistry.getSettingsStorageAdapter(id).needsReasoningMetadata!(host.settings)).toBe(true);

  await migrateSelectedModelMetadata(host, new AbortController().signal);

  expect(discover).toHaveBeenCalledTimes(1);
  expect((await read()).providerConfigs[id].visibleModels).toEqual(deselectDuringQuery ? [] : selectedIds);
  expect(JSON.stringify(await read())).not.toContain('unselected-catalog-entry');
  const restored = await storage.load();
  expect(ProviderRegistry.getChatUIConfig(id).getModelOptions(restored)).toHaveLength(deselectDuringQuery ? 0 : 1);
  expect(ProviderRegistry.getSettingsStorageAdapter(id).needsReasoningMetadata!(restored)).toBe(false);
  await migrateSelectedModelMetadata(host, new AbortController().signal);
  expect(discover).toHaveBeenCalledTimes(1);
  await catalog.dispose();
});

it('preserves incomplete selections after a failed query and retries on a later startup', async () => {
  const { host } = await makeHost();
  cases[0].populate(host.settings);
  host.settings.providerConfigs.codex!.discoveredModels = [];
  const before = structuredClone(host.settings);
  const refresh = vi.fn().mockRejectedValue(new Error('CLI unavailable'));
  ProviderWorkspaceRegistry.setServices('codex', { modelCatalog: catalogWith({ refresh }) });
  await migrateSelectedModelMetadata(host, new AbortController().signal);
  await migrateSelectedModelMetadata(host, new AbortController().signal);
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(host.settings).toEqual(before);
});

it.each(cases)('$id detects missing effort fields in an otherwise present selected record', async ({ id, populate }) => {
  const { host } = await makeHost();
  populate(host.settings);
  const config = host.settings.providerConfigs[id]!;
  delete (config.discoveredModels as Array<Record<string, unknown>>)[0].supportedReasoningEfforts;
  expect(ProviderRegistry.getSettingsStorageAdapter(id).needsReasoningMetadata!(host.settings)).toBe(true);
});

it.each(cases)('$id detects a selected model missing from the catalog despite resolved effort metadata', async ({ id, populate }) => {
  const { host } = await makeHost();
  populate(host.settings);
  const config = host.settings.providerConfigs[id]!;
  config.discoveredModels = [];
  expect(ProviderRegistry.getSettingsStorageAdapter(id).needsReasoningMetadata!(host.settings)).toBe(true);
});
it('cancels an active native query on unload', async () => {
  const { host } = await makeHost();
  cases[0].populate(host.settings);
  host.settings.providerConfigs.codex!.discoveredModels = [];
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let aborted = false;
  const catalog = new ProviderModelCatalogController({
    providerName: 'Codex',
    store: documentStore(host, () => ({ enabled: true, selectedIds: [cases[0].selected], models: [], aliases: {} }), vi.fn()),
    discover: signal => new Promise(resolve => {
      signal.addEventListener('abort', () => { aborted = true; resolve({ changed: false }); }, { once: true });
      started();
    }),
  });
  ProviderWorkspaceRegistry.setServices('codex', { modelCatalog: catalog });
  const flight = migrateSelectedModelMetadata(host, controller.signal);
  await ready;
  controller.abort();
  await flight;
  expect(aborted).toBe(true);
  await catalog.dispose();
});
