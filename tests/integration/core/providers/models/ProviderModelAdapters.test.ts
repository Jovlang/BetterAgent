import { assertCatalogModelAvailable, modelCatalogCases } from '@test/helpers/providerModelCatalogs';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';

import { ProviderModelUnavailableError } from '@/core/providers/models/ProviderModelUnavailableError';
import { createCodexModels } from '@/providers/codex/runtime/CodexModels';





it.each(modelCatalogCases)('$id keeps native selection, aliases and metadata behind the common catalog', async ({id, selected, populate, read}) => {
  const persist = vi.fn(async () => undefined);
  const fixture = await createProviderHostFixture({ beforePersist: persist });
  const { settings } = fixture;
  populate(settings);
  const host = fixture.host.getRuntimeHost(id);
  const discovery = vi.fn(async () => ({ changed: true, refreshed: true, kind: 'completed' as const, catalog: null, models: [], persistedSettingsChanged: false }));
  const catalog = createCodexModels(host, { refresh: discovery });
  const discoveredModels = structuredClone(read(settings));
  expect(catalog.getSnapshot().models.map(model => model.id)).toEqual(['gpt-5.5', 'unselected-catalog-entry']);
  expect(read(settings)).toEqual(discoveredModels);
  const selectedId = catalog.getSnapshot().selectedIds[0];
  expect(catalog.getSnapshot().defaultModelId).toBe(selectedId);
  expect(() => assertCatalogModelAvailable(id, host, selected)).not.toThrow();
  await catalog.refresh();
  const discoveryCount = () => discovery.mock.calls.length;
  const calls = discoveryCount();
  catalog.markStale();
  await catalog.refresh();
  expect(discoveryCount()).toBe(calls);
  expect(catalog.getSnapshot()).toMatchObject({ stale: true, discoveredCount: 2, selectedIds: [selectedId] });
  await catalog.refresh({ force: true });
  expect(discoveryCount()).toBe(calls + 1);
  await catalog.setAlias(selectedId, 'My selected model');
  expect(catalog.getSnapshot().aliases[selectedId]).toBe('My selected model');
  await catalog.changeSelection({ type: 'clear' });
  expect(catalog.getSnapshot().selectedIds).toEqual([]);
  expect(() => assertCatalogModelAvailable(id, host, selected)).toThrow(ProviderModelUnavailableError);
  await catalog.changeSelection({ type: 'set', modelId: selectedId, selected: true });
  const before = structuredClone(settings);
  persist.mockRejectedValueOnce(new Error('disk full'));
  await expect(catalog.changeSelection({ type: 'clear' })).rejects.toThrow('disk full');
  expect(settings).toEqual(before);
  expect(catalog.getSnapshot().selectedIds).toEqual([selectedId]);
  await catalog.dispose();
});
