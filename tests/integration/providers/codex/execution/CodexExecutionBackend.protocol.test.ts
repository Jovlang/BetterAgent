// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';

import { capturedSelectionPrompt, capturedSelections } from '@test/helpers/capturedSelections';
import { TEST_CODEX_MODEL } from '@test/helpers/codexModels';
import { DesktopVault } from '@test/helpers/core/DesktopVault';
import { answerApproval } from '@test/helpers/features/chat/approvalDecisionOptions';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { type CodexNativeRequest, CodexRuntimeHarness } from '@test/helpers/providers/codex/CodexRuntimeHarness';

import type {
  ProviderExecutionEvent,
  ProviderExecutionRequest,
  ProviderInteractionPort,
  ProviderSessionConfig,
  ProviderSessionEvent,
} from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { ClaudianSettings } from '@/core/types';
import { t } from '@/i18n/i18n';
import { CodexAppServerProcess } from '@/providers/codex/runtime/CodexAppServerProcess';

/** The backend resolves its runtime per session; tests pin one instance. */
const fixedRuntime = (runtime: CodexAppServerRuntime) => (): CodexAppServerRuntime => runtime;
type MutableTestHost = ProviderHost & { settings: ClaudianSettings };

const nativeRequest = vi.fn<(method: string, params: CodexNativeRequest['params']) => unknown>();
const nativeUnsubscribe = vi.fn<(params: CodexNativeRequest['params']) => Promise<{ status: string }>>().mockResolvedValue({ status: 'unsubscribed' });
const resolveCliPath = vi.fn(async () => '/native/codex');
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
let transportDispose: MockInstance;

let mockProcessStart: MockInstance<CodexAppServerProcess['start']>;
let mockProcessShutdown: MockInstance<CodexAppServerProcess['shutdown']>;
const native = new CodexRuntimeHarness();
vi.mock('cross-spawn', () => ({ default: vi.fn(() => native.createProcess()) }));

import { registerCodexForTests } from '@test/helpers/registerCodexForTests';
import type { MockInstance } from 'vitest';

import { CodexExecutionBackend } from '@/providers/codex/execution/CodexExecutionBackend';
import { CodexAppServerRuntime } from '@/providers/codex/runtime/CodexAppServerRuntime';
import { CodexRPCTransport } from '@/providers/codex/runtime/CodexRPCTransport';

registerCodexForTests();


const runtimes: CodexAppServerRuntime[] = [];
function createBackend(plugin: ProviderHost): CodexExecutionBackend {
  const host = plugin.getRuntimeHost('codex');
  const runtime = new CodexAppServerRuntime(host, () => undefined);
  runtimes.push(runtime);
  return new CodexExecutionBackend(
    host,
    fixedRuntime(runtime),
  );
}
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()));
  vi.restoreAllMocks();
  vi.useRealTimers();
  Object.defineProperty(process, 'platform', originalPlatform);
});

function nativeImagePath(input: CodexNativeRequest['params']['input']): string {
  const image = input?.[0];
  if (image?.type !== 'localImage') throw new Error('Expected a native localImage input');
  return image.path;
}


