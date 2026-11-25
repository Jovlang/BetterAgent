/** @vitest-environment jsdom */
import {
  createChatWorkspaceFixture,
  installChatWorkspaceHooks,
  waitFor,
} from '@test/helpers/features/chat/ChatWorkspaceFixture';
import { within } from '@testing-library/dom';

import { registerProviderModules } from '@/core/providers/registerProviderModules';
import { claudeProviderRegistration } from '@/providers/claude/registration';

registerProviderModules([claudeProviderRegistration]);
installChatWorkspaceHooks();

it('toggles the normal sidebar composer', async () => {
  const { focusCommand: command, tab, noteEditor, rightSplit, sessions } = await createChatWorkspaceFixture();
  noteEditor.value = 'Selected note text';
  noteEditor.focus();
  noteEditor.setSelectionRange(2, 7);
  tab.dom.inputEl.value = 'Sidebar draft';

  expect(command.checkCallback!(true)).toBe(true);
  expect(document.activeElement).toBe(noteEditor);
  expect(command.checkCallback!(false)).toBe(true);
  const input = within(tab.dom.inputComposerEl).getByRole('textbox', { name: 'Message' });
  expect(document.activeElement).toBe(input);
  command.checkCallback!(false);
  expect(document.activeElement).toBe(noteEditor);
  expect([noteEditor.selectionStart, noteEditor.selectionEnd]).toEqual([2, 7]);
  expect(tab.dom.inputEl.value).toBe('Sidebar draft');
  expect(rightSplit.collapsed).toBe(false);
  expect(sessions).toHaveLength(0);
});

it('leaves focus alone when there is no existing composer or its sidebar is collapsed', async () => {
  const { focusCommand, noteEditor, rightSplit, setCollapsed, leaves, view } = await createChatWorkspaceFixture();
  noteEditor.focus();
  setCollapsed(rightSplit, true);
  expect(focusCommand.checkCallback!(true)).toBe(false);
  expect(focusCommand.checkCallback!(false)).toBe(false);
  expect(document.activeElement).toBe(noteEditor);
  expect(rightSplit.collapsed).toBe(true);
  setCollapsed(rightSplit, false);
  expect(focusCommand.checkCallback!(true)).toBe(true);
  view['tabManager'] = null;
  expect(focusCommand.checkCallback!(true)).toBe(false);
  leaves.splice(0);
  expect(focusCommand.checkCallback!(false)).toBe(false);
  expect(document.activeElement).toBe(noteEditor);
});

it('brings a sidebar chat behind a sibling tab to the front and toggles focus with the note', async () => {
  const { focusCommand, addSiblingLeaf, leaf, tab, noteEditor, rightSplit } = await createChatWorkspaceFixture();
  const backlinks = addSiblingLeaf('right');
  leaf.parent!.selected = backlinks;
  noteEditor.focus();

  expect(focusCommand.checkCallback!(true)).toBe(true);
  expect(leaf.parent!.selected).toBe(backlinks);
  expect(focusCommand.checkCallback!(false)).toBe(true);

  // The command reveals asynchronously and exposes no completion signal.
  await waitFor(() => expect(document.activeElement)
    .toBe(within(tab.dom.inputComposerEl).getByRole('textbox', { name: 'Message' })));
  expect(leaf.parent!.selected).toBe(leaf);
  expect(rightSplit.collapsed).toBe(false);
  expect(focusCommand.checkCallback!(false)).toBe(true);
  expect(document.activeElement).toBe(noteEditor);
  expect(leaf.parent!.selected).toBe(leaf);
});

it.each(['display', 'visibility', 'opacity', 'detached'])('skips a composer hidden by %s and rejects the command if none remain visible', async (reason) => {
  const { focusCommand, addView, view, noteEditor, leftSplit, setCollapsed } = await createChatWorkspaceFixture();
  const other = await addView('left');
  noteEditor.focus();
  expect(focusCommand.checkCallback!(true)).toBe(true);
  if (reason === 'display') view['viewContainerEl']!.style.display = 'none';
  else if (reason === 'visibility') view['viewContainerEl']!.style.visibility = 'hidden';
  else if (reason === 'opacity') view['viewContainerEl']!.style.opacity = '0';
  else view['viewContainerEl']!.remove();

  expect(focusCommand.checkCallback!(false)).toBe(true);
  expect(document.activeElement).toBe(within(other.tab.dom.inputComposerEl).getByRole('textbox', { name: 'Message' }));
  focusCommand.checkCallback!(false);
  expect(document.activeElement).toBe(noteEditor);
  setCollapsed(leftSplit, true);
  expect(focusCommand.checkCallback!(true)).toBe(false);
  expect(focusCommand.checkCallback!(false)).toBe(false);
  expect(document.activeElement).toBe(noteEditor);
});

it('ignores removed focus targets', async () => {
  const { focusCommand: command, tab, noteEditor } = await createChatWorkspaceFixture();
  noteEditor.focus();
  command.checkCallback!(false);
  const input = within(tab.dom.inputComposerEl).getByRole('textbox', { name: 'Message' });
  noteEditor.remove();
  command.checkCallback!(false);
  expect(document.activeElement).toBe(input);
});
