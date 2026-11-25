import '@/providers';

import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { CodexExecutionBackend } from '@/providers/codex/execution/CodexExecutionBackend';

async function createHost() {
  return (await createProviderHostFixture({ settings: {
    providerConfigs: { codex: { enabled: true } },
  } })).host;
}

describe('provider execution registration', () => {
  afterEach(async () => { await ProviderWorkspaceRegistry.disposeInitialized(); });

  it('constructs every registered backend over its real initialized workspace services', async () => {
    const host = await createHost();
    await ProviderWorkspaceRegistry.ensureInitialized(host, 'codex', 'registration-test');

    expect(ProviderRegistry.createExecutionBackend(host, 'codex'))
      .toBeInstanceOf(CodexExecutionBackend);
  });

});

it('lists Codex as the only built-in chat provider', () => {
  expect(ProviderRegistry.getRegisteredProviderIds()).toEqual(['codex']);
});