interface Deferred<T> {
  readonly promise: Promise<T>;
  reject(reason: unknown): void;
  resolve(value: T): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

function emitNotification(method: string, params: unknown): void {
  native.processes.at(-1)!.notify(method, params);
}

// Policies the app server derives from a config.toml with sandbox_workspace_write overrides.
const CONFIGURED_WORKSPACE_WRITE_SANDBOX = {
  type: 'workspaceWrite',
  writableRoots: ['/configured/root'],
  networkAccess: true,
  excludeTmpdirEnvVar: false,
  excludeSlashTmp: false,
} as const;


function createThreadResult(
  threadId: string,
  turns: Array<{
    id: string;
    error?: unknown;
    items?: unknown[];
    status?: 'completed' | 'failed' | 'inProgress' | 'interrupted';
  }> = [],
) {
  return {
    thread: {
      id: threadId,
      path: `/tmp/sessions/${threadId}.jsonl`,
      preview: '',
      ephemeral: false,
      status: { type: 'idle' },
      turns: turns.map(turn => ({
        ...turn,
        items: turn.items ?? [],
        status: turn.status ?? 'completed',
        error: turn.error ?? null,
      })),
      cwd: '/vault',
      cliVersion: '0.146.0',
      modelProvider: 'openai',
      source: 'app-server',
      createdAt: 0,
      lastActivityAt: 0,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
    },
    model: TEST_CODEX_MODEL,
    modelProvider: 'openai',
    serviceTier: null,
    cwd: '/vault',
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandbox: CONFIGURED_WORKSPACE_WRITE_SANDBOX as Record<string, unknown>,
    reasoningEffort: 'medium',
  };
}

function createTurnResult(turnId: string) {
  return {
    turn: { id: turnId, items: [], status: 'inProgress', error: null },
  };
}

async function createPlugin(): Promise<MutableTestHost> {
  const fixture = await createProviderHostFixture({ vault: sharedVault,
    overrides: { workingDirectory: '/vault', getResolvedProviderCliPath: resolveCliPath },
    settings: {
      model: TEST_CODEX_MODEL,
      effortLevel: 'medium',
      serviceTier: 'default',
      permissionMode: 'normal',
      systemPrompt: '',
      mediaFolder: '',
      userName: '',
      providerConfigs: {
        codex: {
          enabled: true,
          environmentVariables: `HOME=${sharedVault.root}\nUSERPROFILE=${sharedVault.root}`,
          discoveredModels: [{
            model: TEST_CODEX_MODEL,
            displayName: 'Test Codex',
            description: '',
            supportedReasoningEfforts: [
              { value: 'low', description: '' },
              { value: 'medium', description: '' },
              { value: 'high', description: '' },
            ],
            defaultReasoningEffort: 'medium',
            serviceTiers: [{ id: 'priority', name: 'Fast', description: '' }],
            defaultServiceTier: null,
            inputModalities: ['text', 'image'],
            isDefault: true,
          }],
        },
      },
    },
  });

  return fixture.host;
}

function createInteractionPort(): ProviderInteractionPort {
  return {
    requestApproval: vi.fn().mockImplementation(async request => answerApproval(request, 'allow')),
    askUserQuestion: vi.fn().mockImplementation(async request => ({
      interactionId: request.interactionId,
      answers: { choice: 'yes' },
    })),
    dismissInteraction: vi.fn(),
  };
}

function createSessionConfig(
  overrides: Partial<ProviderSessionConfig> = {},
): ProviderSessionConfig {
  return {
    lifecycle: 'persistent',
    nativePersistence: 'enabled',
    supportsReviewDenialPicker: true,
    workingDirectory: '/vault',
    interactionPort: createInteractionPort(),
    ...overrides,
  };
}

function createForkSessionConfig(
  providerState: Record<string, unknown> = {},
): ProviderSessionConfig {
  return createSessionConfig({
    resumeSeed: {
      providerState: {
        forkSourceSessionFilePath: '/tmp/source.jsonl',
        forkSourceTranscriptRootPath: '/tmp/sessions',
        forkSource: { sessionId: 'thread-source', resumeAt: 'checkpoint' },
        unknownFutureState: { keep: true },
        ...providerState,
      },
    },
  });
}



function createRequest(
  signal: AbortSignal = new AbortController().signal,
  overrides: Partial<ProviderExecutionRequest> = {},
): ProviderExecutionRequest {
  return {
    input: [{ type: 'text', text: 'hello' }],
    configuration: {
      systemInstructions: { kind: 'explicit', purpose: 'title', instructions: 'Be concise.' },
      model: TEST_CODEX_MODEL,
      reasoning: 'high',
      serviceTier: 'priority',
      permissionMode: 'normal',
    },
    toolPolicy: { kind: 'provider-default' },
    signal,
    ...overrides,
  };
}

async function collectEvents(
  events: AsyncIterable<ProviderExecutionEvent>,
  observe?: (event: ProviderExecutionEvent) => void,
): Promise<ProviderExecutionEvent[]> {
  const result: ProviderExecutionEvent[] = [];
  for await (const event of events) {
    result.push(event);
    observe?.(event);
  }
  return result;
}

function createImageRequest(): ProviderExecutionRequest {
  return createRequest(undefined, {
    input: [{
      type: 'image',
      image: {
        id: 'image-1', name: 'pasted.png', mediaType: 'image/png',
        data: 'aGVsbG8=', size: 5, source: 'paste',
      },
    }],
  });
}


function completeTurn(threadId: string, turnId: string): void {
  emitNotification('turn/completed', {
    threadId,
    turn: { id: turnId, items: [], status: 'completed', error: null },
  });
}

function configureNativeTurn(
  threadId: string,
  turnId: string,
  steer: () => unknown | Promise<unknown>,
): void {
  nativeRequest.mockImplementation(async (method: string) => {
    if (method === 'initialize') {
      return {
        userAgent: 'test',
        codexHome: '/tmp/.codex',
        platformFamily: 'unix',
        platformOs: 'macos',
      };
    }
    if (method === 'thread/start') return createThreadResult(threadId);
    if (method === 'turn/start') return createTurnResult(turnId);
    if (method === 'turn/steer') return steer();
    if (method === 'turn/interrupt') return {};
    throw new Error(`Unexpected method: ${method}`);
  });
}


/** A real response confirms that prior native notifications crossed the client transport. */
async function nativeRoundTrip(): Promise<void> {
  const lease = await runtimes.at(-1)!.acquire({ readiness: 'initialized' });
  try { await lease.connection.transport.request('model/list', {}); }
  finally { await lease.release(); }
}


describe('CodexExecutionBackend', () => {

  it('sends the configured workspace-write sandbox when a fork child ignores the resume mode', async () => {
    nativeRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') return {
        userAgent: 'test', codexHome: '/tmp/.codex', platformFamily: 'unix', platformOs: 'macos',
      };
      // thread/fork applies the config sandbox_mode, and resuming the loaded child keeps it.
      if (method === 'thread/fork' || method === 'thread/resume') return {
        ...createThreadResult('thread-fork-sandbox', [{ id: 'checkpoint' }]),
        sandbox: { type: 'dangerFullAccess' },
      };
      if (method === 'config/read') return {
        config: {
          sandbox_workspace_write: { writable_roots: ['/configured/root'], network_access: true },
        },
      };
      if (method === 'turn/start') {
        queueMicrotask(() => completeTurn('thread-fork-sandbox', 'turn-fork-sandbox'));
        return createTurnResult('turn-fork-sandbox');
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const session = createBackend(await createPlugin()).createSession(createForkSessionConfig());
    await collectEvents(session.execute(createRequest()).events);

    expect(nativeRequest).toHaveBeenCalledWith('thread/resume', expect.objectContaining({
      threadId: 'thread-fork-sandbox', sandbox: 'workspace-write',
    }));
    expect(nativeRequest).toHaveBeenCalledWith('turn/start', expect.objectContaining({
      sandboxPolicy: CONFIGURED_WORKSPACE_WRITE_SANDBOX,
    }));
    await session.dispose();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // These protocol fixtures describe a macOS host; WSL rows select Windows explicitly.
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'darwin' });
    mockProcessStart = vi.spyOn(CodexAppServerProcess.prototype, 'start');
    mockProcessShutdown = vi.spyOn(CodexAppServerProcess.prototype, 'shutdown');
    nativeUnsubscribe.mockReset().mockResolvedValue({ status: 'unsubscribed' });
    nativeRequest.mockReset();
    transportDispose = vi.spyOn(CodexRPCTransport.prototype, 'dispose');
    native.reset();
    native.autoReconcile = true;
    native.requestOverride = (process, request) => {
      if (request.method === 'plugin/reconcile' || request.method === 'model/list') return false;
      process.respondWhen(request.id, (async () => request.method === 'thread/unsubscribe'
        ? nativeUnsubscribe(request.params)
        : nativeRequest(request.method, request.params))());
      return true;
    };

  });

