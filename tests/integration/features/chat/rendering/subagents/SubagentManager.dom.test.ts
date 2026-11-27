/** @vitest-environment jsdom */
import '@test/helpers/registeredCodex';

import { axe } from '@test/helpers/accessibility';
import { createChatFeatureHost } from '@test/helpers/features/chat/ChatFeatureHostFixture';
import { parseCodexSessionContent } from '@test/helpers/providers/codex/parseCodexSessionContent';
import { testDate, testTime } from '@test/helpers/testClock';
import { fireEvent, within } from '@testing-library/dom';
import { Component } from 'obsidian';

import { NOOP_TASK_RESULT_INTERPRETER } from '@/core/providers/NoopTaskResultInterpreter';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { ProviderSubagentLifecycleAdapter } from '@/core/providers/types';
import type { ChatMessage, SubagentInfo, ToolCallInfo } from '@/core/types';
import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import { SubagentManager } from '@/features/chat/rendering/subagents/SubagentManager';
import { createAsyncSubagentBlock, createSubagentBlock, updateAsyncSubagentBlock, updateSubagentBlock } from '@/features/chat/rendering/subagents/SubagentRenderer';
import { ChatState } from '@/features/chat/state/ChatState';
import { StreamController } from '@/features/chat/turns/StreamController';
import { setLocale, t } from '@/i18n/i18n';
import { CodexSubagentTracker } from '@/providers/codex/execution/CodexSubagentTracker';
import { codexSubagentLifecycleAdapter } from '@/providers/codex/normalization/codexSubagentNormalization';
import type { Thread } from '@/providers/codex/runtime/codexAppServerTypes';
import { CodexNotificationRouter } from '@/providers/codex/runtime/CodexNotificationRouter';

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup());
  setLocale('en');
  document.body.replaceChildren();
});

function expandButton(parent: HTMLElement, name: RegExp): void {
  const button = within(parent).getByRole('button', { name });
  if (button.getAttribute('aria-expanded') !== 'true') fireEvent.click(button);
}

async function createCodexLifecycleView() {
  const parent = document.body.createDiv();
  const manager = new SubagentManager(() => {}, NOOP_TASK_RESULT_INTERPRETER);
  const tools: ToolCallInfo[] = [];
  const plugin = await createChatFeatureHost({ settings: { mediaFolder: '' } });
  const renderer = new MessageRenderer(plugin,
    new Component(), parent,
    undefined, undefined, () => ProviderRegistry.getCapabilities('codex'));
  const state = new ChatState();
  const stream = new StreamController({ plugin, state, renderer, subagentManager: manager,
    getMessagesEl: () => parent, getProviderId: () => 'codex', updateQueueIndicator: () => {} });
  const message: ChatMessage = {
    id: 'response', role: 'assistant', timestamp: testDate().getTime(), content: '', contentBlocks: [], toolCalls: tools,
  };
  state.addMessage(message);
  state.currentContentEl = renderer.addMessage(message).querySelector('.claudian-message-content');
  let pending = Promise.resolve();
  const router = new CodexNotificationRouter(chunk => {
    pending = pending.then(() => stream.handleStreamChunk(chunk, message));
  }, '/workspace');
  cleanups.push(() => { stream.dispose(); manager.clear(); renderer.dispose(); });
  return { parent, manager, tools, router, renderer, message, stream, state, flush: () => pending };
}

it.each(['native', 'raw-first', 'canonical-first'])('renders %s Codex identity, progress, and final output without losing the answer on close', async source => {
  const { parent, tools, router, flush } = await createCodexLifecycleView();
  const notify = (id: string, tool: string, status: string, message: string | null) => {
    router.handleNotification('item/completed', {
      threadId: 'main', turnId: 'turn', item: {
        type: 'collabAgentToolCall', id, tool, status: 'completed', senderThreadId: 'main',
        receiverThreadIds: ['child'], prompt: tool === 'spawnAgent' ? 'Review the storage code.' : null,
        model: tool === 'spawnAgent' ? 'test-model' : null, reasoningEffort: tool === 'spawnAgent' ? 'high' : null,
        agentsStates: { child: { status, message } },
      },
    });
  };

  const rawSpawn = () => {
    router.handleNotification('rawResponseItem/completed', {
      threadId: 'main', turnId: 'turn', item: {
        type: 'function_call', call_id: 'spawn', name: 'spawn_agent',
        arguments: JSON.stringify({ message: 'Review the storage code.', agent_type: 'explorer', task_name: 'reviewer' }),
      },
    });
  };
  if (source === 'raw-first') rawSpawn();
  router.handleNotification('item/started', {
    threadId: 'main', turnId: 'turn', item: {
      type: 'collabAgentToolCall', id: 'spawn', tool: 'spawnAgent', status: 'inProgress',
      prompt: 'Review the storage code.', model: 'test-model', reasoningEffort: 'high', receiverThreadIds: [], agentsStates: {},
    },
  });
  if (source === 'canonical-first') rawSpawn();
  notify('spawn', 'spawnAgent', 'running', null);
  await flush();
  expect(tools[0].subagent).toMatchObject({ agentId: 'child', prompt: 'Review the storage code.' });
  expect(tools[0].input.agent_type).toBe(source === 'native' ? undefined : 'explorer');
  expect(tools[0].input.task_name).toBe(source === 'native' ? undefined : 'reviewer');
  const header = within(parent).getByRole('button', { name: /Subagent task:.*test-model.*high/ });
  fireEvent.click(header);
  fireEvent.click(within(parent).getByRole('button', { name: /^Prompt/ }));
  expect(within(parent).getByText('Review the storage code.')).toBeDefined();

  notify('list', 'listAgents', 'running', 'Checking storage invariants.');
  await flush();
  expect(within(parent).getByText('Checking storage invariants.')).toBeDefined();
  expect(tools[0].subagent?.result).toBeUndefined();
  expect(tools[0].subagent).not.toHaveProperty('progress');

  notify('wait', 'wait', 'completed', 'Storage invariants hold.');
  await flush();
  expect(within(parent).queryByText('Checking storage invariants.')).toBeNull();
  const result = within(parent).getByRole('button', { name: /^Result/ });
  fireEvent.click(result);
  result.focus();
  notify('close', 'closeAgent', 'shutdown', null);
  await flush();
  expect(tools[0].subagent).toMatchObject({ status: 'completed', result: 'Storage invariants hold.' });
  expect(within(parent).getByText('Storage invariants hold.')).toBeDefined();
  expect(document.activeElement).toBe(result);
  notify('followup', 'followupTask', 'running', 'Checking the follow-up.');
  await flush();
  expect(tools[0].subagent).toMatchObject({ status: 'running', result: undefined });
  expect(within(parent).getByText('Checking the follow-up.')).toBeDefined();
  notify('cancel-followup', 'closeAgent', 'shutdown', null);
  await flush();
  expect(tools[0].subagent).toMatchObject({ status: 'error', result: 'Agent shut down' });
  expect(within(parent).queryByText('Checking the follow-up.')).toBeNull();
  expect(await axe(parent)).toHaveNoViolations();
});

