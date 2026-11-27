/** @vitest-environment jsdom */

import '@test/helpers/registeredCodex';

import { axe } from '@test/helpers/accessibility';
import { codexCatalogFixture } from '@test/helpers/codexModels';
import { fireEvent, waitFor, within } from '@testing-library/dom';

import type { ToolbarCallbacks } from '@/features/chat/composer/toolbar/types';
import { setLocale, t } from '@/i18n/i18n';
import { updateCodexProviderSettings } from '@/providers/codex/settings';
import { codexChatUIConfig } from '@/providers/codex/ui/CodexChatUIConfig';
import { createProviderIconSvg } from '@/shared/icons';
import { EffortSelector } from '@/shared/toolbar/EffortSelector';
import { ModelSelector } from '@/shared/toolbar/ModelSelector';
import { getProviderPickerModelOptions } from '@/shared/toolbar/providerPickerModelOptions';
import { ToolbarMenuGroup } from '@/shared/toolbar/ToolbarMenu';

HTMLElement.prototype.empty = function () { this.replaceChildren(); };
HTMLElement.prototype.addClass = function (...classes) { this.classList.add(...classes); };
HTMLElement.prototype.removeClass = function (...classes) { this.classList.remove(...classes); };
HTMLElement.prototype.hasClass = function (name) { return this.classList.contains(name); };
HTMLElement.prototype.toggleClass = function (classes, value) {
  for (const name of typeof classes === 'string' ? [classes] : classes) this.classList.toggle(name, value);
};

const mountedMenus: ToolbarMenuGroup[] = [];

afterEach(() => {
  for (const menus of mountedMenus.splice(0)) menus.destroy();
  setLocale('en');
  document.body.replaceChildren();
});

it.each([
  {
    name: 'discovered labels without own aliases',
    aliases: null,
    labels: ['String Model', 'Proto Model', 'Constructor Model'],
  },
  {
    name: 'imported own aliases',
    aliases: '{"toString":"Custom String","__proto__":"Custom Proto","constructor":"Custom Constructor"}',
    labels: ['Custom String', 'Custom Proto', 'Custom Constructor'],
  },
  {
    name: 'same-spelled aliases under Chinese chrome',
    aliases: '{"toString":"Default","__proto__":"Model unavailable","constructor":"Fast"}',
    labels: ['Default', 'Model unavailable', 'Fast'],
    locale: 'zh-CN' as const,
  },
])('renders persisted Codex $name in the named toolbar and options', async ({ aliases, labels, ...fixture }) => {
  const chinese = 'locale' in fixture;
  const englishButtonName = t('chat.modelPicker.modelLabel', { label: labels[1] });
  if (chinese) setLocale('zh-CN');
  expect(t('chat.modelPicker.modelLabel', { label: labels[1] }) !== englishButtonName).toBe(chinese);
  let settings: Record<string, unknown> = { model: 'openai-codex/__proto__' };
  updateCodexProviderSettings(settings, {
    discoveredModels: [
      ['constructor', 'Constructor Model'],
      ['toString', 'String Model'],
      ['__proto__', 'Proto Model'],
    ].map(([model, displayName]) => ({
      model, displayName, description: '',
      supportedReasoningEfforts: [{ value: 'high', description: 'High' }],
      defaultReasoningEffort: 'high',
      serviceTiers: [], defaultServiceTier: null, inputModalities: ['text'], isDefault: false,
    })),
    visibleModels: ['toString', '__proto__', 'constructor'],
    modelAliases: aliases === null ? {} : JSON.parse(aliases),
  });
  settings = JSON.parse(JSON.stringify(settings));

  const host = document.body.createDiv();
  const menus = new ToolbarMenuGroup();
  mountedMenus.push(menus);
  new ModelSelector(host, {
    getSettings: () => settings,
    getUIConfig: () => codexChatUIConfig,
    onModelChange: async (model: string) => { settings.model = model; },
  } as unknown as ToolbarCallbacks, menus);

  fireEvent.click(within(host).getByRole('button', { name: t('chat.modelPicker.modelLabel', { label: labels[1] }) }));
  expect(within(host).getAllByRole('option').map(node => node.textContent)).toEqual(labels);
  expect(within(host).getByRole('option', { name: labels[1] }).getAttribute('aria-selected')).toBe('true');
  expect((await axe(host)).violations).toEqual([]);

  const values = ['openai-codex/toString', 'openai-codex/__proto__', 'openai-codex/constructor'];
  for (const [index, label] of labels.entries()) {
    fireEvent.click(within(host).getByRole('option', { name: label }));
    await waitFor(() => {
      expect(settings.model).toBe(values[index]);
      expect(within(host).getByRole('button', { name: t('chat.modelPicker.modelLabel', { label }) }).textContent).toBe(label);
    });
  }
});

