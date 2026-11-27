import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';

import { TEST_CODEX_CATALOG, TEST_CODEX_MODEL } from '@test/helpers/codexModels';
import { DesktopVault } from '@test/helpers/core/DesktopVault';
import { answerApproval } from '@test/helpers/features/chat/approvalDecisionOptions';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { type CodexNativeTestProcess as FakeProcess,CodexRuntimeHarness } from '@test/helpers/providers/codex/CodexRuntimeHarness';

import type { ProviderExecutionEvent, ProviderExecutionRequest, ProviderInteractionPort, ProviderSessionConfig } from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { ProviderRuntimeHost } from '@/core/providers/ProviderRuntimeHost';
import { createCodexWorkspaceServices } from '@/providers/codex/app/CodexWorkspaceServices';
import { CodexExecutionBackend } from '@/providers/codex/execution/CodexExecutionBackend';
import { CodexAppServerRuntime } from '@/providers/codex/runtime/CodexAppServerRuntime';
import { CodexThreadScope } from '@/providers/codex/runtime/CodexThreadScope';

/** The backend resolves its runtime per session; tests pin one instance. */
const fixedRuntime = (runtime: CodexAppServerRuntime) => (): CodexAppServerRuntime => runtime;
const scoped = (host: ProviderHost): ProviderRuntimeHost => host.getRuntimeHost('codex');
const createBackend = (host: ProviderHost, runtime: CodexAppServerRuntime): CodexExecutionBackend => new CodexExecutionBackend(
  scoped(host),
  fixedRuntime(runtime),
);

const mockNative = new CodexRuntimeHarness();

vi.mock('cross-spawn', () => ({ default: vi.fn(() => mockNative.createProcess()) }));