it.each(['native', 'raw'])('matches %s lifecycle updates to an agent with a task name and thread ID', async source => {
  const { parent, tools, router, renderer, message, flush } = await createCodexLifecycleView();
  for (const item of [
    { type: 'function_call', call_id: 'spawn', name: 'spawn_agent', arguments: '{"task_name":"reviewer","message":"Review"}' },
    { type: 'function_call_output', call_id: 'spawn', output: '{"task_name":"reviewer"}' },
  ]) router.handleNotification('rawResponseItem/completed', { threadId: 'main', turnId: 'turn', item });
  router.handleNotification('item/completed', {
    threadId: 'main', turnId: 'turn', item: {
      type: 'collabAgentToolCall', id: 'spawn', tool: 'spawnAgent', status: 'completed',
      receiverThreadIds: ['child-thread'], agentsStates: { 'child-thread': { status: 'running', message: null } },
    },
  });
  await flush();
  expect(tools[0].subagent).toMatchObject({ agentId: 'child-thread', description: 'reviewer' });
  if (source === 'raw') {
    for (const item of [
      { type: 'function_call', call_id: 'wait', name: 'wait_agent', arguments: '{"targets":["reviewer"]}' },
      { type: 'function_call_output', call_id: 'wait', output: '{"status":{"reviewer":{"completed":"Review complete"}}}' },
    ]) router.handleNotification('rawResponseItem/completed', { threadId: 'main', turnId: 'turn', item });
  }
  router.handleNotification('item/completed', {
    threadId: 'main', turnId: 'turn', item: {
      type: 'collabAgentToolCall', id: 'wait', tool: 'wait', status: 'completed',
      receiverThreadIds: source === 'raw' ? [] : ['child-thread'],
      agentsStates: source === 'raw' ? {} : { 'child-thread': { status: 'completed', message: 'Review complete' } },
    },
  });
  await flush();
  expect(tools[0].subagent).toMatchObject({ status: 'completed', result: 'Review complete' });
  parent.replaceChildren();
  const retained = { ...message, contentBlocks: tools.map(tool => ({ type: 'tool_use' as const, toolId: tool.id })) };
  renderer.renderStoredMessage(retained, [retained], 0);
  expect(within(parent).queryByRole('button', { name: /^wait(?:_agent)? - click to expand$/i, hidden: true })).toBeNull();
  fireEvent.click(within(parent).getByRole('button', { name: /Subagent task: reviewer/ }));
  fireEvent.click(within(parent).getByRole('button', { name: /^Result/ }));
  expect(within(parent).getByText('Review complete')).toBeDefined();
});

it.each(['live', 'history'] as const)('keeps raw Codex identity and completion details in %s cards', async mode => {
  const { parent, manager, tools, router, flush } = await createCodexLifecycleView();
  const calls = [
    { id: 'spawn', name: 'spawn_agent', input: { message: 'Review storage.', model: 'test-model-with-a-long-name', reasoning_effort: 'high', agent_type: 'explorer' },
      output: { agent_id: 'child', nickname: 'Ada' } },
    { id: 'wait', name: 'wait', input: { ids: ['child'] }, output: { status: { child: { completed: 'Storage is correct.' } } } },
    { id: 'close', name: 'close_agent', input: { id: 'child' }, output: { previous_status: { completed: 'Storage is correct.' } } },
  ];
  const payloads = calls.flatMap(call => [
    { type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.input) },
    { type: 'function_call_output', call_id: call.id, output: JSON.stringify(call.output) },
  ]);
  if (mode === 'live') {
    for (const item of payloads) {
      router.handleNotification('rawResponseItem/completed', { threadId: 'main', turnId: 'turn', item });
      if (item.type === 'function_call_output') {
        // Canonical snapshots must not replace richer raw output (including the nickname).
        router.handleNotification('item/completed', {
          threadId: 'main', turnId: 'turn', item: {
            type: 'collabAgentToolCall', id: item.call_id,
            tool: item.call_id === 'spawn' ? 'spawnAgent' : item.call_id === 'close' ? 'closeAgent' : 'wait',
            status: 'completed', receiverThreadIds: ['child'],
            agentsStates: { child: { status: item.call_id === 'spawn' ? 'running' : item.call_id === 'close' ? 'shutdown' : 'completed', message: null } },
          },
        });
      }
    }
    await flush();
  } else {
    const messages = parseCodexSessionContent(payloads.map((payload, index) => JSON.stringify({
      type: 'response_item', timestamp: testTime({ seconds: index }), payload,
    })).join('\n'));
    tools.push(...messages.flatMap(message => message.toolCalls ?? []));
    manager.updateLifecycleSpawn(tools[0], tools, codexSubagentLifecycleAdapter, parent);
  }
  expect(tools[0].subagent).toMatchObject({
    agentId: 'child', description: 'Ada (explorer, test-model-with-a-long-name, high)', prompt: 'Review storage.',
    result: 'Storage is correct.', status: 'completed',
  });
  const header = within(parent).getByRole('button', { name: /Subagent task: Ada.*test-model-with-a-long-name, high/ });
  expect(header.title).toBe('Ada (explorer, test-model-with-a-long-name, high)');
  fireEvent.click(header);
  fireEvent.click(within(parent).getByRole('button', { name: /^Result/ }));
  expect(within(parent).getByText('Storage is correct.')).toBeDefined();
});