  it('keeps a denial consumed when the server receives the approval but its reply times out', async () => {
    vi.useFakeTimers();
    const reply = createDeferred<unknown>();
    configureNativeTurn('parent', 'turn', () => ({}));
    const base = nativeRequest.getMockImplementation()!;
    nativeRequest.mockImplementation((method, params) => {
      if (method === 'initialize') return { userAgent: 'claudian/0.171.0', platformFamily: 'unix', platformOs: 'macos' };
      if (method === 'thread/approveGuardianDeniedAction') return reply.promise;
      return base(method, params);
    });
    const session = createBackend(await createPlugin()).createSession(createSessionConfig());
    const output = collectEvents(session.execute(createRequest()).events);
    await native.waitForRequest('turn/start');
    emitNotification('item/autoApprovalReview/completed', {
      threadId: 'parent', turnId: 'turn', reviewId: 'denied', targetItemId: null, decisionSource: 'agent',
      review: { status: 'denied', rationale: 'Needs permission', riskLevel: 'high', userAuthorization: null },
      action: { type: 'command', command: 'npm install', source: 'shell', cwd: '/vault' },
    });
    await nativeRoundTrip();
    const [denial] = session.getReviewDenials!();
    const result = denial.approve().catch((error: Error) => error.message);
    await native.waitForRequest('thread/approveGuardianDeniedAction');
    await vi.advanceTimersByTimeAsync(30_000);
    reply.resolve({});
    await nativeRoundTrip();
    expect(session.getReviewDenials!()).toEqual([]);
    expect(await denial.approve()).toBe(false);
    expect(await result).toBe(t('chat.approval.review.retryUnconfirmed'));
    completeTurn('parent', 'turn');
    await output;
    await session.dispose();
  });