it('renders saved model order top-to-bottom through the real provider UI config', () => {
  const host = document.body.createDiv();
  const catalog = codexCatalogFixture(['gpt-preview', 'gpt-fast', 'gpt-balanced']);
  const config = {
    ...catalog, discoveredModels: catalog.discoveredModels.map(model => ({ ...model, description: '' })),
    visibleModels: ['gpt-fast', 'gpt-balanced', 'gpt-preview'],
  };
  const selector = new ModelSelector(host, {
    getSettings: () => ({ model: 'openai-codex/gpt-fast', providerConfigs: { codex: config } }),
    getUIConfig: () => codexChatUIConfig,
  } as unknown as ToolbarCallbacks);
  fireEvent.click(within(host).getByRole('button', { name: /^Model: gpt-fast/ }));
  const labels = () => within(host).getAllByRole('option').map(node => node.textContent);
  expect(labels()).toEqual(['gpt-fast', 'gpt-balanced', 'gpt-preview']);
  // A single-provider list takes the view's active-provider brand; rows name no provider.
  expect(within(host).getAllByRole('option').map(node => node.getAttribute('data-provider'))).toEqual([null, null, null]);
  config.visibleModels = ['gpt-balanced', 'gpt-preview', 'gpt-fast'];
  selector.renderOptions();
  expect(labels()).toEqual(['gpt-balanced', 'gpt-preview', 'gpt-fast']);
});

it('keeps the session provider\'s icon on an unavailable model in a new session\'s picker', () => {
  const host = document.body.createDiv();
  const settings = {
    model: 'openai-codex/retired',
    providerConfigs: {
      codex: { enabled: true, discoveredModels: [], visibleModels: [] },
    },
  };
  new ModelSelector(host, {
    getSettings: () => settings,
    getUIConfig: () => ({
      ...codexChatUIConfig,
      getModelOptions: (options: Record<string, unknown>) => getProviderPickerModelOptions(() => options),
    }),
  } as unknown as ToolbarCallbacks);
  const button = within(host).getByRole('button', { name: 'Model unavailable' });
  const expected = createProviderIconSvg(codexChatUIConfig.getProviderIcon!()!, { parent: document.createElement('div') });
  expect(button.querySelector('svg')!.innerHTML).toBe(expected.innerHTML);
});

it('hides the parts column while none of its parts is shown', () => {
  const host = document.body.createDiv();
  let reasoningControl = 'none';
  const callbacks = {
    getSettings: () => ({ model: 'opus', reasoning: 'high' }),
    getUIConfig: () => ({
      getModelOptions: () => [{ value: 'opus', label: 'opus' }],
      getReasoningOptions: () => [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }],
      getDefaultReasoningValue: () => 'low',
    }),
    getCapabilities: () => ({ reasoningControl }),
  } as unknown as ToolbarCallbacks;
  const effort = new EffortSelector(new ModelSelector(host, callbacks), callbacks);
  const parts = host.querySelector('.claudian-model-parts')!;
  expect(parts.classList.contains('claudian-hidden')).toBe(true);
  reasoningControl = 'effort';
  effort.updateDisplay();
  expect(parts.classList.contains('claudian-hidden')).toBe(false);
});

it.each([
  { levels: ['Low', 'High'], bars: [4, 2] },
  { levels: ['Low', 'Medium', 'High', 'X-High'], bars: [4, 3, 2, 1] },
  { levels: ['Low', 'Medium', 'High', 'X-High', 'Max'], bars: [5, 4, 3, 2, 1] },
])('gives each of $levels.length thinking levels its own strength glyph, deepest on top', ({ levels, bars }) => {
  const host = document.body.createDiv();
  const callbacks = {
    getSettings: () => ({ model: 'opus', reasoning: levels[0] }),
    getUIConfig: () => ({
      getModelOptions: () => [{ value: 'opus', label: 'opus' }],
      getReasoningOptions: () => levels.map(label => ({ value: label, label })),
      getDefaultReasoningValue: () => levels[0],
    }),
    getCapabilities: () => ({ reasoningControl: 'effort' }),
  } as unknown as ToolbarCallbacks;
  new EffortSelector(new ModelSelector(host, callbacks), callbacks);
  fireEvent.click(within(host).getByRole('button', { name: /^Model: opus/ }));

  const rows = within(within(host).getByRole('listbox', { name: 'Thinking' })).getAllByRole('option');
  expect(rows.map(row => row.textContent)).toEqual([...levels].reverse());
  // Every glyph has the same number of bars; only the filled count tells the levels apart.
  const glyphs = rows.map(row => [...row.querySelectorAll('.claudian-thinking-strength > span')]);
  expect(new Set(glyphs.map(glyph => glyph.length))).toEqual(new Set([Math.max(4, levels.length)]));
  expect(glyphs.map(glyph => glyph.filter(bar => bar.classList.contains('is-filled')).length)).toEqual(bars);
});
