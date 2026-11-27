/** @vitest-environment jsdom */
import { StateEffect } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { axe } from '@test/helpers/accessibility';
import {
  createInlineEditHarness as createHarness,
  disposeInlineEditHarnesses,
  instructionInput as input,
  showReplacementPreview,
  submitInstruction,
} from '@test/helpers/features/inline-edit/InlineEditDOMHarness';
import { fireEvent, screen, waitFor, within } from '@testing-library/dom';
import { MarkdownRenderer } from 'obsidian';


afterEach(async () => {
  await disposeInlineEditHarnesses();
  vi.clearAllMocks();
});

it('settles inline editing and releases provider work when its editor is destroyed', async () => {
  const h = await createHarness();
  const on = vi.spyOn(h.app.vault, 'on');
  const offref = vi.spyOn(h.app.vault, 'offref');
  h.createSession().show();
  expect(on).toHaveBeenCalledTimes(4);
  const refs = on.mock.results.map(result => result.value);
  submitInstruction();
  await waitFor(() => expect(h.backend.sessions[0]?.getStatus()).toBe('executing'));
  h.editorView.destroy();
  expect(offref.mock.calls).toEqual(refs.map(ref => [ref]));
  expect(h.backend.sessions[0].getStatus()).toBe('disposed');
  expect(h.settled.mock.calls).toEqual([[{ decision: 'reject' }]]);
});

it('retains clarification when CodeMirror releases and later recreates the input widget', async () => {
  const h = await createHarness();
  const session = h.createSession();
  vi.mocked(MarkdownRenderer.render).mockImplementation(async (_app, markdown, element) => {
    (element as HTMLElement).textContent = markdown;
  });
  session.show();
  submitInstruction();
  await waitFor(() => expect(h.backend.sessions[0]?.getStatus()).toBe('executing'));
  // WidgetType.destroy/toDOM are CodeMirror's viewport resource callbacks.
  const oldContainer = input().closest<HTMLElement>('.claudian-inline-input-container')!;
  session.destroyInputDOM(oldContainer);
  oldContainer.remove();
  h.backend.sessions[0].emitText('Which tone?');
  h.backend.sessions[0].complete();
  await new Promise(resolve => window.setTimeout(resolve, 0));
  const restored = document.body.appendChild(session.createInputDOM());
  await within(restored).findByText('Which tone?');
  const restoredInput = within(restored).getByRole('textbox', { name: 'Edit instructions' }) as HTMLInputElement;
  expect(restoredInput.value).toBe('');
  expect(restoredInput.placeholder).toBe('Reply to continue...');
  expect(h.settled.mock.calls).toEqual([]);
  fireEvent.input(restoredInput, { target: { value: 'Formal' } });
  fireEvent.keyDown(restoredInput, { key: 'Enter' });
  await waitFor(() => expect(h.backend.sessions[0].requests).toHaveLength(2));
});

async function rejectAfterSourceChange(h: Awaited<ReturnType<typeof createHarness>>, expectedRequests: number): Promise<void> {
  h.editorView.dispatch({ changes: { from: 0, insert: 'XXXXX' } });
  submitInstruction('Use uppercase');
  await waitFor(() => expect(h.settled).toHaveBeenCalledWith({ decision: 'reject' }));
  expect(h.backend.sessions.flatMap(session => session.requests)).toHaveLength(expectedRequests);
  expect(screen.queryByRole('button', { name: 'Accept inline edit' })).toBeNull();
}

it('rejects changed source before first submission without sending stale edit context', async () => {
  const h = await createHarness();
  h.createSession().show();
  await rejectAfterSourceChange(h, 0);
  expect(h.editorView.state.doc.toString()).toBe('XXXXXhello world');
});


