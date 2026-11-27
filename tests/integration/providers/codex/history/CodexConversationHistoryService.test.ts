
import { testDate } from '@test/helpers/testClock';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { MockInstance } from 'vitest';

import { encodeRecoveryPrompt } from '@/core/prompt/recoveryPrompt';
import type { ChatMessage, Conversation } from '@/core/types';
import { CodexConversationHistoryService } from '@/providers/codex/history/CodexConversationHistoryService';
import { findCodexSessionFileAsync, parseCodexSessionTurns, readCodexSessionRecords } from '@/providers/codex/history/CodexHistoryStore';
import { type CodexPreviousSegment } from '@/providers/codex/types';


describe('CodexConversationHistoryService', () => {
  let homeDirSpy: MockInstance<(...args: []) => string>;
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claudian-codex-home-'));
    homeDirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tempHome);
  });

  afterEach(() => {
    homeDirSpy.mockRestore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('hydrates a direct session file under the default root and skips only malformed JSONL lines', async () => {
    const root = path.join(tempHome, '.codex', 'sessions');
    fs.mkdirSync(root, { recursive: true });
    const file = path.join(root, 'thread.jsonl');
    fs.writeFileSync(file, '');
    expect(await readCodexSessionRecords(file)).toEqual([]);
    const records = [
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Recovered answer' }] } },
    ].map((record, seconds) => JSON.stringify({ timestamp: testDate({ seconds }).toISOString(), ...record }));
    const content = [records[0], '{"type":"response_item","payload":', records[1]].join('\n');
    fs.writeFileSync(file, content);
    const fromString = parseCodexSessionTurns(content).flatMap(turn => turn.messages);
    const result = await new CodexConversationHistoryService().hydrateConversationHistory({
      sessionId: 'thread', providerState: { threadId: 'thread' }, messages: [],
    }, null);
    expect(result.messages).toEqual(fromString);
    expect(result.messages?.map(message => [message.role, message.content])).toEqual([
      ['user', 'Continue'], ['assistant', 'Recovered answer'],
    ]);
    expect(result.providerState).toMatchObject({ sessionFilePath: file });
    expect(await findCodexSessionFileAsync('thread')).toBe(file);
  });

  it('preserves visible history around native file-backed image references', async () => {
    const root = path.join(tempHome, '.codex', 'sessions');
    fs.mkdirSync(root, { recursive: true });
    const file = path.join(root, 'image-thread.jsonl');
    // Codex 0.166 uploads prepared images and persists file_id instead of image_url.
    const records = [
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'image-turn' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [
        { type: 'input_text', text: 'Describe this image.' }, { type: 'input_image', file_id: 'file-placeholder' },
      ] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Visible answer.' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_image', file_id: 'file-steering-placeholder' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Continuation.' }] } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'image-turn' } },
    ];
    fs.writeFileSync(file, records.map((record, seconds) => JSON.stringify({ timestamp: testDate({ seconds }).toISOString(), ...record })).join('\n'));
    const result = await new CodexConversationHistoryService().hydrateConversationHistory({
      sessionId: 'image-thread', providerState: { threadId: 'image-thread', sessionFilePath: file }, messages: [],
    }, null);
    expect(result.messages?.map(message => [message.role, message.content])).toEqual([
      ['user', 'Describe this image.'], ['assistant', 'Visible answer.\n\nContinuation.'],
    ]);
    expect(result.messages?.flatMap(message => message.images ?? [])).toEqual([]);
  });

  it('hydrates every attempt of a recovered fork checkpoint and excludes later turns', async () => {
    const root = path.join(tempHome, '.codex', 'sessions');
    fs.mkdirSync(root, { recursive: true });
    const file = path.join(root, 'recovered-thread.jsonl');
    // recover_turn_if_idle restarts sampling with the already persisted turn ID.
    const records = [
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'recovered-turn' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Finish this task.' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Before suspension.' }] } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'recovered-turn' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Recovered answer.' }] } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'recovered-turn' } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'later-turn' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Later question.' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Later answer.' }] } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'later-turn' } },
    ];
    fs.writeFileSync(file, records.map((record, seconds) => JSON.stringify({ timestamp: testDate({ seconds }).toISOString(), ...record })).join('\n'));
    const result = await new CodexConversationHistoryService().hydrateConversationHistory({
      sessionId: null, messages: [], providerState: {
        forkSource: { sessionId: 'recovered-thread', resumeAt: 'recovered-turn' },
        forkSourceSessionFilePath: file, forkSourceTranscriptRootPath: root,
      },
    }, null);
    expect(result.messages?.map(message => message.content)).toEqual([
      'Finish this task.', 'Before suspension.', 'Recovered answer.',
    ]);
  });

  it('hydrates history by resolving the transcript path from thread id', async () => {
    const threadId = 'thread-123';
    const sessionsDir = path.join(tempHome, '.codex', 'sessions', '2026', '03', '27');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const transcriptPath = path.join(
      sessionsDir,
      `rollout-2026-03-27T00-00-00-${threadId}.jsonl`,
    );

    fs.writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Summarize this file.' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Here is the summary.' }],
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const conversation: Conversation = {
      id: 'conv-1',
      providerId: 'codex',
      title: 'Codex Transcript',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      sessionId: threadId,
      providerState: { threadId },
      messages: [],
    };

    const service = new CodexConversationHistoryService();
    conversation.messages = [{ id: 'local', role: 'assistant', content: 'Local placeholder', timestamp: testDate().getTime() }];
    const before = structuredClone(conversation);
    const first = await service.hydrateConversationHistory(conversation, null);
    expect(conversation).toEqual(before);
    expect(await service.hydrateConversationHistory(conversation, null)).toEqual(first);
    Object.assign(conversation, first);

    expect(conversation.messages).toHaveLength(2);
    expect(conversation.messages[0]).toMatchObject({
      role: 'user',
      content: 'Summarize this file.',
    });
    expect(conversation.messages[1]).toMatchObject({
      role: 'assistant',
      content: 'Here is the summary.',
    });
    expect((conversation.providerState as Record<string, unknown>).sessionFilePath).toBe(transcriptPath);
  });

  it('does not recover an established fork model past a missing source checkpoint', async () => {
    const sourcePath = path.join(tempHome, 'fork-source-model.jsonl');
    const forkPath = path.join(tempHome, 'established-fork-model.jsonl');
    fs.writeFileSync(
      sourcePath,
      JSON.stringify({
        type: 'turn_context',
        payload: { model: 'gpt-5.4-mini', turn_id: 'source-turn-1' },
      }),
      'utf8',
    );
    fs.writeFileSync(
      forkPath,
      JSON.stringify({
        type: 'turn_context',
        payload: { model: 'gpt-5.5', turn_id: 'fork-turn-1' },
      }),
      'utf8',
    );
    const conversation: Conversation = {
      id: 'established-fork-stale-source-checkpoint',
      providerId: 'codex',
      title: 'Established fork stale source checkpoint',
      createdAt: 1,
      lastActivityAt: 2,
      sessionId: 'fork-thread',
      providerState: {
        threadId: 'fork-thread',
        sessionFilePath: forkPath,
        forkSource: {
          sessionId: 'source-thread',
          resumeAt: 'missing-source-turn',
        },
        forkSourceSessionFilePath: sourcePath,
      },
      messages: [],
    };

    await expect(new CodexConversationHistoryService()
      .recoverConversationModelSelection(conversation, null))
      .resolves.toBeNull();
  });

  it('recovers a model after Codex moves the transcript into archived_sessions', async () => {
    const threadId = 'thread-archived-model';
    const codexDir = path.join(tempHome, '.codex');
    const sessionsDir = path.join(codexDir, 'sessions');
    const archivedDir = path.join(codexDir, 'archived_sessions');
    const stalePath = path.join(sessionsDir, `rollout-stale-${threadId}.jsonl`);
    const archivedPath = path.join(
      archivedDir,
      `rollout-2026-08-05T00-00-00-${threadId}.jsonl`,
    );
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(archivedDir, { recursive: true });
    fs.writeFileSync(
      archivedPath,
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5' } }),
      'utf8',
    );
    const conversation: Conversation = {
      id: 'archived-model',
      providerId: 'codex',
      title: 'Archived model',
      createdAt: 1,
      lastActivityAt: 2,
      sessionId: threadId,
      providerState: {
        sessionFilePath: stalePath,
        threadId,
        transcriptRootPath: sessionsDir,
      },
      messages: [],
    };

    await expect(new CodexConversationHistoryService()
      .recoverConversationModelSelection(conversation, null))
      .resolves.toBe('openai-codex/gpt-5.5');
  });

  it('does not open an out-of-root metadata path and re-resolves by thread id', async () => {
    const threadId = 'thread-untrusted-path';
    const trustedDir = path.join(tempHome, '.codex', 'sessions', '2026', '07', '11');
    const outsideDir = path.join(tempHome, 'synced-other-device');
    fs.mkdirSync(trustedDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    const trustedPath = path.join(trustedDir, `rollout-${threadId}.jsonl`);
    const outsidePath = path.join(outsideDir, `rollout-${threadId}.jsonl`);
    fs.writeFileSync(trustedPath, JSON.stringify({
      timestamp: '2026-07-11T00:00:00.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Trusted transcript.' }],
      },
    }));
    fs.writeFileSync(outsidePath, JSON.stringify({
      timestamp: '2026-07-11T00:00:00.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Untrusted transcript.' }],
      },
    }));
    const conversation: Conversation = {
      id: 'conv-untrusted-path',
      providerId: 'codex',
      title: 'Synced metadata path',
      createdAt: 1,
      lastActivityAt: 1,
      sessionId: threadId,
      providerState: { threadId, sessionFilePath: outsidePath },
      messages: [],
    };

    Object.assign(conversation, await new CodexConversationHistoryService().hydrateConversationHistory(
      conversation,
      null,
      { config: {}, environment: { HOME: tempHome }, environmentText: '' },
    ));

    expect(conversation.messages.map(message => message.content)).toEqual(['Trusted transcript.']);
    expect((conversation.providerState as Record<string, unknown>).sessionFilePath).toBe(trustedPath);
  });

  describe('buildForkProviderState', () => {
    let transcriptPath: string;
    let transcript: string;

    beforeEach(() => {
      const sessionsDir = path.join(tempHome, '.codex', 'sessions');
      fs.mkdirSync(sessionsDir, { recursive: true });
      transcriptPath = path.join(sessionsDir, 'rollout-source-thread-id.jsonl');
      transcript = [
        { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-uuid-2' } },
        { type: 'response_item', payload: {
          type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello' }],
        } },
        { type: 'response_item', payload: {
          type: 'message', role: 'assistant', id: 'msg_item',
          content: [{ type: 'output_text', text: 'Hi' }],
        } },
        { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-uuid-2' } },
      ].map(record => JSON.stringify(record)).join('\n');
      fs.writeFileSync(transcriptPath, transcript);
    });

    it('validates the native checkpoint and preserves source context for hydration', async () => {
      const service = new CodexConversationHistoryService();
      const state = await service.buildForkProviderState('source-thread-id', 'turn-uuid-2', {
        sessionFilePath: transcriptPath, workspaceDependencyToolVersion: 1,
      });
      expect(state).toMatchObject({ workspaceDependencyToolVersion: 1 });
      const fork: Conversation = {
        id: 'fork', providerId: 'codex', title: 'Fork', createdAt: 1, lastActivityAt: 1,
        sessionId: null, messages: [], providerState: state,
      };
      Object.assign(fork, await service.hydrateConversationHistory(fork, null));
      expect(fork.messages.map(message => message.content)).toEqual(['Hello', 'Hi']);
      expect(fs.readFileSync(transcriptPath, 'utf8')).toBe(transcript);
    });

    it.each(['msg_item', 'missing-turn'])('rejects unavailable checkpoint %s during fork creation', async checkpoint => {
      const service = new CodexConversationHistoryService();
      await expect(service.buildForkProviderState(
        'source-thread-id', checkpoint, { sessionFilePath: transcriptPath },
      )).rejects.toThrow('Fork checkpoint not found');
    });
  });

  describe('history-only previous segments', () => {
    type Turn = [turnId: string, question: string, answer: string];
    let sessionsDir: string;

    function writeRollout(threadId: string, turns: Turn[], firstPrompt?: string): string {
      const filePath = path.join(sessionsDir, `rollout-2026-03-27T00-00-00-${threadId}.jsonl`);
      let seconds = 0;
      const record = (type: string, payload: Record<string, unknown>) => JSON.stringify({
        timestamp: testDate({ seconds: seconds++ }).toISOString(), type, payload,
      });
      fs.writeFileSync(filePath, [
        record('session_meta', { id: threadId }),
        ...turns.flatMap(([turnId, question, answer], index) => [
          record('event_msg', { type: 'task_started', turn_id: turnId }),
          record('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: index === 0 && firstPrompt ? firstPrompt : question }] }),
          record('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: answer }] }),
          record('event_msg', { type: 'task_complete', turn_id: turnId }),
        ]),
      ].join('\n'));
      return filePath;
    }

    function codexConversation(sessionId: string | null, providerState: Record<string, unknown>): Conversation {
      return {
        id: 'conv-previous-segments', providerId: 'codex', title: 'Previous segments',
        createdAt: testDate().getTime(), lastActivityAt: testDate().getTime(),
        sessionId, providerState, messages: [],
      };
    }

    /** Earlier versions moved retired bindings into history-only `previousSegments`. */
    function withPreviousSegments(
      segments: CodexPreviousSegment[],
      live: Record<string, unknown> = {},
    ): Record<string, unknown> {
      return { nativeConversationContextEstablished: false, ...live, previousSegments: segments };
    }

    async function hydrate(conversation: Conversation): Promise<ChatMessage[]> {
      const update = await new CodexConversationHistoryService()
        .hydrateConversationHistory({ ...conversation, messages: [] }, null);
      return update.messages ?? [];
    }

    const visible = (messages: ChatMessage[]) => messages.map(message => [message.role, message.content]);

    beforeEach(() => {
      sessionsDir = path.join(tempHome, '.codex', 'sessions', '2026', '03', '27');
      fs.mkdirSync(sessionsDir, { recursive: true });
    });

    it.each(['live', 'previous'])('never shows a %s fork child whole when its source rollout is gone', async mode => {
      const sourcePath = writeRollout('source', [['s1', 'SrcQ1', 'SrcA1'], ['s2', 'SrcQ2', 'SrcA2']]);
      // The child rollout repeats the source turns, including the one after the checkpoint.
      const childPath = writeRollout('fork', [['s1', 'SrcQ1', 'SrcA1'], ['s2', 'SrcQ2', 'SrcA2'], ['f1', 'ForkQ', 'ForkA']]);
      const binding = {
        forkSource: { sessionId: 'source', resumeAt: 's1' },
        forkSourceSessionFilePath: sourcePath,
        threadId: 'fork',
        sessionFilePath: childPath,
      };
      const conversation = mode === 'live'
        ? codexConversation('fork', binding)
        : codexConversation(null, withPreviousSegments([binding]));
      expect(visible(await hydrate(conversation))).toEqual([
        ['user', 'SrcQ1'], ['assistant', 'SrcA1'], ['user', 'ForkQ'], ['assistant', 'ForkA'],
      ]);

      fs.unlinkSync(sourcePath);

      expect(visible(await hydrate(conversation))).toEqual([]);
    });

    it('hydrates earlier segments before a replacement thread that replayed them', async () => {
      const firstPath = writeRollout('thread-first', [['t1', 'FirstQ', 'FirstA']]);
      const replay = encodeRecoveryPrompt('User: FirstQ\n\nAssistant: FirstA', 'SecondQ');
      const secondPath = writeRollout('thread-second', [['t2', 'SecondQ', 'SecondA']], replay);
      const first = { threadId: 'thread-first', sessionFilePath: firstPath };
      const second = { threadId: 'thread-second', sessionFilePath: secondPath };
      const expected = [['user', 'FirstQ'], ['assistant', 'FirstA'], ['user', 'SecondQ'], ['assistant', 'SecondA']];

      // The replacement thread is live.
      const live = codexConversation('thread-second', withPreviousSegments([first], {
        ...second, nativeConversationContextEstablished: true,
      }));
      const messages = await hydrate(live);
      expect(visible(messages)).toEqual(expected);
      expect(new Set(messages.map(message => message.id)).size).toBe(messages.length);

      // Both threads are history-only, oldest first.
      expect(visible(await hydrate(codexConversation(null, withPreviousSegments([first, second]))))).toEqual(expected);
    });

    it('offers fork and rewind checkpoints only on the live thread', async () => {
      const oldPath = writeRollout('thread-earlier', [['old-turn', 'OldQ', 'OldA']]);
      const livePath = writeRollout('thread-live', [['live-turn', 'LiveQ', 'LiveA']]);
      const conversation = codexConversation(null, withPreviousSegments(
        [{ threadId: 'thread-earlier', sessionFilePath: oldPath }],
        { threadId: 'thread-live', sessionFilePath: livePath },
      ));

      const messages = await hydrate(conversation);

      expect(messages.map(message => [message.content, message.userMessageId, message.assistantMessageId])).toEqual([
        ['OldQ', undefined, undefined],
        ['OldA', undefined, undefined],
        ['LiveQ', 'live-turn', undefined],
        ['LiveA', undefined, 'live-turn'],
      ]);
    });
  });

  describe('established-fork hydration', () => {
    it('hydrates as source prefix through resumeAt plus fork-only turns', async () => {
      const sourceThreadId = 'source-thread-ef';
      const forkThreadId = 'fork-thread-ef';
      const sessionsDir = path.join(tempHome, '.codex', 'sessions', '2026', '03', '27');
      fs.mkdirSync(sessionsDir, { recursive: true });

      // Source transcript: 3 turns
      fs.writeFileSync(
        path.join(sessionsDir, `rollout-2026-03-27T00-00-00-${sourceThreadId}.jsonl`),
        [
          JSON.stringify({ timestamp: '2026-03-27T00:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'src-turn-1' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:00.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'SrcQ1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SrcA1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:02.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'src-turn-1' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:03.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'src-turn-2' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:03.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'SrcQ2' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:04.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SrcA2' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:05.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'src-turn-2' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:06.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'src-turn-3' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:06.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'SrcQ3' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:07.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SrcA3' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:08.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'src-turn-3' } }),
        ].join('\n'),
        'utf-8',
      );

      // Fork transcript: copied turns 1-3 + new fork turn
      fs.writeFileSync(
        path.join(sessionsDir, `rollout-2026-03-27T00-00-00-${forkThreadId}.jsonl`),
        [
          // Copied source turns (have same turn IDs)
          JSON.stringify({ timestamp: '2026-03-27T00:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'src-turn-1' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:00.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'SrcQ1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SrcA1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:02.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'src-turn-1' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:03.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'src-turn-2' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:03.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'SrcQ2' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:04.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SrcA2' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:05.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'src-turn-2' } }),
          // New fork-only turn
          JSON.stringify({ timestamp: '2026-03-27T01:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'fork-turn-1' } }),
          JSON.stringify({ timestamp: '2026-03-27T01:00:00.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ForkQ1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T01:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ForkA1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T01:00:02.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'fork-turn-1' } }),
        ].join('\n'),
        'utf-8',
      );

      const conversation: Conversation = {
        id: 'conv-ef',
        providerId: 'codex',
        title: 'Established Fork',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        sessionId: null,
        providerState: {
          threadId: forkThreadId,
          sessionFilePath: path.join(sessionsDir, `rollout-2026-03-27T00-00-00-${forkThreadId}.jsonl`),
          forkSource: { sessionId: sourceThreadId, resumeAt: 'src-turn-2' },
        },
        messages: [],
      };

      const service = new CodexConversationHistoryService();
      const parse = vi.spyOn(JSON, 'parse');
      let sourceRecordReads: number;
      try {
        Object.assign(conversation, await service.hydrateConversationHistory(conversation, null));
        sourceRecordReads = parse.mock.calls.filter(([line]) => typeof line === 'string' && line.includes('SrcQ3')).length;
      } finally { parse.mockRestore(); }
      expect(sourceRecordReads).toBe(1);

      // Expected: source prefix (turns 1+2) + fork-only turn
      // = SrcQ1, SrcA1, SrcQ2, SrcA2, ForkQ1, ForkA1
      expect(conversation.messages).toHaveLength(6);
      expect(conversation.messages[0].content).toBe('SrcQ1');
      expect(conversation.messages[1].content).toBe('SrcA1');
      expect(conversation.messages[2].content).toBe('SrcQ2');
      expect(conversation.messages[3].content).toBe('SrcA2');
      expect(conversation.messages[4].content).toBe('ForkQ1');
      expect(conversation.messages[5].content).toBe('ForkA1');
    });
  });
});


vi.mock('os', async () => ({ ...await vi.importActual('os') }));

vi.mock('fs', async () => ({ ...await vi.importActual<typeof import('fs')>('fs') }));
vi.mock('node:fs/promises', async () => ({ ...await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises') }));
