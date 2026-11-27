import '@test/helpers/registeredCodex';

import { DesktopVault } from '@test/helpers/core/DesktopVault';
import { DEFAULT_CLAUDIAN_SETTINGS } from '@test/helpers/defaultSettings';
import type { Plugin } from 'obsidian';

import { SharedStorageService } from '@/app/storage/SharedStorageService';

let vault: DesktopVault;

beforeEach(async () => { vault = await DesktopVault.create(); });
afterEach(async () => { await vault.dispose(); });

function initializeStorage() {
  const plugin = { app: vault.app } as Plugin;
  return new SharedStorageService(plugin, DEFAULT_CLAUDIAN_SETTINGS).initialize();
}

it('moves the legacy storage tree before reading settings, and only moves it once', async () => {
  await vault.write('.claudian/claudian-settings.json', JSON.stringify({ userName: 'Migrated' }));
  const sidecar = `sessions/devices/device-${'a'.repeat(64)}/retired-provider.meta.json`;
  await vault.write(`.claudian/${sidecar}`, '{"providerId":"claude"}');
  await vault.write('.claudian/projects/old-project.json', '{}');

  await expect(initializeStorage()).resolves.toMatchObject({ claudian: { userName: 'Migrated' } });
  expect(await vault.exists('.claudian')).toBe(false);
  expect(await vault.read(`.betteragent/${sidecar}`)).toBe('{"providerId":"claude"}');
  expect(await vault.read('.betteragent/projects/old-project.json')).toBe('{}');
  await expect(initializeStorage()).resolves.toMatchObject({ claudian: { userName: 'Migrated' } });
});

it('preserves both storage trees if the destination already exists', async () => {
  await vault.write('.claudian/claudian-settings.json', '{"userName":"Legacy"}');
  await vault.write('.betteragent/claudian-settings.json', '{"userName":"Current"}');
  const before = await vault.snapshot();

  await expect(initializeStorage()).rejects.toThrow('.betteragent already exists');
  expect(await vault.snapshot()).toEqual(before);
});
