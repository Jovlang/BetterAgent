/** @vitest-environment jsdom */
import '@/providers';

import { createChatFeatureHost } from '@test/helpers/features/chat/ChatFeatureHostFixture';
import { createSessionRuntimePool } from '@test/helpers/features/chat/SessionRuntimePoolHarness';
import { createHarness, releaseSideChatHarnesses, startSideChat } from '@test/helpers/features/chat/SideChatDOMHarness';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { App, Component } from 'obsidian';

import type { Conversation } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { destroyTab } from '@/features/chat/tabs/TabLifecycle';
import { createTabRuntime } from '@/features/chat/tabs/TabRuntimeFactory';
import { VaultMentionDataProvider } from '@/shared/mention/VaultMentionDataProvider';

afterEach(async () => {
  await releaseSideChatHarnesses();
});

it('refreshes destination settings when the side panel collapses, expands, and is discarded', async () => {
  const harness = await createHarness();
  const app = new App();
  Object.assign(app.vault.adapter, { basePath: '/vault' });
  const conversation = {
    id: 'conversation-1', providerId: 'codex', selectedModel: 'gpt-5.5',
    sessionId: 'main-session', messages: harness.tab.state.messages,
  } as Conversation;
  const pool = createSessionRuntimePool(() => plugin);
  const plugin: ChatFeatureHost = await createChatFeatureHost({
    executionPersistence: {
      registerExecutionBinding() {}, releaseExecutionBinding() {},
      assertConversationExecutionAuthority: async () => undefined,
      persistExecutionSnapshot: async () => true, recordConversationActivity: async () => undefined,
    },
    providerHost: harness.plugin.providerHost,   sessionRuntimes: pool,
    app,
    getCommittedSettings: () => plugin.settings,
    settings: {
      model: 'gpt-5.4-mini', effortLevel: 'medium', permissionMode: 'normal',
      savedProviderModel: { codex: 'gpt-5.4-mini' }, savedProviderEffort: { codex: 'medium' },
      providerConfigs: { codex: { enabled: true, visibleModels: ['gpt-5.5', 'gpt-5.4-mini'],
        discoveredModels: [
          { model: 'gpt-5.5', displayName: 'Sonnet', supportedReasoningEfforts: [{ value: 'low' }, { value: 'high' }], defaultReasoningEffort: 'high' },
          { model: 'gpt-5.4-mini', displayName: 'Opus', supportedReasoningEfforts: [{ value: 'medium' }, { value: 'high' }], defaultReasoningEffort: 'high' },
        ] } },
    },
    getActiveEnvironmentVariables: () => '',
    getConversationSummary: () => ({ ...conversation, messageCount: conversation.messages.length, preview: '' }),
    getConversationSync: () => conversation,
    getConversationList: () => [{ ...conversation, messageCount: conversation.messages.length, preview: '' }],
  });
  const tab = await createTabRuntime({
    plugin,
    component: new Component(),
    containerEl: document.body.appendChild(document.createElement('div')),
    mentionDataProvider: new VaultMentionDataProvider(plugin.app),
    conversation,
    getProviderCatalogConfig: () => null,
    isRuntimeLive: () => true,
    openConversation: async () => {}, startNewConversation: async () => {},
  });
  tab.state.messages = conversation.messages;
  const side = tab.controllers.sideChatController;
  try {
    const started = side.handleCommandSubmission('Explore settings', []);
    await waitFor(() => expect(harness.backend.sessions).toHaveLength(1));
    expect(harness.backend.latest.requests[0].configuration).toMatchObject({ model: 'openai-codex/gpt-5.5', reasoning: 'high' });
    harness.backend.latest.establishChild('child-session');
    harness.backend.latest.complete();
    await started;
    const ui = within(tab.dom.inputComposerEl);
    side.updateSideSettings({ permissionMode: 'yolo', reasoning: 'low' });
    side.collapse();
    fireEvent.click(ui.getByRole('button', { name: 'Explore settings' }));
    expect(ui.queryByRole('button', { name: 'Permission mode: Full access' })).not.toBeNull();
    expect(ui.getByText('Low', { selector: '.claudian-thinking-current' })).toBeDefined();
    expect(ui.queryByRole('button', { name: 'Permission mode: Ask for approval' })).toBeNull();

    fireEvent.click(ui.getByRole('button', { name: 'Collapse' }));
    expect(ui.queryByRole('button', { name: 'Permission mode: Ask for approval' })).not.toBeNull();
    expect(ui.getByText('High', { selector: '.claudian-thinking-current' })).toBeDefined();
    expect(ui.queryByRole('button', { name: 'Permission mode: Full access' })).toBeNull();

    fireEvent.click(ui.getByRole('button', { name: 'Explore settings' }));
    expect(ui.queryByRole('button', { name: 'Permission mode: Full access' })).not.toBeNull();
    expect(ui.getByText('Low', { selector: '.claudian-thinking-current' })).toBeDefined();
    expect(ui.queryByRole('button', { name: 'Permission mode: Ask for approval' })).toBeNull();

    let finishDisposal!: () => void;
    const disposalGate = new Promise<void>(resolve => { finishDisposal = resolve; });
    const native = harness.backend.latest;
    const disposeNative = native.dispose.bind(native);
    native.dispose = async () => {
      await disposalGate;
      await disposeNative();
    };
    const discarded = side.discard();
    try {
      expect(side.destination).toBe('main');
      expect(ui.queryByRole('button', { name: 'Permission mode: Ask for approval' })).not.toBeNull();
    expect(ui.getByText('High', { selector: '.claudian-thinking-current' })).toBeDefined();
      expect(ui.queryByRole('button', { name: 'Permission mode: Full access' })).toBeNull();
    } finally {
      finishDisposal();
      await discarded;
    }
  } finally {
    await destroyTab(tab);
  }
});

it('side usage must carry the side model when native usage omits model', async () => {
  const harness = await createHarness({ settings: {
    model: 'gpt-5.4-mini', settingsProvider: 'codex',
    savedProviderModel: { codex: 'gpt-5.4-mini' },
    providerConfigs: { codex: { enabled: true, visibleModels: ['gpt-5.5', 'gpt-5.4-mini'] } },
  } });
  const { started } = await startSideChat(harness);
  harness.backend.latest.complete();
  await started;
  harness.controller.updateSideSettings({ model: 'openai-codex/gpt-5.5', reasoning: 'high', permissionMode: 'normal', serviceTier: 'default' });
  const pending = harness.controller.submitToSide('second turn', []);
  await waitFor(() => expect(harness.backend.latest.requests).toHaveLength(2));
  expect(harness.backend.latest.requests[1].configuration.model).toBe('openai-codex/gpt-5.5');
  harness.backend.latest.emitOutput({ type: 'usage_updated', usage: {
    inputTokens: 100, contextTokens: 100, contextWindow: 200000, percentage: 0,
  } });
  harness.backend.latest.complete();
  await pending;
  expect(harness.controller.runtime?.state.usage?.model).toBe('openai-codex/gpt-5.5');
});
