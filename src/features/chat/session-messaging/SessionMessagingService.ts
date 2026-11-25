
import type { SessionToolSendMode, SessionToolSendStatus, SessionToolSessionStatus, SessionToolSessionSummary } from '@/core/session-tools/sessionToolSpecs';
import type { AskUserAnswers, ChatMessage, Conversation, ConversationMeta } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import type { PendingInteractionSnapshot } from '@/features/chat/interactions/SessionInteractions';
import { formatLastReply } from '@/features/chat/session-messaging/formatSessionSnapshot';
import type { ChatSessionRuntime } from '@/features/chat/sessions/ChatSessionRuntime';
import { throwIfAborted } from '@/utils/abort';

export interface ClientSendOptions {
  /** Required unless `mode` is `interrupt`, which without text only stops the session. */
  readonly text?: string;
  readonly mode?: 'queue' | SessionToolSendMode;
}

/** A listed session for outside clients. */
export type ClientSessionSummary = Omit<SessionToolSessionSummary, 'self'>;

export interface ClientSessionList {
  readonly sessions: readonly ClientSessionSummary[];
  readonly truncated?: true;
}

const CLIENT_LIST_LIMIT_DEFAULT = 50;
const CLIENT_LIST_LIMIT_MAX = 200;

/** Owns the public Obsidian plugin API operations; recipient execution belongs to its session runtime. */
export class SessionMessagingService {
  private readonly shutdown = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly deps: {
    getHost(): ChatFeatureHost;
    getActiveConversationId(): string | null;
  }) {}

  getActiveSessionId(): string | null { return this.deps.getActiveConversationId(); }

  /** An outside client's send: plain user input, or a stop when an interrupt has no text. */
  sendAsUser(sessionId: string, options: ClientSendOptions): Promise<SessionToolSendStatus> {
    const { text, mode = 'queue' } = options;
    if (text === undefined ? mode !== 'interrupt' : typeof text !== 'string' || !text.trim()) {
      return Promise.reject(new Error('"text" is required unless mode is "interrupt"'));
    }
    return this.track(this.shutdown.signal, async signal => {
      const host = this.deps.getHost();
      if (!host.sessionRuntimes.get(sessionId)) await host.sessionRuntimes.awaitConversationCreations();
      const target = await this.resolve(sessionId, signal);
      const mailbox = (await this.ensureRecipient(target, signal)).mailbox;
      if (!mailbox) throw new Error('The target session cannot receive messages');
      return mailbox.deliver({ message: text === undefined ? null : { text }, ...(mode === 'queue' ? {} : { mode }), signal });
    });
  }

  /** Sessions most recently active first, omitting archived sessions. */
  listSessions(options: { limit?: number } = {}): Promise<ClientSessionList> {
    const limit = options.limit ?? CLIENT_LIST_LIMIT_DEFAULT;
    if (!Number.isInteger(limit) || limit < 1 || limit > CLIENT_LIST_LIMIT_MAX) {
      return Promise.reject(new Error(`"limit" must be an integer from 1 to ${CLIENT_LIST_LIMIT_MAX}.`));
    }
    return this.track(this.shutdown.signal, async () => {
      const { records, truncated } = this.recentSessions(this.deps.getHost().getConversationList(), limit);
      return { sessions: records.map(record => this.summarize(record)), ...(truncated ? { truncated } : {}) };
    });
  }

  /** Rejects when the session does not exist or is archived. */
  requireSession(sessionId: string): Promise<void> {
    return this.track(this.shutdown.signal, async signal => { await this.resolve(sessionId, signal); });
  }

  /** Requests awaiting the user in the session's main transcript; empty when none or not loaded. */
  getPendingInteractions(sessionId: string): PendingInteractionSnapshot[] {
    return this.liveModel(sessionId)?.inlinePrompts.listPending() ?? [];
  }

  answerInteraction(sessionId: string, interactionId: string, answers: AskUserAnswers): Promise<void> {
    const model = this.liveModel(sessionId);
    if (!model) return Promise.reject(new Error(`Interaction "${interactionId}" is not awaiting an answer`));
    return model.inlinePrompts.answer(interactionId, answers);
  }

  private liveModel(sessionId: string) {
    const runtime = this.deps.getHost().sessionRuntimes.get(sessionId);
    return runtime?.conversationId === sessionId ? runtime.peekModel : null;
  }

  /** The last finished turn's final reply as Markdown; empty when none has finished. */
  readLastReply(sessionId: string): Promise<string> {
    return this.track(this.shutdown.signal, async signal => {
      const transcript = await this.loadTranscript(sessionId, signal);
      return formatLastReply(transcript.messages, transcript.running);
    });
  }

  private track<T>(signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const combined = AbortSignal.any([signal, this.shutdown.signal]);
    const pending = Promise.resolve().then(() => {
      throwIfAborted(combined, 'Session API call was cancelled');
      return operation(combined);
    });
    this.pending.add(pending);
    void pending.finally(() => this.pending.delete(pending)).catch(() => undefined);
    return pending;
  }

  beginShutdown(): void { this.shutdown.abort(new Error('Session messaging is shutting down')); }

  async dispose(): Promise<void> {
    this.beginShutdown();
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  private async resolve(id: string, signal: AbortSignal): Promise<ConversationMeta> {
    const host = this.deps.getHost();
    await host.ensureConversationMetadataLoaded([id]);
    throwIfAborted(signal, 'Session tool call was cancelled');
    const record = host.getConversationList().find(candidate => candidate.id === id && !candidate.isArchived);
    if (!record) throw new Error('The session does not exist or is archived');
    return record;
  }

  private async loadTranscript(id: string, signal: AbortSignal): Promise<{
    conversation: Conversation; messages: readonly ChatMessage[]; running: boolean;
  }> {
    const host = this.deps.getHost();
    // Ids can come from earlier messages, before the deferred metadata scan admits them.
    await host.ensureConversationMetadataLoaded([id]);
    throwIfAborted(signal, 'Session tool call was cancelled');
    const conversation = await host.getConversationById(id);
    throwIfAborted(signal, 'Session tool call was cancelled');
    if (!conversation) throw new Error('The session does not exist');
    // A hydrated runtime holds turns storage may not have yet, including headless sessions.
    const runtime = host.sessionRuntimes.get(conversation.id);
    const model = runtime?.conversationId === conversation.id ? runtime.peekModel : null;
    const live = model?.hydrationState === 'ready' ? model.state : null;
    if (!model || !live) return { conversation, messages: conversation.messages, running: false };
    // The running turn's boundary also covers prompts steered into it; null until its submission is placed.
    const end = model.inputController.settledTranscriptEnd(live.messages);
    return end === null
      ? { conversation, messages: live.messages, running: live.isStreaming }
      : { conversation, messages: live.messages.slice(0, end), running: false };
  }

  private recentSessions(candidates: readonly ConversationMeta[], limit: number): { records: ConversationMeta[]; truncated?: true } {
    const records = candidates.filter(record => !record.isArchived).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    return { records: records.slice(0, limit), ...(records.length > limit ? { truncated: true as const } : {}) };
  }

  private summarize(record: ConversationMeta): ClientSessionSummary {
    return {
      sessionId: record.id,
      title: record.title,
      provider: record.providerId,
      status: this.status(record.id),
      active: record.id === this.deps.getActiveConversationId(),
    };
  }

  private status(id: string): SessionToolSessionStatus {
    const runtime = this.deps.getHost().sessionRuntimes.get(id);
    return runtime?.statusAttention?.kind === 'action-required' ? 'awaiting-user'
      : runtime?.isWorking ? 'running' : 'idle';
  }

  private async ensureRecipient(target: ConversationMeta, signal: AbortSignal): Promise<ChatSessionRuntime> {
    const { sessionRuntimes } = this.deps.getHost();
    // Check while the recipient is still idle, before the mailbox admits pending work. A recipient open in a
    // tab, even a hidden one, keeps its model: a changed history is loaded again in place before delivery,
    // and messages arriving meanwhile join that refresh.
    const revalidation = sessionRuntimes.revalidate(target.id, sessionRuntimes.getAttachment(target.id) ?? undefined);
    if (revalidation) await revalidation;
    throwIfAborted(signal, 'Session tool call was cancelled');
    return sessionRuntimes.ensure({ conversationId: target.id, providerId: target.providerId, draftModel: null });
  }
}