it.each((['live', 'history'] as const).flatMap(mode => [
  { mode, label: 'native error', native: { errored: 'Native agent failed.' }, status: 'error', result: 'Native agent failed.' },
  { mode, label: 'empty native error', native: { errored: '' }, status: 'error', result: 'Agent stopped' },
  { mode, label: 'completion without text', native: { completed: null }, status: 'completed', result: 'DONE' },
  { mode, label: 'missing agent', native: 'not_found', status: 'error', result: 'Agent not found' },
]))('settles $label in $mode Codex cards using raw native statuses', async ({ mode, native, status, result }) => {
  const { parent, manager, tools, router, flush } = await createCodexLifecycleView();
  const payloads = [
    { type: 'function_call', call_id: 'spawn-native', name: 'spawn_agent', arguments: '{"message":"Review.","agent_type":"explorer"}' },
    { type: 'function_call_output', call_id: 'spawn-native', output: '{"agent_id":"child"}' },
    { type: 'function_call', call_id: 'wait-native', name: 'wait', arguments: '{"ids":["child"]}' },
    { type: 'function_call_output', call_id: 'wait-native', output: JSON.stringify({ status: { child: native }, timed_out: false }) },
  ];
  if (mode === 'live') {
    for (const item of payloads) {
      router.handleNotification('rawResponseItem/completed', { threadId: 'main', turnId: 'turn', item });
      if (item.type === 'function_call_output') {
        router.handleNotification('item/completed', { threadId: 'main', turnId: 'turn', item: {
          type: 'collabAgentToolCall', id: item.call_id, tool: item.call_id === 'spawn-native' ? 'spawnAgent' : 'wait',
          status: 'completed', receiverThreadIds: ['child'],
          agentsStates: { child: { status: item.call_id === 'spawn-native' ? 'running' : status === 'completed' ? 'completed' : 'errored', message: null } },
        } });
      }
    }
    await flush();
  } else {
    const messages = parseCodexSessionContent(payloads.map((payload, index) => JSON.stringify({
      type: 'response_item', timestamp: testTime({ seconds: index }), payload,
    })).join('\n'));
    tools.push(...messages.flatMap(message => message.toolCalls ?? []));
    manager.updateLifecycleSpawn(tools[0], tools, codexSubagentLifecycleAdapter, parent);
  }
  expect(tools[0].subagent).toMatchObject({ status, result });
  const header = within(parent).getByRole('button', { name: new RegExp(`Subagent task:.*Status: ${status}`) });
  fireEvent.click(header);
  fireEvent.click(within(parent).getByRole('button', { name: /^Result/ }));
  expect(within(parent).getByText(result)).toBeDefined();
  expect(within(parent).queryByRole('button', { name: /^wait - click to expand$/i, hidden: true })).toBeNull();
  expect(await axe(parent)).toHaveNoViolations();
});

it.each(['raw-output', 'item-result', 'text-output'])(
  'combines %s acknowledgements with native follow-up state', async source => {
    const { parent, tools, router, flush } = await createCodexLifecycleView();
    const complete = (id: string, tool: string, status: string, message: string | null, result?: unknown) => {
      router.handleNotification('item/completed', {
        threadId: 'main', turnId: 'turn', item: {
          type: 'collabAgentToolCall', id, tool, status: 'completed',
          receiverThreadIds: ['child'], agentsStates: { child: { status, message } }, result,
        },
      });
    };
    complete('spawn', 'spawnAgent', 'running', null);
    complete('wait', 'wait', 'completed', 'First answer');
    await flush();
    expect(tools[0].subagent).toMatchObject({ status: 'completed', result: 'First answer' });

    const acknowledgement = source === 'text-output' ? 'Queued follow-up' : { submission_id: 'submission' };
    if (source !== 'item-result') {
      for (const item of [
        { type: 'function_call', call_id: 'followup', name: 'send_input', arguments: '{"id":"child","message":"Check again"}' },
        { type: 'function_call_output', call_id: 'followup', output: typeof acknowledgement === 'string' ? acknowledgement : JSON.stringify(acknowledgement) },
      ]) router.handleNotification('rawResponseItem/completed', { threadId: 'main', turnId: 'turn', item });
    }
    complete('followup', 'sendInput', 'running', 'Checking the follow-up', source === 'item-result' ? acknowledgement : undefined);
    await flush();
    expect(tools[0].subagent).toMatchObject({ status: 'running', result: undefined });
    expect(within(parent).queryByText('First answer')).toBeNull();
    expect(within(parent).getByText('Checking the follow-up')).toBeDefined();
    expect(tools.find(tool => tool.id === 'followup')?.result).toContain(source === 'text-output' ? 'Queued follow-up' : 'submission');
    complete('wait-again', 'wait', 'completed', 'Second answer');
    await flush();
    expect(tools[0].subagent).toMatchObject({ status: 'completed', result: 'Second answer' });
    expect(within(parent).queryByText('Checking the follow-up')).toBeNull();
  },
);