it('applies an accepted replacement once and ignores later decisions', async () => {
  const h = await createHarness();
  const session = h.createSession();
  session.show();
  fireEvent.click(await showReplacementPreview(h));
  session.accept();
  session.reject();
  expect(h.settled.mock.calls).toEqual([[{ decision: 'accept', editedText: 'Hi' }]]);
  expect(h.editorView.state.doc.toString()).toBe('Hi world');
  expect(h.editorView.hasFocus).toBe(true);
});

const FOLLOW_UP_PLACEHOLDER = 'Ask for changes, or press Enter to accept';

it('revises a pending proposal through follow-ups in the same conversation', async () => {
  const h = await createHarness();
  vi.mocked(MarkdownRenderer.render).mockImplementation(async (_app, markdown, element) => {
    (element as HTMLElement).textContent = markdown;
  });
  h.createSession().show();
  await showReplacementPreview(h, 'Hi');
  const preview = () => screen.getByRole('toolbar', { name: 'Inline edit actions' }).parentElement!;
  // The composer stays above the preview, so the proposal can be discussed before it is settled.
  expect(input().placeholder).toBe(FOLLOW_UP_PLACEHOLDER);

  submitInstruction('Why Hi?');
  await waitFor(() => expect(h.backend.sessions[0].requests).toHaveLength(2));
  const reachedEditor = vi.fn();
  h.editorView.contentDOM.addEventListener('keydown', reachedEditor);
  // A stray Enter while the follow-up runs neither accepts the proposal it may replace nor edits the note.
  fireEvent.keyDown(document.body, { key: 'Enter' });
  expect(reachedEditor).not.toHaveBeenCalled();
  expect(h.settled).not.toHaveBeenCalled();
  h.backend.sessions[0].emitText('It is shorter.');
  h.backend.sessions[0].complete();
  // The answer shows under the question it answers, and the proposal stays pending.
  const composer = input().closest<HTMLElement>('.claudian-inline-input-container')!;
  await within(composer).findByText('It is shorter.');
  expect(within(composer).getByText('Why Hi?')).toBeDefined();
  expect(preview().textContent).toContain('Hi');
  expect(await axe(composer)).toHaveNoViolations();

  submitInstruction('Use Yo');
  await waitFor(() => expect(h.backend.sessions[0].requests).toHaveLength(3));
  h.backend.sessions[0].emitText('<replacement>Yo</replacement>');
  h.backend.sessions[0].complete();
  await waitFor(() => expect(preview().textContent).toContain('Yo'));
  expect(preview().textContent).not.toContain('Hi');
  // The new proposal clears the answer about the previous one; no history accumulates.
  expect(screen.queryByText('It is shorter.')).toBeNull();
  expect(screen.queryByText('Why Hi?')).toBeNull();
  expect(input().placeholder).toBe(FOLLOW_UP_PLACEHOLDER);
  // Follow-ups carry only the instruction; the provider already holds the editor context and proposal.
  expect(h.backend.sessions).toHaveLength(1);
  expect(h.backend.sessions[0].requests.slice(1).map(request => request.input))
    .toEqual([[{ text: 'Why Hi?', type: 'text' }], [{ text: 'Use Yo', type: 'text' }]]);

  // Enter on an empty composer accepts the latest proposal.
  fireEvent.keyDown(input(), { key: 'Enter' });
  expect(h.settled.mock.calls).toEqual([[{ decision: 'accept', editedText: 'Yo' }]]);
  expect(h.editorView.state.doc.toString()).toBe('Yo world');
});

it('rejects on Escape in a note editor whose own keymap handles Escape', async () => {
  const h = await createHarness();
  // Obsidian's editor binds Escape, so CodeMirror marks the event handled before it bubbles to the document.
  h.editorView.dispatch({ effects: StateEffect.appendConfig.of(keymap.of([{ key: 'Escape', run: () => true }])) });
  h.createSession().show();
  h.editorView.contentDOM.focus();
  expect(fireEvent.keyDown(h.editorView.contentDOM, { key: 'Escape' })).toBe(false);
  expect(h.settled.mock.calls).toEqual([[{ decision: 'reject' }]]);
});