  it('submits an image with a filesystem-limit basename and cleans up its bytes', async () => {
    configureNativeTurn('thread-image', 'turn-image', () => ({}));
    const session = createBackend(await createPlugin()).createSession(createSessionConfig());
    const request = createImageRequest();
    const image = request.input.find(block => block.type === 'image')!;
    if (image.type !== 'image') throw new Error('Expected image request');
    image.image.name = `${'a'.repeat(251)}.png`;
    expect(Buffer.byteLength(image.image.name)).toBe(255);
    let filePath: string | undefined;
    try {
      const run = session.execute(request);
      const events = collectEvents(run.events);
      await native.waitForRequest('turn/start');
      const nativeInput = nativeRequest.mock.calls.find(([method]) => method === 'turn/start')?.[1].input;
      expect(nativeInput).toEqual([{ type: 'localImage', path: expect.any(String) }]);
      filePath = nativeImagePath(nativeInput);
      expect(Buffer.byteLength(basename(filePath!))).toBeLessThanOrEqual(255);
      expect(filePath).toMatch(/\.png$/);
      expect(readFileSync(filePath!)).toEqual(Buffer.from('hello'));
      completeTurn('thread-image', 'turn-image');
      expect((await events).at(-1)?.type).toBe('turn_completed');
      await nativeRoundTrip();
      expect(existsSync(dirname(filePath!))).toBe(false);
    } finally {
      await session.dispose();
    }
  });