it('honors provider lifecycle state and ignores late progress after completion', () => {
  const parent = document.body.createDiv();
  const manager = new SubagentManager(() => {}, NOOP_TASK_RESULT_INTERPRETER);
  const spawn: ToolCallInfo = { id: 'spawn', name: 'launch', input: {}, status: 'completed' };
  const close: ToolCallInfo = { id: 'close', name: 'close', input: { target: 'alias' }, status: 'running' };
  const tools = [spawn, close];
  const adapter: ProviderSubagentLifecycleAdapter = {
    protocol: 'lifecycle', isHiddenTool: () => true,
    isToolCallFullyOwned: (tool, identities) => identities.has(String(tool.input.target)),
    isSpawnTool: name => name === 'launch', isWaitTool: () => false, isCloseTool: name => name === 'close',
    resolveSpawnToolIds: (tool, identities) => {
      const id = identities.get(String(tool.input.target));
      return id ? [id] : [];
    },
    extractSpawnResult: () => ({ agentId: 'child', aliases: ['alias'] }),
    extractWaitResult: () => ({ statuses: {}, timedOut: false }),
    buildSubagentInfo: () => ({
      id: 'spawn', description: 'Provider task', agentId: 'child', isExpanded: false, toolCalls: [],
      status: close.status === 'completed' ? 'completed' : 'running',
      result: close.status === 'completed' ? 'Provider answer' : undefined,
    }),
    getProgress: () => ({ toolCallId: 'spawn', summary: 'Provider activity' }),
  };
  manager.updateLifecycleSpawn(spawn, tools, adapter, parent);
  expect(within(parent).getByText('Provider activity')).toBeDefined();
  manager.handleLifecycleResult(close, 'Closed', false, tools, adapter);
  manager.applyProgress({ toolCallId: 'spawn', summary: 'Late activity' });
  expect(within(parent).queryByText('Provider activity')).toBeNull();
  expect(within(parent).queryByText('Late activity')).toBeNull();
  expect(spawn.subagent).toMatchObject({ status: 'completed', result: 'Provider answer' });
});

it.each(['sync', 'async'] as const)('renders %s snapshots without changing their model or expansion state', async mode => {
  const initial: SubagentInfo = {
    id: 'snapshot', description: 'Snapshot task', mode, status: 'running', asyncStatus: 'running',
    isExpanded: false, toolCalls: [{ id: 'read', name: 'Read', input: {}, status: 'running', isExpanded: false }],
  };
  Object.freeze(initial.toolCalls[0]);
  Object.freeze(initial.toolCalls);
  Object.freeze(initial);
  const parent = document.body.createDiv();
  const view = mode === 'sync' ? createSubagentBlock(parent, initial) : createAsyncSubagentBlock(parent, initial);
  expect(view.toolsContainerEl.childElementCount).toBe(0);
  const updated = Object.freeze({ ...initial, toolCalls: [Object.freeze({ ...initial.toolCalls[0], status: 'completed' as const, result: 'First child result' })] });
  if ('statusTextEl' in view) updateAsyncSubagentBlock(view as ReturnType<typeof createAsyncSubagentBlock>, updated);
  else updateSubagentBlock(view, updated);
  expect(view.toolsContainerEl.childElementCount).toBe(0);
  fireEvent.click(within(parent).getByRole('button', { name: /Snapshot task/ }));
  expect(within(parent).queryByText('First child result')).toBeNull();
  const childHeader = within(parent).getByRole('button', { name: /^Read/ });
  fireEvent.click(childHeader);
  expect(within(parent).getByText('First child result')).toBeDefined();
  fireEvent.click(childHeader);
  const latest = Object.freeze({ ...updated, toolCalls: [Object.freeze({ ...updated.toolCalls[0], result: 'Latest child result' })] });
  if ('statusTextEl' in view) updateAsyncSubagentBlock(view as ReturnType<typeof createAsyncSubagentBlock>, latest);
  else updateSubagentBlock(view, latest);
  expect(within(parent).queryByText('Latest child result')).toBeNull();
  fireEvent.click(childHeader);
  expect(within(parent).getByText('Latest child result')).toBeDefined();
  const completed = Object.freeze({ ...initial, status: 'completed' as const, asyncStatus: 'completed' as const, result: 'Snapshot result' });
  if ('statusTextEl' in view) updateAsyncSubagentBlock(view as ReturnType<typeof createAsyncSubagentBlock>, completed);
  else updateSubagentBlock(view, completed);
  expect(within(parent).getByText('Snapshot result')).toBeDefined();
  expect(initial.status).toBe('running');
  expect(initial.isExpanded).toBe(false);
  expect(initial.toolCalls[0].isExpanded).toBe(false);
  expect(completed.isExpanded).toBe(false);
  expect(await axe(parent)).toHaveNoViolations();
});

it('reconciles a large expanded child list with linear identity lookups and removes retired tools', () => {
  let identityReads = 0;
  const tools: ToolCallInfo[] = Array.from({ length: 100 }, (_, index) => ({
    get id() { identityReads += 1; return `child-${index}`; },
    name: 'Read', input: { file_path: `note-${index}.md` }, status: 'completed', result: 'contents',
  }));
  const info: SubagentInfo = { id: 'many-tools', description: 'Many tools', status: 'running', isExpanded: false, toolCalls: tools };
  const parent = document.body.createDiv();
  const view = createSubagentBlock(parent, info);
  fireEvent.click(within(parent).getByRole('button', { name: /Subagent task: Many tools/ }));
  expect(parent.querySelectorAll('.claudian-subagent-tool-item')).toHaveLength(100);
  identityReads = 0;
  updateSubagentBlock(view, { ...info, toolCalls: tools.slice(1) });
  expect(parent.querySelectorAll('.claudian-subagent-tool-item')).toHaveLength(99);
  expect(parent.querySelector('[data-tool-id="child-0"]')).toBeNull();
  expect(parent.querySelector('[data-tool-id="child-99"]')).not.toBeNull();
  expect(identityReads).toBeLessThanOrEqual(400);
});

