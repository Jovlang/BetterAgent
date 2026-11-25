import type { SideChatSubmission } from '@/features/chat/side-chat/SideChatRuntime';

/** A command reserves its queue position while its detached input is prepared. */
export class SideChatCommandSubmission {
  readonly settled: Promise<SideChatSubmission | null>;
  readonly #controller = new AbortController();
  #released = false;

  constructor(
    submission: SideChatSubmission,
    private readonly restore: (error?: unknown) => void,
  ) {
    this.settled = Promise.resolve(structuredClone(submission));
  }

  accept(): boolean {
    if (this.#released || this.#controller.signal.aborted) return false;
    this.#released = true;
    return true;
  }

  cancel(): void {
    this.#controller.abort();
    this.#restore();
  }

  #restore(error?: unknown): void {
    if (this.#released) return;
    this.#released = true;
    this.restore(error);
  }
}
