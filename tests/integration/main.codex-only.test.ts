/** @vitest-environment jsdom */
import { TEST_CODEX_CATALOG } from '@test/helpers/codexModels';
import { DesktopVault } from '@test/helpers/core/DesktopVault';
import { mountSettingTab } from '@test/helpers/ObsidianSettingsHost';
import { testDate } from '@test/helpers/testClock';
import { fireEvent, within } from '@testing-library/dom';

import { CLAUDIAN_SETTINGS_PATH, SESSIONS_PATH } from '@/core/bootstrap/storagePaths';
import { resolveNewConversationModel } from '@/core/providers/conversationModel';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { t } from '@/i18n/i18n';
import ClaudianPlugin from '@/main';

it('registers only Codex in the production composition in the plugin', () => {
  expect(ProviderRegistry.getRegisteredProviderIds()).toEqual(['codex']);
  expect(ProviderRegistry.resolveSettingsProviderId({})).toBe('codex');
  expect(ProviderRegistry.getChatUIConfig()).toBe(ProviderRegistry.getChatUIConfig('codex'));
});

it('retains stored Codex settings and loads only Codex sessions without changing other session files', async () => {
  const vault = await DesktopVault.create();
  const plugin = new ClaudianPlugin(vault.app, {
    id: 'betteragent', name: 'BetterAgent', author: 'Test', version: '1.0.0', description: '', minAppVersion: '1.13.0',
  });
  onTestFinished(async () => {
    plugin.onunload();
    await plugin['applicationShutdownPromise'];
    await vault.dispose();
  });
  const codex = {
    enabled: true, safeMode: 'read-only', responseStyle: 'friendly', reasoningSummary: 'concise',
  };
  await vault.write(CLAUDIAN_SETTINGS_PATH, JSON.stringify({
    settingsProvider: 'codex',
    lastSelectedChatModel: { providerId: 'codex', model: 'gpt-5.5' },
    savedProviderPermissionMode: { codex: 'normal' },
    providerConfigs: { codex: { ...codex, visibleModels: ['gpt-5.5'], discoveredModels: TEST_CODEX_CATALOG } },
  }));
  const time = testDate().getTime();
  const legacyPath = `${SESSIONS_PATH}/legacy.meta.json`;
  const legacy = JSON.stringify({
    id: 'legacy', providerId: 'claude', title: 'Legacy chat', sessionId: null, createdAt: time, lastActivityAt: time,
  });
  await vault.write(legacyPath, legacy);
  await vault.write(`${SESSIONS_PATH}/current.meta.json`, JSON.stringify({
    id: 'current', providerId: 'codex', title: 'Codex chat', sessionId: null, createdAt: time, lastActivityAt: time,
  }));

  await plugin.onload();
  expect(plugin).not.toHaveProperty('api');
  expect(plugin.settings.providerConfigs.codex).toMatchObject(codex);
  expect(plugin.settings.permissionMode).toBe('normal');
  expect(resolveNewConversationModel(plugin.settings)).toEqual({
    providerId: 'codex', model: 'openai-codex/gpt-5.5', source: 'last-selected',
  });
  const settingsTab = vi.mocked(plugin.addSettingTab).mock.calls[0][0];
  const settingsContainer = document.body.createDiv();
  const disposeSettings = mountSettingTab(settingsTab, settingsContainer);
  try {
    const settings = within(settingsContainer);
    expect(settings.queryByRole('button', { name: 'Providers' })).toBeNull();
    fireEvent.click(settings.getByRole('button', { name: 'Codex' }));
    const sandbox = await settings.findByRole<HTMLSelectElement>('combobox', { name: t('settings.codexSandbox.name') });
    expect(sandbox.value).toBe('read-only');
    expect(settings.getAllByRole('button', { name: 'Codex' })).toHaveLength(1);
  } finally {
    disposeSettings();
    settingsContainer.remove();
  }
  await plugin['sessionMetadata'].ensureAllLoaded();
  expect(plugin['chatHost'].getConversationList().map(session => session.id)).toEqual(['current']);
  expect(await vault.read(legacyPath)).toBe(legacy);
});