describe('Codex shared runtime', () => {
  const runtimes: CodexAppServerRuntime[] = [];
  let plugin: ProviderHost;
  function createRuntime(warn = vi.fn()): CodexAppServerRuntime {
    const runtime = new CodexAppServerRuntime(scoped(plugin), warn);
    runtimes.push(runtime);
    return runtime;
  }
  beforeEach(async () => {
    mockNative.reset();
    plugin = (await createProviderHostFixture({ vault: sharedVault, overrides: { getResolvedProviderCliPath: async () => '/native/codex' }, settings: { providerConfigs: { codex: { enabled: true, discoveredModels: TEST_CODEX_CATALOG } } } })).host;
  });
  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()));
  });

  const waitForRequest = mockNative.waitForRequest.bind(mockNative);

  it('drains the old fingerprint while new consumers use its replacement', async () => {
    const runtime = createRuntime();
    const old = await runtime.acquire({ readiness: 'initialized' });
    plugin.settings.providerConfigs.codex!.environmentVariables = 'KEY=second';
    const replacement = await runtime.acquire({ readiness: 'initialized' });
    expect(mockNative.processes).toHaveLength(2);
    expect(old.connection.isRetired()).toBe(true);
    expect(old.connection.isAlive()).toBe(true);
    expect(replacement.connection.isAlive()).toBe(true);
    await old.release();
    expect(old.connection.isAlive()).toBe(false);
    await replacement.release();
    expect(replacement.connection.isAlive()).toBe(true);
  });

  const config: ProviderSessionConfig = {
    lifecycle: 'persistent', nativePersistence: 'enabled', workingDirectory: '/vault',
    interactionPort: { requestApproval: vi.fn(), askUserQuestion: vi.fn(), dismissInteraction: vi.fn() },
  };
  const request: ProviderExecutionRequest = {
    input: [{ type: 'text', text: 'hello' }],
    configuration: { model: TEST_CODEX_MODEL, permissionMode: 'yolo', systemInstructions: { kind: 'explicit', purpose: 'title', instructions: 'Be concise.' } },
    toolPolicy: { kind: 'provider-default' }, signal: new AbortController().signal,
  };
  async function collect(events: AsyncIterable<ProviderExecutionEvent>): Promise<ProviderExecutionEvent[]> {
    const result: ProviderExecutionEvent[] = [];
    for await (const event of events) result.push(event);
    return result;
  }
  function complete(process: FakeProcess, threadId: string): void {
    process.notify('turn/completed', { threadId, turn: { id: process.turns.get(threadId)?.id ?? `turn-${threadId}`, status: 'completed', items: [] } });
  }

  async function sessionToolCall(process: FakeProcess, threadId: string, tool = 'claudian_list_destinations', args: unknown = {}, turnId = process.turns.get(threadId)!.id) {
    const id = `session-call-${process.requests.length}`;
    return process.requestFromServer(id, 'item/tool/call', {
      threadId, turnId, callId: id, namespace: 'claudian_sessions', tool, arguments: args,
    });
  }

  it('does not advertise or execute retired session tools on new threads', async () => {
    mockNative.autoReconcile = true;
    const session = createBackend(plugin, createRuntime()).createSession(config);
    const output = collect(session.execute(request).events);
    const process = await waitForRequest('turn/start');
    const specs = process.requests.find(call => call.method === 'thread/start')!.params.dynamicTools ?? [];
    expect(specs.filter((spec) => spec.namespace === 'claudian_sessions').map((spec) => spec.name))
      .toEqual([]);
    expect(specs.every((spec) => !('type' in spec))).toBe(true);
    expect(await sessionToolCall(process, 'thread-1')).toMatchObject({ result: { success: false } });
    complete(process, 'thread-1');
    await output;
    expect(session.getSnapshot().providerState?.sessionToolVersion).toBeUndefined();
    await session.dispose();
  });

  it.each([undefined, 1])('resumes a version %s thread without attempting to replace its fixed specs', async sessionToolVersion => {
    mockNative.autoReconcile = true;
    const session = createBackend(plugin, createRuntime()).createSession({ ...config,
      resumeSeed: { providerSessionId: 'existing', providerState: { threadId: 'existing', sessionToolVersion } },
    });
    const output = collect(session.execute(request).events);
    const process = await waitForRequest('turn/start');
    const resumed = process.requests.find(call => call.method === 'thread/resume')!;
    expect(resumed.params).not.toHaveProperty('dynamicTools');
    expect(resumed.params.baseInstructions).not.toContain('claudian_send_message');
    expect(session.getSnapshot().providerState?.sessionToolVersion).toBe(sessionToolVersion);
    complete(process, 'existing');
    await output;
    await session.dispose();
  });

  it('stops late native work through global status after closing and unsubscribing its chat', async () => {
    mockNative.autoReconcile = true;
    const backend = createBackend(plugin, createRuntime());
    const first = backend.createSession(config);
    const second = backend.createSession(config);
    const firstOutput = collect(first.execute(request).events);
    const secondOutput = collect(second.execute(request).events);
    const process = await waitForRequest('turn/start');
    await waitForRequest('turn/start', 0, 2);
    complete(process, 'thread-1');
    await firstOutput;
    await first.dispose();
    expect(process.unsubscribed.has('thread-1')).toBe(true);
    let wokeAgain = false;
    mockNative.requestOverride = (native, rpc) => {
      if (rpc.method !== 'turn/interrupt' || rpc.params.threadId !== 'thread-1' || wokeAgain) return false;
      wokeAgain = true;
      native.notify('thread/status/changed', { threadId: 'thread-1', status: { type: 'idle' } });
      native.notify('turn/started', { threadId: 'thread-1', turn: { id: 'second-mail', status: 'inProgress', items: [] } });
      native.notify('thread/status/changed', { threadId: 'thread-1', status: { type: 'active', activeFlags: [] } });
      native.respond(rpc.id, {});
      return true;
    };
    // Native turn events are subscription-scoped. Status remains broadcast.
    process.notify('turn/started', { threadId: 'thread-1', turn: { id: 'late-mail', status: 'inProgress', items: [] } });
    process.notify('thread/status/changed', { threadId: 'thread-1', status: { type: 'active', activeFlags: [] } });
    await waitForRequest('turn/interrupt', 0, 2, rpc => rpc.params.threadId === 'thread-1');
    expect(process.requests.filter(r => r.method === 'turn/interrupt').map(r => r.params.threadId)).toContain('thread-1');
    expect(process.turns.get('thread-1')?.status).toBe('interrupted');
    // No parent item event survives unsubscribe. A grandchild can become visible
    // while discovery of its parent is still awaiting metadata.
    process.parents.set('late-child', 'thread-1');
    process.parents.set('late-grandchild', 'late-child');
    process.parents.set('other-child', 'thread-2');
    let childRead: number | undefined;
    mockNative.requestOverride = (_native, rpc) => {
      if (rpc.method !== 'thread/read' || rpc.params.threadId !== 'late-child') return false;
      childRead = rpc.id;
      return true;
    };
    for (const threadId of ['late-grandchild', 'late-child', 'other-child']) {
      process.notify('turn/started', { threadId, turn: { id: `turn-${threadId}`, status: 'inProgress', items: [] } });
      process.notify('thread/status/changed', { threadId, status: { type: 'active', activeFlags: [] } });
    }
    await waitForRequest('thread/read', 0, 1, rpc => rpc.params.threadId === 'late-child');
    expect(childRead).toBeDefined();
    mockNative.requestOverride = null;
    process.respond(childRead!, { thread: { id: 'late-child', parentThreadId: 'thread-1', status: { type: 'active' }, turns: [] } });
    await waitForRequest('turn/interrupt', 0, 1, rpc => rpc.params.threadId === 'late-child');
    await waitForRequest('turn/interrupt', 0, 1, rpc => rpc.params.threadId === 'late-grandchild');
    expect(process.turns.get('late-child')?.status).toBe('interrupted');
    expect(process.turns.get('late-grandchild')?.status).toBe('interrupted');
    expect(process.turns.get('other-child')?.status).toBe('inProgress');
    expect(process.requests.filter(r => r.method === 'turn/interrupt').map(r => r.params.threadId)).not.toContain('thread-2');
    complete(process, 'thread-2');
    expect((await secondOutput).at(-1)?.type).toBe('turn_completed');
    expect(process.isAlive()).toBe(true);
    await second.dispose();
  });

  it('keeps the next turn’s image until its own pending start settles after an earlier response', async () => {
    mockNative.autoReconcile = true;
    // Observe the real client's start completion, including input cleanup after the decoded response.
    const clientStarts = vi.spyOn(CodexThreadScope.prototype, 'startTurn');
    onTestFinished(() => clientStarts.mockRestore());
    const starts: FakeProcess['requests'] = [];
    mockNative.requestOverride = (_process, rpc) => {
      if (rpc.method !== 'turn/start') return false;
      starts.push(rpc);
      return true;
    };
    const session = createBackend(plugin, createRuntime()).createSession(config);
    const firstEvents = collect(session.execute(request).events);
    const process = await waitForRequest('turn/start');
    const firstTurn = { id: 'first', status: 'inProgress', items: [] };
    process.notify('turn/started', { threadId: 'thread-1', turn: firstTurn });
    complete(process, 'thread-1');
    expect((await firstEvents).at(-1)?.type).toBe('turn_completed');
    const second = session.execute({ ...request, input: [{ type: 'image', image: {
      id: 'image-1', name: 'pasted.png', mediaType: 'image/png', data: 'aGVsbG8=', size: 5, source: 'paste',
    } }] });
    const secondEvents = collect(second.events);
    await waitForRequest('turn/start', 0, 2);
    expect(starts).toHaveLength(2);
    const imageInput = starts[1].params.input!.find(item => item.type === 'localImage')!;
    const inputPath: string = imageInput.path;
    try {
      expect(readFileSync(inputPath)).toEqual(Buffer.from('hello'));
      process.respond(starts[0].id, { turn: firstTurn });
      await clientStarts.mock.results[0].value;
      second.cancel();
      expect((await secondEvents).at(-1)?.type).toBe('cancelled');
      expect(existsSync(inputPath)).toBe(true);
    } finally {
      process.respond(starts[0].id, { turn: firstTurn });
      process.respond(starts[1].id, { turn: { id: 'second', status: 'inProgress', items: [] } });
      await session.dispose();
    }
    expect(existsSync(inputPath)).toBe(false);
    expect(process.isAlive()).toBe(true);
  });

  it('routes a native approval exclusively to its owning chat', async () => {
    mockNative.autoReconcile = true;
    const backend = createBackend(plugin, createRuntime());
    const approval = () => vi.fn<ProviderInteractionPort['requestApproval']>(async interaction => answerApproval(interaction, 'allow'));
    const firstApproval = approval();
    const secondApproval = approval();
    const first = backend.createSession({ ...config, interactionPort: { ...config.interactionPort, requestApproval: firstApproval } });
    const second = backend.createSession({ ...config, interactionPort: { ...config.interactionPort, requestApproval: secondApproval } });
    const output = [first, second].map(session => collect(session.execute(request).events));
    const process = await waitForRequest('turn/start');
    await waitForRequest('turn/start', 0, 2);
    await process.requestFromServer('approval', 'item/commandExecution/requestApproval', {
      threadId: 'thread-2', turnId: 'turn-thread-2', itemId: 'command', command: 'pwd', cwd: '/vault',
    });
    expect(secondApproval).toHaveBeenCalledTimes(1);
    expect(firstApproval).not.toHaveBeenCalled();
    complete(process, 'thread-1');
    complete(process, 'thread-2');
    await Promise.all(output);
    await Promise.all([first.dispose(), second.dispose()]);
  });

  it('keeps active execution through a workspace transition, resumes on the replacement, and disposes on disable', async () => {
    mockNative.autoReconcile = true;
    const host = plugin;
    const registry = host.executionLifecycleRegistry;
    const services = await createCodexWorkspaceServices(host);
    const backend = createBackend(host, services.runtime);
    const first = registry.acquire(backend, config, 'chat');
    const firstEvents = collect(first.session.execute(request).events);
    try {
      const old = await waitForRequest('turn/start');
      await registry.runTransition(['codex'], async () => { plugin.settings.providerConfigs.codex!.environmentVariables = 'KEY=second'; });
      expect(first.isCurrent()).toBe(true);
      expect(old.isAlive()).toBe(true);
      const second = registry.acquire(backend, config, 'chat');
      const secondEvents = collect(second.session.execute(request).events);
      const replacement = await waitForRequest('turn/start', 1);
      complete(old, 'thread-1');
      expect(await firstEvents).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'turn_completed' })]));
      if (old.isAlive()) await once(old, 'exit');
      expect(old.isAlive()).toBe(false);
      const resumed = collect(first.session.execute(request).events);
      await waitForRequest('thread/resume', 1);
      await waitForRequest('turn/start', 1, 2);
      expect(replacement.requests.filter(r => r.method === 'turn/start')).toHaveLength(2);
      complete(replacement, 'thread-1');
      expect(await resumed).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'turn_completed' })]));
      await registry.runTransition(['codex'], async () => { host.settings.providerConfigs.codex!.enabled = false; });
      expect(first.isCurrent()).toBe(false);
      expect(second.isCurrent()).toBe(false);
      expect(await secondEvents).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'cancelled' })]));
      expect(replacement.isAlive()).toBe(false);
    } finally {
      await registry.dispose();
      await services.dispose();
    }
  });

  it('fails active chats on a crash and resumes their persistent threads lazily on one replacement', async () => {
    mockNative.autoReconcile = true;
    const backend = createBackend(plugin, createRuntime());
    const first = backend.createSession(config);
    const second = backend.createSession(config);
    const runs = [first, second].map(session => collect(session.execute(request).events));
    const process = await waitForRequest('turn/start');
    await waitForRequest('turn/start', 0, 2);
    process.exit();
    const failed = await Promise.all(runs);
    for (const events of failed) expect(events.at(-1)).toMatchObject({ type: 'execution_error', category: 'process-exited' });
    expect(mockNative.processes).toHaveLength(1);
    const retries = [first, second].map(session => collect(session.execute(request).events));
    const replacement = await waitForRequest('turn/start', 1);
    await waitForRequest('turn/start', 1, 2);
    expect(replacement.requests.filter(r => r.method === 'thread/resume').map(r => r.params.threadId).sort()).toEqual(['thread-1', 'thread-2']);
    expect(replacement.requests.filter(r => r.method === 'thread/start')).toHaveLength(0);
    complete(replacement, 'thread-1');
    complete(replacement, 'thread-2');
    const completed = await Promise.all(retries);
    expect(completed.map(events => events.at(-1)?.type)).toEqual(['turn_completed', 'turn_completed']);
    expect(mockNative.processes).toHaveLength(2);
    await Promise.all([first.dispose(), second.dispose()]);
  });

  it.each([false, true])('stops owned children and late mailbox turns on Stop (parent completed: %s) while another chat continues', async (parentCompleted) => {
    mockNative.autoReconcile = true;
    const backend = createBackend(plugin, createRuntime());
    const first = backend.createSession(config);
    const second = backend.createSession(config);
    const firstRun = first.execute(request);
    const firstOutput = collect(firstRun.events);
    const secondOutput = collect(second.execute(request).events);
    const process = await waitForRequest('turn/start');
    await waitForRequest('turn/start', 0, 2);
    process.notify('item/completed', {
      threadId: 'thread-1', turnId: 'turn-thread-1',
      item: { type: 'subAgentActivity', id: 'spawn', kind: 'started', agentThreadId: 'child', agentPath: '/root/worker' },
    });
    process.notify('turn/started', { threadId: 'child', turn: { id: 'child-turn', status: 'inProgress', items: [] } });
    process.notify('item/completed', {
      threadId: 'child', turnId: 'child-turn',
      item: { type: 'subAgentActivity', id: 'spawn-grandchild', kind: 'started', agentThreadId: 'grandchild', agentPath: '/root/worker/helper' },
    });
    process.notify('turn/started', { threadId: 'grandchild', turn: { id: 'grandchild-turn', status: 'inProgress', items: [] } });
    if (parentCompleted) {
      complete(process, 'thread-1');
      await firstOutput;
    }
    const stopping = vi.spyOn(CodexThreadScope.prototype, 'stop');
    onTestFinished(() => stopping.mockRestore());
    first.cancel();
    await firstOutput;
    await waitForRequest('turn/interrupt', 0, 1, rpc => rpc.params.threadId === 'grandchild');
    await Promise.all(stopping.mock.results.map(result => result.value));
    expect(process.requests.filter(r => r.method === 'turn/interrupt').map(r => r.params.threadId)).toEqual(expect.arrayContaining(['child', 'grandchild']));
    expect(first.hasBackgroundWork?.()).toBe(false);
    expect(process.requests.filter(r => r.method === 'thread/unsubscribe')).toHaveLength(0);
    // Codex may already have queued mail that wakes a durably sleeping root.
    process.notify('turn/started', { threadId: 'thread-1', turn: { id: 'mailbox-turn', status: 'inProgress', items: [] } });
    await waitForRequest('turn/interrupt', 0, 1, rpc => rpc.params.turnId === 'mailbox-turn');
    expect(process.requests.filter(r => r.method === 'turn/interrupt').map(r => r.params.turnId)).toContain('mailbox-turn');
    expect(process.requests.filter(r => r.method === 'turn/interrupt').map(r => r.params.threadId)).not.toContain('thread-2');
    complete(process, 'thread-2');
    expect((await secondOutput).at(-1)?.type).toBe('turn_completed');
    expect(process.isAlive()).toBe(true);
    await Promise.all([first.dispose(), second.dispose()]);
  });

  it('isolates concurrent chat threads and keeps the server alive when one is cancelled or disposed', async () => {
    mockNative.autoReconcile = true;
    const backend = createBackend(plugin, createRuntime());
    const first = backend.createSession(config);
    const second = backend.createSession(config);
    const firstRun = first.execute(request);
    const secondRun = second.execute(request);
    const firstEvents = collect(firstRun.events);
    const secondEvents = collect(secondRun.events);
    try {
      await waitForRequest('turn/start', 0, 2);
      expect(mockNative.processes.flatMap(process => process.requests).filter(request => request.method === 'turn/start')).toHaveLength(2);
      expect(mockNative.processes).toHaveLength(1);
      const process = mockNative.processes[0];
      firstRun.cancel();
      await firstEvents;
      await first.dispose();
      expect(process.isAlive()).toBe(true);
      expect(process.requests.filter(request => request.method === 'turn/interrupt').map(request => request.params.threadId)).toEqual(['thread-1']);
      process.notify('item/agentMessage/delta', { threadId: 'thread-2', turnId: 'turn-thread-2', itemId: 'message', delta: 'second only' });
      process.notify('turn/completed', { threadId: 'thread-2', turn: { id: 'turn-thread-2', status: 'completed', items: [] } });
      expect(await secondEvents).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'turn_completed' })]));
      await second.dispose();
      expect(process.isAlive()).toBe(true);
    } finally {
      await Promise.all([first.dispose(), second.dispose()]);
      await Promise.all([firstEvents, secondEvents]);
    }
  });
});

let sharedVault: DesktopVault;
beforeAll(async () => { sharedVault = await DesktopVault.create(); });
afterAll(async () => { await sharedVault.dispose(); });