it.each(['before spawn', 'after spawn', 'native only'])('keeps the native Codex card updated with session events %s, parent settlement, and a follow-up', async timing => {
  const view = await createCodexLifecycleView();
  let tracker = new CodexSubagentTracker(info => view.stream.subagents.handleSubagentUpdate(info), async () => {
    throw new Error('Child read unavailable');
  });
  const started = { type: 'subAgentActivity' as const, id: 'spawn', kind: 'started' as const,
    agentThreadId: 'child', agentPath: '/root/helper' };
  if (timing === 'before spawn') tracker.activity(started, 'parent-turn');
  view.router.handleNotification('rawResponseItem/completed', { threadId: 'parent', turnId: 'parent-turn', item: {
    type: 'function_call', call_id: 'spawn', name: 'spawn_agent',
    arguments: JSON.stringify({ task_name: 'helper', message: 'gAAAAAEncryptedPrompt==' }),
  } });
  await view.flush();
  if (timing !== 'before spawn') tracker.activity(started, 'parent-turn');
  view.router.handleNotification('item/completed', { threadId: 'parent', turnId: 'parent-turn', item: started });
  await view.flush();
  expect(view.parent.querySelectorAll('.claudian-subagent-list')).toHaveLength(1);
  expect(view.parent.textContent).not.toContain('gAAAAA');
  expect(within(view.parent).queryByRole('button', { name: /^Prompt/ })).toBeNull();
  expect(view.parent.textContent).not.toContain('No prompt provided');
  expect(view.tools).toHaveLength(1);
  view.stream.resetStreamingState();
  view.renderer.renderMessages(view.state.messages, () => 'Hello');
  tracker.turnStarted('child', 'child-turn');
  for (const item of [
    { type: 'custom_tool_call', call_id: 'clock-call', name: 'exec', input: 'const t = await tools.clock__curr_time({}); text(t.current_time);' },
    { type: 'custom_tool_call_output', call_id: 'clock-call', output: [{ type: 'input_text', text: 'Clock result' }] },
  ]) tracker.handleNotification('child', 'child-turn', 'rawResponseItem/completed', { threadId: 'child', turnId: 'child-turn', item });
  tracker.turnCompleted('child', { id: 'child-turn', status: 'completed', error: null, items: [
    { type: 'agentMessage', id: 'answer', text: 'Ready.', phase: 'final_answer', memoryCitation: null },
  ] });
  expect(view.tools[0].subagent).toMatchObject({ status: 'completed', result: 'Ready.' });
  expect(view.parent.textContent).toContain('Ready.');
  expandButton(view.parent, /^Subagent task:/);
  expandButton(view.parent, /^clock__curr_time/);
  expect(view.parent.querySelectorAll('.claudian-subagent-tool-item')).toHaveLength(1);
  expect(view.parent.textContent).toContain('clock__curr_time');
  expect(view.parent.textContent).toContain('Clock result');
  // A reopened conversation already has raw-only child tools from history.
  tracker = new CodexSubagentTracker(info => view.stream.subagents.handleSubagentUpdate(info), async () => ({
    id: 'child', turns: [{ id: 'child-turn', status: 'completed', error: null, items: [
      { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: 'Ready.', memoryCitation: null },
    ] }],
  } as Thread));
  tracker.seed({ id: 'parent', turns: [{ id: 'parent-turn', status: 'completed', error: null,
    items: [started, { ...started, id: 'completed', kind: 'completed' }],
  }] } as Thread);
  tracker.activity({ ...started, id: 'idle-message', kind: 'interacted' }, 'later-parent-turn');
  await Promise.resolve();
  expect(view.parent.querySelectorAll('.claudian-subagent-tool-item')).toHaveLength(1);
  expect(view.parent.textContent).toContain('Ready.');
  const laterMessage: ChatMessage = { id: 'later', role: 'assistant', content: '', timestamp: testDate().getTime(), toolCalls: [] };
  view.state.addMessage(laterMessage);
  view.state.currentContentEl = view.renderer.addMessage(laterMessage).querySelector('.claudian-message-content');
  const followup = { type: 'tool_use' as const, id: 'followup', name: 'followup_task', input: { target: 'helper', message: 'Run bash date' } };
  let followupWork = Promise.resolve();
  const followupRouter = new CodexNotificationRouter(chunk => {
    followupWork = followupWork.then(() => view.stream.handleStreamChunk(chunk, laterMessage));
  }, '/workspace');
  const emitFollowupRaw = () => {
    followupRouter.handleNotification('rawResponseItem/completed', { threadId: 'parent', turnId: 'later-parent-turn', item: {
      type: 'function_call', call_id: followup.id, name: followup.name, arguments: JSON.stringify(followup.input),
    } });
    return followupWork;
  };
  if (timing === 'after spawn') await emitFollowupRaw();
  const interaction = { ...started, id: 'followup', kind: 'interacted' as const };
  tracker.activity(interaction, 'later-parent-turn');
  followupRouter.handleNotification('item/completed', { threadId: 'parent', turnId: 'later-parent-turn', item: interaction });
  await followupWork;
  tracker.turnStarted('child', 'child-turn-2');
  if (timing === 'before spawn') await emitFollowupRaw();
  expect(view.tools[0].subagent).toMatchObject({ status: 'completed', result: 'Ready.' });
  expect(laterMessage.toolCalls![0].subagent).toMatchObject({ id: 'followup', status: 'running', toolCalls: [] });
  followupRouter.handleNotification('item/started', { threadId: 'parent', turnId: 'later-parent-turn', item: {
    type: 'collabAgentToolCall', id: 'native-wait', tool: 'wait', status: 'inProgress', senderThreadId: 'parent',
    receiverThreadIds: [], agentsStates: {},
  } });
  await followupWork;
  await view.stream.handleStreamChunk({ type: 'done' }, laterMessage);
  expect(view.state.currentContentEl!.querySelector('[data-tool-id="native-wait"]')).toBeNull();
  expandButton(view.state.currentContentEl!, /^Subagent task:/);
  const liveHistory = within(view.state.currentContentEl!).getByRole('button', { name: 'Previous runs (1)' });
  liveHistory.focus();
  const dateItems = timing === 'native only' ? [
    { type: 'commandExecution', id: 'date-call', command: "bash -lc 'date'", cwd: '/workspace',
      commandActions: [{ type: 'unknown', command: "bash -lc 'date'" }], status: 'completed',
      aggregatedOutput: 'Date result', exitCode: 0, durationMs: 1 },
  ] : [
    { type: 'custom_tool_call', call_id: 'date-call', name: 'exec', input: "text(await tools.exec_command({cmd: \"bash -lc 'date'\"}));" },
    { type: 'custom_tool_call_output', call_id: 'date-call', output: [{ type: 'input_text', text: 'Date result' }] },
  ];
  for (const item of dateItems) tracker.handleNotification('child', 'child-turn-2',
    item.type === 'commandExecution' ? 'item/completed' : 'rawResponseItem/completed',
    { threadId: 'child', turnId: 'child-turn-2', item });
  expandButton(view.state.currentContentEl!, /^Bash/);
  liveHistory.focus();
  expect(view.state.currentContentEl!.textContent).toContain('Date result');
  tracker.turnCompleted('child', { id: 'child-turn-2', status: 'completed', error: null, items: [
    { type: 'agentMessage', id: 'answer-2', text: 'Two.', phase: 'final_answer', memoryCitation: null },
  ] });
  expect(document.activeElement).toBe(liveHistory);
  await view.stream.handleStreamChunk({ type: 'tool_result', id: 'followup', content: '' }, laterMessage);
  await view.stream.handleStreamChunk({ type: 'tool_use', id: 'wait', name: 'wait_agent', input: { targets: ['helper'] } }, laterMessage);
  await view.stream.handleStreamChunk({ type: 'tool_result', id: 'wait', content: 'aborted by user', isError: true }, laterMessage);
  const finalMessage: ChatMessage = { id: 'final-run', role: 'assistant', content: '', timestamp: testDate().getTime(), toolCalls: [] };
  view.state.addMessage(finalMessage);
  view.state.currentContentEl = view.renderer.addMessage(finalMessage).querySelector('.claudian-message-content');
  await view.stream.handleStreamChunk({ type: 'tool_use', id: 'followup-2', name: 'followup_task', input: { target: 'helper', message: 'One more run' } }, finalMessage);
  tracker.activity({ ...started, id: 'followup-2', kind: 'interacted' }, 'final-parent-turn');
  tracker.turnStarted('child', 'child-turn-3');
  tracker.turnCompleted('child', { id: 'child-turn-3', status: 'completed', error: null, items: [
    { type: 'agentMessage', id: 'answer-3', text: 'Three.', phase: 'final_answer', memoryCitation: null },
  ] });
  const savedMessages = JSON.stringify(view.state.messages);
  for (const reload of [false, true]) {
    if (reload) view.renderer.renderMessages(view.state.messages, () => 'Hello');
    const original = view.parent.querySelector('[data-message-id="response"]')! as HTMLElement;
    const later = view.parent.querySelector('[data-message-id="later"]')! as HTMLElement;
    expandButton(original, /^Subagent task:/);
    expandButton(original, /^clock__curr_time/);
    expandButton(later, /^Subagent task:/);
    expandButton(later, /^Bash/);
    expect(original.querySelectorAll('.claudian-subagent-list')).toHaveLength(1);
    expect(original.textContent).toContain('Ready.');
    expect(original.textContent).toContain('Clock result');
    expect(original.textContent).not.toContain('Date result');
    expect(later.querySelectorAll('.claudian-subagent-list')).toHaveLength(1);
    expect(later.textContent).toContain('Two.');
    expect(later.textContent).toContain('Date result');
    expect(later.textContent).not.toContain('Clock result');
    expect(view.parent.textContent).not.toContain('aborted by user');
    expect(within(original).queryByRole('button', { name: /^Previous runs/ })).toBeNull();
    const history = within(later).getByRole('button', { name: 'Previous runs (1)' });
    expect(history.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(history);
    const run = within(later).getByRole('button', { name: 'Run 1 · Completed' });
    expect(run.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(run);
    const runBody = document.getElementById(run.getAttribute('aria-controls')!)!;
    expandButton(runBody, /^clock__curr_time/);
    expect(within(runBody).getByRole('button', { name: /^Result/ }).getAttribute('aria-expanded')).toBe('true');
    expect(later.textContent).toContain('Clock result');
    expect(later.textContent).toContain('Ready.');
    expect(later.textContent).not.toContain('Three.');
    expect(later.querySelectorAll('[data-subagent-id="spawn"]')).toHaveLength(0);
    expect(within(later).queryByRole('button', { name: 'Go to original turn' })).toBeNull();
    const final = view.parent.querySelector('[data-message-id="final-run"]')! as HTMLElement;
    expandButton(final, /^Subagent task:/);
    fireEvent.click(within(final).getByRole('button', { name: 'Previous runs (2)' }));
    expect(within(final).getAllByRole('button', { name: /^Run \d/ }).map(button => button.textContent))
      .toEqual(['Run 1 · Completed', 'Run 2 · Completed']);
    const secondRun = within(final).getByRole('button', { name: 'Run 2 · Completed' });
    fireEvent.click(secondRun);
    expandButton(document.getElementById(secondRun.getAttribute('aria-controls')!)!, /^Bash/);
    expect(final.textContent!.includes('Run bash date')).toBe(timing !== 'native only');
    expect(final.textContent).toContain('Date result');
    expect(final.textContent).toContain('Two.');
    expect(final.textContent).not.toContain('Clock result');
    expect(JSON.stringify(view.state.messages)).toBe(savedMessages);
    expect(await axe(view.parent)).toHaveNoViolations();
  }
});

it('shows previous runs after completed-turn regrouping without navigation or other agents', async () => {
  const view = await createCodexLifecycleView();
  const tool = (id: string, agentId: string): ToolCallInfo => ({
    id, name: 'spawn_agent', input: {}, status: 'completed',
    subagent: { id, agentId, lifecycleSource: 'session', description: 'Helper', status: 'completed',
      prompt: `${id} prompt`, result: `${id} result`, isExpanded: false, toolCalls: [] },
  });
  const messages: ChatMessage[] = [
    { id: 'intro', role: 'assistant', content: 'Starting', timestamp: testDate().getTime() },
    { id: 'original', role: 'assistant', content: 'First answer', timestamp: testDate().getTime(), durationSeconds: 1,
      responseContinuationOf: 'intro', toolCalls: [tool('other', 'other-child'), tool('first', 'child')],
      contentBlocks: [{ type: 'tool_use', toolId: 'other' }, { type: 'tool_use', toolId: 'first' }, { type: 'text', content: 'First answer' }] },
    { id: 'request', role: 'user', content: 'Continue', timestamp: testDate().getTime() },
    { id: 'next', role: 'assistant', content: 'Next answer', timestamp: testDate().getTime(), durationSeconds: 2,
      toolCalls: [tool('second', 'child')], contentBlocks: [{ type: 'tool_use', toolId: 'second' }, { type: 'text', content: 'Next answer' }] },
  ];
  view.renderer.renderMessages(messages, () => 'Hello');
  const previousWork = within(view.parent).getByRole('button', { name: 'Worked for 00:01' });
  expect(previousWork.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(within(view.parent).getByRole('button', { name: 'Worked for 00:02' }));
  fireEvent.click(within(view.parent).getByRole('button', { name: 'Previous runs (1)' }));
  fireEvent.click(within(view.parent).getByRole('button', { name: 'Run 1 · Completed' }));
  const history = view.parent.querySelector<HTMLElement>('.claudian-subagent-history')!;
  expect(history.textContent).toContain('first prompt');
  expect(history.textContent).toContain('first result');
  expect(history.textContent).not.toContain('other result');
  expect(within(history).queryByRole('button', { name: 'Go to original turn' })).toBeNull();
  expect(previousWork.getAttribute('aria-expanded')).toBe('false');
  expect(await axe(view.parent)).toHaveNoViolations();
});

it.each([undefined, '', '   '])('hides an unavailable prompt (%s) and reveals a later readable prompt', prompt => {
  const parent = document.body.createDiv();
  const info: SubagentInfo = { id: 'empty-prompt', description: 'Helper', prompt, status: 'running', isExpanded: true, toolCalls: [] };
  const state = createSubagentBlock(parent, info);
  fireEvent.click(within(parent).getByRole('button', { name: /Subagent task: Helper/ }));
  expect(within(parent).queryByRole('button', { name: /^Prompt/ })).toBeNull();
  updateSubagentBlock(state, { ...info, prompt: 'Read this file.' });
  expect(within(parent).getByRole('button', { name: /^Prompt/ })).toBeTruthy();
  expect(parent.textContent).toContain('Read this file.');
  updateSubagentBlock(state, { ...info, prompt: undefined });
  expect(within(parent).queryByRole('button', { name: /^Prompt/ })).toBeNull();
});

it.each([
  ['completed', undefined, 'chat.tools.done'], ['completed', 'DONE', undefined],
  ['error', undefined, 'chat.tools.errorResult'], ['error', 'ERROR', undefined],
] as const)('localizes only absent sync %s results (%s)', async (status, result, expectedKey) => {
  const englishStatus = t(`chat.tools.status.${status}`);
  setLocale('zh-CN');
  expect(t(`chat.tools.status.${status}`)).not.toBe(englishStatus);
  const parent = document.body.createDiv();
  const info: SubagentInfo = { id: 'localized-sync', description: 'Native task', status, result, isExpanded: false, toolCalls: [] };
  createSubagentBlock(parent, info);
  const taskLabel = t('chat.subagentUI.taskLabel', { description: 'Native task', status: t(`chat.tools.status.${status}`) });
  fireEvent.click(within(parent).getByRole('button', { name: t('chat.disclosure.expand', { label: taskLabel }) }));
  fireEvent.click(within(parent).getByRole('button', { name: t('chat.disclosure.expand', { label: t('chat.subagentUI.result') }) }));
  expect(within(parent).getByText(expectedKey ? t(expectedKey) : result!)).toBeDefined();
  expect(info.result).toBe(result);
  expect(await axe(parent)).toHaveNoViolations();
});

it('localizes background status updates and keeps supplied results as native data', async () => {
  const englishInit = t('chat.subagentUI.initializing');
  setLocale('zh-CN');
  expect(t('chat.subagentUI.initializing')).not.toBe(englishInit);
  const parent = document.body.createDiv();
  const info: SubagentInfo = { id: 'localized-async', description: 'Native task', mode: 'async',
    status: 'running', asyncStatus: 'pending', isExpanded: false, toolCalls: [] };
  const state = createAsyncSubagentBlock(parent, info);
  const ui = within(parent);
  const bgLabel = (statusText: string) => t('chat.subagentUI.backgroundTaskLabel', { description: 'Native task', status: statusText });
  const initText = t('chat.subagentUI.initializing');
  fireEvent.click(ui.getByRole('button', { name: t('chat.disclosure.expand', { label: bgLabel(initText) }) }));
  expect(state.statusTextEl.textContent).toBe(initText);
  expect(state.statusEl.getAttribute('aria-label')).toBe(t('chat.subagentUI.statusLabel', { status: initText }));
  for (const [asyncStatus, labelKey] of [['running', 'chat.subagentUI.runningInBackground'], ['completed', 'chat.subagentUI.completed']] as const) {
    const label = t(labelKey);
    updateAsyncSubagentBlock(state, { ...info, asyncStatus, status: asyncStatus });
    expect(state.statusTextEl.textContent).toBe('');
    expect(ui.getByRole('button', { name: t('chat.disclosure.collapse', { label: bgLabel(label) }) })).toBeDefined();
    expect(state.statusEl.getAttribute('aria-label')).toBe(t('chat.subagentUI.statusLabel', { status: label }));
  }
  expect(state.resultBodyEl!.textContent).toBe(t('chat.tools.done'));
  const errorText = t('chat.subagentUI.error');
  updateAsyncSubagentBlock(state, { ...info, asyncStatus: 'error', status: 'error' });
  expect(ui.getByRole('button', { name: t('chat.disclosure.collapse', { label: bgLabel(errorText) }) })).toBeDefined();
  expect(state.statusTextEl.textContent).toBe(errorText);
  expect(state.statusEl.getAttribute('aria-label')).toBe(t('chat.subagentUI.statusLabel', { status: errorText }));
  fireEvent.click(ui.getByRole('button', { name: t('chat.disclosure.expand', { label: t('chat.subagentUI.result') }) }));
  expect(within(state.resultBodyEl!).getByText(t('chat.tools.errorResult'))).toBeDefined();
  const orphanedText = t('chat.subagentUI.orphaned');
  for (const result of [undefined, 'Conversation ended before task completed', '   ']) {
    updateAsyncSubagentBlock(state, { ...info, asyncStatus: 'orphaned', status: 'error', result });
    expect(ui.getByRole('button', { name: t('chat.disclosure.collapse', { label: bgLabel(orphanedText) }) })).toBeDefined();
    expect(state.statusTextEl.textContent).toBe(orphanedText);
    expect(state.statusEl.getAttribute('aria-label')).toBe(t('chat.subagentUI.statusLabel', { status: orphanedText }));
    expect(state.resultBodyEl!.textContent).toBe(result || t('chat.subagentUI.orphanedResult'));
  }
  for (const [asyncStatus, result] of [['completed', 'DONE'], ['error', 'ERROR']] as const) {
    updateAsyncSubagentBlock(state, { ...info, asyncStatus, status: asyncStatus, result });
    expect(state.resultBodyEl!.textContent).toBe(result);
  }
  expect(await axe(parent)).toHaveNoViolations();
});

it('localizes lazy previous runs without copying current or unrelated results', async () => {
  const englishPreviousRuns = t('chat.subagentUI.previousRuns', { count: 1 });
  setLocale('zh-CN');
  expect(t('chat.subagentUI.previousRuns', { count: 1 })).not.toBe(englishPreviousRuns);
  const view = await createCodexLifecycleView();
  const tool = (id: string, agentId: string): ToolCallInfo => ({
    id, name: 'spawn_agent', input: {}, status: 'completed',
    subagent: { id, agentId, lifecycleSource: 'session', description: 'Native task', status: 'completed',
      prompt: `${id} prompt`, result: `${id} result`, isExpanded: false, toolCalls: [] },
  });
  const messages: ChatMessage[] = [
    { id: 'original', role: 'assistant', content: '', timestamp: testDate().getTime(), toolCalls: [tool('other', 'other-child'), tool('first', 'child')] },
    { id: 'rebuilt', role: 'assistant', content: '', timestamp: testDate().getTime(), isRebuiltContext: true, toolCalls: [tool('rebuilt', 'child')] },
    { id: 'current', role: 'assistant', content: '', timestamp: testDate().getTime(), toolCalls: [tool('second', 'child')] },
  ];
  const saved = JSON.stringify(messages);
  view.renderer.renderMessages(messages, () => 'Hello');
  const current = view.parent.querySelector<HTMLElement>('[data-message-id="current"]')!;
  const taskPrefix = t('chat.subagentUI.taskLabel', { description: 'Native task', status: t('chat.tools.status.completed') });
  expandButton(current, new RegExp(`^${taskPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  const history = within(current).getByRole('button', { name: t('chat.subagentUI.previousRuns', { count: 1 }) });
  expect(within(current).queryByText('first result')).toBeNull();
  fireEvent.click(history);
  const run = within(current).getByRole('button', { name: t('chat.subagentUI.runLabel', { number: 1, status: t('chat.subagentUI.completed') }) });
  expect(within(current).queryByText('first result')).toBeNull();
  fireEvent.click(run);
  const body = document.getElementById(run.getAttribute('aria-controls')!)!;
  expect(within(body).getByText('first prompt')).toBeDefined();
  expect(within(body).getByText('first result')).toBeDefined();
  expect(body.textContent).not.toContain('second result');
  expect(body.textContent).not.toContain('other result');
  expect(body.textContent).not.toContain('rebuilt result');
  expect(JSON.stringify(messages)).toBe(saved);
  expect(await axe(view.parent)).toHaveNoViolations();
});