  it('retries stale recovery reads and reconciles partial assistant text once', async () => {
    vi.useFakeTimers();
    const threadId = 'thread-recovery-retry';
    const turnId = 'turn-recovery-retry';
    let readAttempt = 0;
    const assistantItem = {
      type: 'agentMessage',
      id: 'assistant-recovery-retry',
      text: 'Recovered response.',
      phase: 'final',
      memoryCitation: null,
    };
    nativeRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: 'macos',
        };
      }
      if (method === 'thread/start') return createThreadResult(threadId);
      if (method === 'turn/start') return createTurnResult(turnId);
      if (method === 'thread/read') {
        readAttempt += 1;
        if (readAttempt === 1) return createThreadResult(threadId);
        if (readAttempt === 2) {
          return createThreadResult(threadId, [{
            id: turnId,
            items: [assistantItem],
            status: 'inProgress',
          }]);
        }
        return createThreadResult(threadId, [{
          id: turnId,
          items: [assistantItem],
        }]);
      }
      if (method === 'turn/interrupt') return {};
      throw new Error(`Unexpected method: ${method}`);
    });

    const session = createBackend(await createPlugin())
      .createSession(createSessionConfig());
    const run = session.execute(createRequest());
    const eventsPromise = collectEvents(run.events);

    try {
      await native.waitForRequest('turn/start');
      emitNotification('item/started', {
        threadId,
        turnId,
        item: assistantItem,
      });
      emitNotification('item/agentMessage/delta', {
        threadId,
        turnId,
        itemId: assistantItem.id,
        delta: 'Recovered ',
      });
      emitNotification('thread/status/changed', {
        threadId,
        status: { type: 'idle' },
      });
      await vi.advanceTimersByTimeAsync(10_000);

      const events = await eventsPromise;
      expect(readAttempt).toBe(3);
      expect(events
        .filter((event): event is Extract<ProviderExecutionEvent, { type: 'text_delta' }> => (
          event.type === 'text_delta'
        ))
        .map(event => event.text)
        .join('')).toBe('Recovered response.');
      expect(events.at(-1)).toMatchObject({
        nativeCheckpointId: turnId,
        type: 'turn_completed',
      });
    } finally {
      run.cancel();
      await eventsPromise;
      await session.dispose();
      vi.useRealTimers();
    }
  });

  it('encodes path-only Linked content without changing the Vault-root thread CWD', async () => {
    nativeRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: 'macos',
        };
      }
      if (method === 'thread/start') return createThreadResult('thread-linked-content');
      if (method === 'turn/start') {
        queueMicrotask(() => completeTurn('thread-linked-content', 'turn-linked-content'));
        return createTurnResult('turn-linked-content');
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const session = createBackend(await createPlugin())
      .createSession(createSessionConfig());

    await collectEvents(session.execute(createRequest(
      new AbortController().signal,
      {
        context: { ...capturedSelections, linkedContent: { path: 'Projects/Research' } },
        input: [{ type: 'text', text: 'Inspect linked content' }],
      },
    )).events);

    const threadStartParams = nativeRequest.mock.calls
      .find(([method]) => method === 'thread/start')?.[1] as { cwd: string };
    const turnStartParams = nativeRequest.mock.calls
      .find(([method]) => method === 'turn/start')?.[1] as {
        input: Array<{ text?: string; type: string }>;
      };
    expect(threadStartParams.cwd).toBe('/vault');
    expect(turnStartParams.input.find(block => block.type === 'text')?.text).toBe(
      'Inspect linked content\n\n<linked_content path="Projects/Research" />\n\n' + capturedSelectionPrompt,
    );

    await session.dispose();
  });
  it('persists native context when cancellation races a turn-start acknowledgement', async () => {
    const controller = new AbortController();
    let turnAttempt = 0;
    nativeRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: 'macos',
        };
      }
      if (method === 'thread/start') {
        return createThreadResult('thread-cancelled-ack');
      }
      if (method === 'thread/resume') {
        return createThreadResult('thread-cancelled-ack');
      }
      if (method === 'turn/start') {
        turnAttempt += 1;
        if (turnAttempt === 1) {
          controller.abort();
          return createTurnResult('turn-cancelled-ack');
        }
        queueMicrotask(() => completeTurn(
          'thread-cancelled-ack',
          'turn-after-cancelled-ack',
        ));
        return createTurnResult('turn-after-cancelled-ack');
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const session = createBackend(await createPlugin())
      .createSession(createSessionConfig());
    const conversationHistory = [
      { id: 'history-user', role: 'user' as const, content: 'cancel prior question', timestamp: 1 },
      { id: 'history-assistant', role: 'assistant' as const, content: 'cancel prior answer', timestamp: 2 },
    ];

    const sessionEvents: ProviderSessionEvent[] = [];
    session.onEvent(event => sessionEvents.push(event));
    const cancelledEvents = await collectEvents(session.execute(createRequest(
      controller.signal,
      { conversationHistory },
    )).events);
    await session.dispose();
    expect([...cancelledEvents, ...sessionEvents]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        snapshot: expect.objectContaining({
          providerState: expect.objectContaining({
            nativeConversationContextEstablished: true,
          }),
        }),
        type: 'session_state_changed',
      }),
    ]));
    const cancelledSnapshot = session.getSnapshot();
    expect(cancelledSnapshot.providerState).toEqual(expect.objectContaining({
      nativeConversationContextEstablished: true,
    }));
    await session.dispose();

    const replacement = createBackend(await createPlugin()).createSession(
      createSessionConfig({
        resumeSeed: {
          providerSessionId: cancelledSnapshot.providerSessionId,
          providerState: { ...cancelledSnapshot.providerState },
        },
      }),
    );
    await collectEvents(replacement.execute(createRequest(
      new AbortController().signal,
      { conversationHistory },
    )).events);

    const turnRequests = nativeRequest.mock.calls
      .filter(([method]) => method === 'turn/start')
      .map(([, params]) => JSON.stringify(params.input));
    expect(turnRequests).toHaveLength(2);
    expect(turnRequests[0]).toContain('cancel prior question');
    expect(turnRequests[1]).not.toContain('cancel prior question');

    await replacement.dispose();
  });

  it('forks, resumes, and reverts an adopted child to the requested checkpoint before executing', async () => {
    let turnAttempt = 0;
    nativeRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: 'macos',
        };
      }
      if (method === 'thread/fork') {
        return createThreadResult('thread-fork', [
          { id: 'checkpoint' },
          { id: 'later-turn' },
        ]);
      }
      if (method === 'thread/resume') {
        return createThreadResult('thread-fork', [
          { id: 'checkpoint' },
          { id: 'later-turn' },
        ]);
      }
      if (method === 'thread/revert') return createThreadResult('thread-fork');
      if (method === 'turn/start') {
        turnAttempt += 1;
        if (turnAttempt === 2) {
          native.processes.at(-1)!.exit();
          return new Promise(() => {});
        }
        const turnId = `turn-fork-${turnAttempt}`;
        queueMicrotask(() => completeTurn('thread-fork', turnId));
        return createTurnResult(turnId);
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const session = createBackend(await createPlugin()).createSession(
      createSessionConfig({
        resumeSeed: {
          providerState: {
            forkSourceSessionFilePath: '/tmp/source.jsonl',
            forkSourceTranscriptRootPath: '/tmp/sessions',
            forkSource: { sessionId: 'thread-source', resumeAt: 'checkpoint' },
            // An older missing-thread reset left the lost child's transcript; the fork re-materializes it.
            sessionFilePath: '/tmp/sessions/thread-lost-child.jsonl',
            unknownFutureState: { keep: true },
          },
        },
      }),
    );

    const forkEvents = await collectEvents(session.execute(createRequest()).events);

    expect(nativeRequest.mock.calls.map(call => call[0])).toEqual([
      'initialize',
      'thread/fork',
      'thread/resume',
      'thread/revert',
      'turn/start',
    ]);
    expect(nativeRequest).toHaveBeenCalledWith(
      'thread/revert',
      { threadId: 'thread-fork', beforeTurnId: 'later-turn' },
    );
    // The child inherits a source thread whose dependency-tool generation is unknown.
    expect(nativeRequest).toHaveBeenCalledWith('thread/resume', expect.objectContaining({
      threadId: 'thread-fork',
      experimentalRawEvents: true,
      baseInstructions: expect.stringContaining('predates BetterAgent client-hosted workspace dependency tools'),
    }));

    const forkedSnapshot = session.getSnapshot();
    expect(forkedSnapshot.providerState).toEqual(expect.objectContaining({
      threadId: 'thread-fork',
      unknownFutureState: { keep: true },
    }));
    expect(forkedSnapshot.providerState).not.toHaveProperty('forkSource');
    expect(forkedSnapshot.providerState).not.toHaveProperty('previousSegments');
    expect(forkedSnapshot.providerState).not.toHaveProperty('forkSourceSessionFilePath');
    expect(forkedSnapshot.providerState).not.toHaveProperty('forkSourceTranscriptRootPath');
    expect(forkedSnapshot.providerStateDeletes).toEqual([
      'forkSource',
      'forkSourceSessionFilePath',
      'forkSourceTranscriptRootPath',
      'pendingForkTarget',
    ]);
    expect(forkEvents.at(-2)).toMatchObject({
      snapshot: {
        providerStateDeletes: [
          'forkSource',
          'forkSourceSessionFilePath',
          'forkSourceTranscriptRootPath',
          'pendingForkTarget',
        ],
        status: 'idle',
      },
      type: 'session_state_changed',
    });

    const invalidatedEvents = await collectEvents(session.execute(createRequest()).events);
    expect(invalidatedEvents.at(-2)).toMatchObject({
      snapshot: {
        providerStateDeletes: [
          'forkSource',
          'forkSourceSessionFilePath',
          'forkSourceTranscriptRootPath',
          'pendingForkTarget',
        ],
        status: 'invalidated',
      },
      type: 'session_state_changed',
    });

    await collectEvents(session.execute(createRequest()).events);
    expect(nativeRequest.mock.calls.filter(call => call[0] === 'thread/fork'))
      .toHaveLength(1);
    expect(session.getSnapshot()).toMatchObject({
      providerState: {
        threadId: 'thread-fork',
        unknownFutureState: { keep: true },
      },
      providerStateDeletes: [
        'forkSource',
        'forkSourceSessionFilePath',
        'forkSourceTranscriptRootPath',
        'pendingForkTarget',
      ],
      status: 'idle',
    });

    await session.dispose();
  });

  it('quarantines a cancelled turn before its start response and fences its late events from retry', async () => {
    const firstTurnStart = createDeferred<ReturnType<typeof createTurnResult>>();
    const secondTurnStart = createDeferred<ReturnType<typeof createTurnResult>>();
    let initializeCount = 0;
    let turnStartCount = 0;
    nativeRequest.mockImplementation(async (method: string) => {
      if (method === 'initialize') {
        initializeCount += 1;
        return {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: 'macos',
        };
      }
      if (method === 'thread/start') return createThreadResult('thread-cancel-race');
      if (method === 'thread/resume') return createThreadResult('thread-cancel-race');
      if (method === 'turn/start') {
        turnStartCount += 1;
        return turnStartCount === 1
          ? firstTurnStart.promise
          : secondTurnStart.promise;
      }
      if (method === 'turn/interrupt') return {};
      throw new Error(`Unexpected method: ${method}`);
    });
    const session = createBackend(await createPlugin())
      .createSession(createSessionConfig());
    const firstRun = session.execute(createRequest());
    await native.waitForRequest('turn/start');
    const oldProcess = native.processes.at(-1)!;
    const oldTurnStarted = (params: unknown) => oldProcess.notify('turn/started', params);
    const oldTextDelta = (params: unknown) => oldProcess.notify('item/agentMessage/delta', params);

    firstRun.cancel();

    const firstEvents = await collectEvents(firstRun.events);
    expect(firstEvents.at(-1)?.type).toBe('cancelled');
    expect(transportDispose).not.toHaveBeenCalled();
    expect(mockProcessShutdown).not.toHaveBeenCalled();

    const secondRun = session.execute(createRequest());
    await nativeRoundTrip();
    expect(turnStartCount).toBe(1);
    oldTurnStarted({
      threadId: 'thread-cancel-race',
      turn: createTurnResult('turn-old').turn,
    });
    oldTextDelta({
      threadId: 'thread-cancel-race',
      turnId: 'turn-old',
      itemId: 'assistant-old',
      delta: 'late old output',
    });
    firstTurnStart.resolve(createTurnResult('turn-old'));
    await native.waitForRequest('turn/start', 0, 2);
    oldTurnStarted({ threadId: 'thread-cancel-race', turn: createTurnResult('turn-old').turn });
    oldTextDelta({ threadId: 'thread-cancel-race', turnId: 'turn-old', itemId: 'assistant-old', delta: 'late old output' });
    secondTurnStart.resolve(createTurnResult('turn-new'));
    await nativeRoundTrip();
    expect(initializeCount).toBe(1);
    completeTurn('thread-cancel-race', 'turn-new');

    const secondEvents = await collectEvents(secondRun.events);
    expect(secondEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        accepted: true,
        nativeTurnId: 'turn-new',
        type: 'turn_started',
      }),
      expect.objectContaining({ type: 'turn_completed' }),
    ]));
    expect(secondEvents).not.toContainEqual(expect.objectContaining({ nativeTurnId: 'turn-old' }));
    expect(secondEvents).not.toContainEqual(expect.objectContaining({ text: 'late old output' }));
    expect(mockProcessStart).toHaveBeenCalledTimes(1);

    await session.dispose();
  });
});

vi.mock('node:fs', async () => ({ ...await vi.importActual<typeof import('node:fs')>('node:fs') }));

vi.mock('node:fs/promises', async () => ({ ...await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises') }));

let sharedVault: DesktopVault;
beforeAll(async () => { sharedVault = await DesktopVault.create(); });
afterAll(async () => { await sharedVault.dispose(); });
