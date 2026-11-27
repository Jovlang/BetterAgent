import '@test/helpers/registeredCodex';

import { TEST_CODEX_MODEL } from '@test/helpers/codexModels';

import { getEnabledProviderForModel, getProviderForModel } from '@/core/providers/modelRouting';

describe('getProviderForModel', () => {
  it('does not route retired Claude aliases to Codex', () => {
    expect(getProviderForModel('haiku')).toBeNull();
    expect(getProviderForModel('sonnet')).toBeNull();
    expect(getProviderForModel('opus')).toBeNull();
  });

  it('does not route retired Claude model versions', () => {
    expect(getProviderForModel('claude-sonnet-4-5-20250514')).toBeNull();
    expect(getProviderForModel('claude-opus-4-6-20250616')).toBeNull();
  });

  it('routes Codex default models to codex', () => {
    expect(getProviderForModel(TEST_CODEX_MODEL)).toBe('codex');
  });

  it('leaves unknown models unresolved', () => {
    expect(getProviderForModel('some-unknown-model')).toBeNull();
  });

  it('routes models starting with gpt- to codex', () => {
    expect(getProviderForModel('gpt-4o')).toBe('codex');
    expect(getProviderForModel('gpt-custom')).toBe('codex');
  });

  it('routes models starting with o prefix to codex', () => {
    expect(getProviderForModel('o3')).toBe('codex');
    expect(getProviderForModel('o4-mini')).toBe('codex');
  });

  it('does not claim a manual environment model', () => {
    const settings = { environmentVariables: 'OPENAI_MODEL=my-custom-model' };
    expect(getProviderForModel('my-custom-model', settings)).toBeNull();
  });

  it('routes qualified Codex IDs without reviving retired identifiers', () => {
    const settings = {
      providerConfigs: {
        claude: {
          customModels: 'deepseek-v4-pro',
        },
        codex: {
          enabled: true,
          customModels: 'deepseek-v4-pro',
        },
      },
    };

    expect(getProviderForModel('claude-code/deepseek-v4-pro', settings)).toBeNull();
    expect(getProviderForModel('openai-codex/deepseek-v4-pro', settings)).toBe('codex');
  });

  it('does not claim retired manual model configuration', () => {
    const settings = {
      providerConfigs: {
        codex: {
          enabled: true,
          customModels: 'my-custom-model',
        },
      },
    };

    expect(getProviderForModel('my-custom-model', settings)).toBeNull();
  });

  it('does not resolve a disabled Codex model through old settings', () => {
    const settings = {
      settingsProvider: 'claude',
      providerConfigs: {
        claude: {
          visibleModels: [TEST_CODEX_MODEL],
        },
        codex: {
          enabled: false,
        },
      },
    };

    expect(getProviderForModel(TEST_CODEX_MODEL, settings)).toBe('codex');
    expect(getEnabledProviderForModel(TEST_CODEX_MODEL, settings)).toBeNull();
  });
});

it('leaves an unclaimed model unresolved instead of selecting the default provider', () => {
  expect(getProviderForModel('retired-endpoint-model', {
    providerConfigs: { claude: { enabled: true }, codex: { enabled: true, visibleModels: [] } },
  })).toBeNull();
});
