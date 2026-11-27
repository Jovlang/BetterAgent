/** @vitest-environment jsdom */
import { createEvent, fireEvent } from '@testing-library/dom';
import { FileView, Notice, TFile, TFolder } from 'obsidian';

import { ComposerInfoRow } from '@/features/chat/composer/ComposerInfoRow';
import { LinkedContentController } from '@/features/chat/linked-content/LinkedContentController';
import { createWelcomeElement } from '@/features/chat/rendering/WelcomeRenderer';




function createFile(path: string): TFile {
  const file = new TFile();
  Object.assign(file, {
    path,
    name: path.split('/').pop() ?? '',
    basename: (path.split('/').pop() ?? '').replace(/\.[^.]+$/, ''),
    extension: path.split('.').pop() ?? '',
  });
  return file;
}

function createFolder(path: string): TFolder {
  const folder = new TFolder();
  Object.assign(folder, { path, name: path.split('/').pop() ?? '' });
  return folder;
}

function createFileView(file: TFile): FileView {
  const view = Object.create(FileView.prototype) as FileView;
  Object.assign(view, { file });
  return view;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createHarness(options: {
  entries?: Array<TFile | TFolder>;
  rootLeaves?: Array<{ view?: unknown }>;
} = {}) {
  const root = createFolder('');
  const entries = new Map((options.entries ?? []).map(entry => [entry.path, entry]));
  const openFile = vi.fn().mockResolvedValue(undefined);
  const revealInFolder = vi.fn().mockResolvedValue(undefined);
  const explorerLeaf = { view: { revealInFolder } };
  const app = {
    vault: {
      getRoot: vi.fn(() => root),
      getAbstractFileByPath: vi.fn((path: string) => entries.get(path) ?? null),
    },
    workspace: {
      getActiveFile: vi.fn(() => null),
      getLeaf: vi.fn(() => ({ openFile })),
      getLeavesOfType: vi.fn(() => [explorerLeaf]),
      getLeftLeaf: vi.fn(() => null),
      iterateRootLeaves: vi.fn((callback: (leaf: { view?: unknown }) => void) => {
        for (const leaf of options.rootLeaves ?? []) callback(leaf);
      }),
      revealLeaf: vi.fn().mockResolvedValue(undefined),
    },
    metadataCache: { getFileCache: vi.fn(() => null) },
  };
  const controller = new LinkedContentController({
    app: app as never,
    getExcludedTags: () => [],
    getCachedVaultFiles: () => [...entries.values()].filter(
      (entry): entry is TFile => entry instanceof TFile,
    ),
    getCachedVaultFolders: () => [...entries.values()].filter(
      (entry): entry is TFolder => entry instanceof TFolder,
    ),
  });
  onTestFinished(() => controller.destroy());
  return { app, controller, entries, explorerLeaf, openFile, revealInFolder };
}

function labels(root: HTMLElement): string[] {
  return [...root.querySelectorAll<HTMLElement>('.claudian-composer-dropdown-label')]
    .map(element => element.textContent);
}

describe('LinkedContentController DOM', () => {
  it('mounts the selector below the greeting, selects by keyboard, and returns focus', () => {
    const note = createFile('Notes/Plan.md');
    const folder = createFolder('Projects');
    const harness = createHarness({ entries: [note, folder] });
    const parentEl = document.body.createDiv();
    const welcomeEl = createWelcomeElement(parentEl, 'Good morning') as unknown as HTMLElement;

    harness.controller.mountWelcome(welcomeEl as unknown as HTMLElement);

    expect(welcomeEl.children[1].hasClass('claudian-welcome-greeting')).toBe(true);
    expect(welcomeEl.children[2].hasClass('claudian-welcome-linked-content')).toBe(true);
    const selectorRow = welcomeEl.querySelector<HTMLElement>('.claudian-linked-content-selector-row')!;
    const selector = welcomeEl.querySelector<HTMLElement>('.claudian-linked-content-selector')!;
    expect(welcomeEl.querySelector<HTMLElement>('.claudian-linked-content-selector-prefix')?.textContent)
      .toBe('Linked content:');
    expect(selector.textContent).toBe('None');
    expect(selector.getAttribute('aria-label')).toBeNull();
    selector.getBoundingClientRect = () => ({
      top: 0,
      left: 0,
      width: 38,
      height: 17,
      right: 38,
      bottom: 17,
      x: 0,
      y: 0,
      toJSON: () => undefined,
    });
    const focus = vi.spyOn(selector, 'focus');
    selector.click();

    const picker = welcomeEl.querySelector<HTMLElement>('.claudian-linked-content-picker')!;
    expect(selectorRow.hasClass('is-editing')).toBe(true);
    expect(picker.hasClass('claudian-composer-dropdown')).toBe(true);
    expect(picker.hasClass('is-visible')).toBe(false);
    expect(picker.querySelector<HTMLInputElement>('.claudian-linked-content-picker-search')!).toBeNull();
    expect(welcomeEl.querySelector<HTMLElement>('.claudian-linked-content-picker-option')!).toBeNull();
    expect(labels(welcomeEl)).toEqual([]);
    const search = welcomeEl.querySelector<HTMLInputElement>('.claudian-linked-content-picker-search')!;
    expect(search.getAttribute('role')).toBe('combobox');
    expect(search.getAttribute('aria-expanded')).toBe('false');
    expect(search.getAttribute('aria-label')).toBeNull();
    expect(search.getAttribute('aria-labelledby')).toBe(
      welcomeEl.querySelector<HTMLElement>('.claudian-linked-content-selector-prefix')?.getAttribute('id'),
    );
    expect(search.style.width).toBe('38px');
    expect(search.style.height).toBe('17px');
    search.value = 'Projects';
    fireEvent.input(search);
    expect(search.getAttribute('aria-expanded')).toBe('true');
    expect(search.style.width).toBe('38px');
    expect(picker.hasClass('is-visible')).toBe(true);
    expect(welcomeEl.querySelector<HTMLElement>('.claudian-linked-content-picker-option')
      ?.hasClass('claudian-composer-dropdown-item')).toBe(true);
    expect(labels(welcomeEl)).toEqual(['Projects']);
    fireEvent.keyDown(search, { key: 'Enter' });

    expect(harness.controller.getSnapshot()).toMatchObject({
      mode: 'explicit-draft',
      path: 'Projects',
    });
    expect(selector.getAttribute('aria-label')).toBeNull();
    expect(selector.textContent).toBe('Projects');
    expect(selectorRow.hasClass('is-editing')).toBe(false);
    expect(focus).toHaveBeenCalled();
  });

  it('captures Escape before Obsidian can intercept the picker event', () => {
    const harness = createHarness({ entries: [createFolder('Projects')] });
    const welcome = createWelcomeElement(document.body.createDiv(), 'Hello');
    harness.controller.mountWelcome(welcome);
    const selector = welcome.querySelector<HTMLElement>('.claudian-linked-content-selector')!;
    const hostKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener('keydown', hostKeydown, true);
    try {
      selector.click();
      const picker = welcome.querySelector<HTMLElement>('.claudian-linked-content-picker')!;
      const escape = createEvent.keyDown(picker, { key: 'Escape', bubbles: true, cancelable: true });
      fireEvent(picker, escape);
      expect(escape.defaultPrevented).toBe(true);
      expect(selector.getAttribute('aria-expanded')).toBe('false');
      expect(welcome.contains(picker)).toBe(false);
    } finally {
      window.removeEventListener('keydown', hostKeydown, true);
    }
  });

  it('renders Linked content in the info row and dispatches file, folder, and missing actions', async () => {
    const note = createFile('Notes/Plan.md');
    const folder = createFolder('Projects');
    const harness = createHarness({ entries: [note, folder] });
    const rowEl = document.body.createDiv();
    harness.controller.mountInfoRow(new ComposerInfoRow(rowEl as unknown as HTMLElement));
    const linkedSlot = () => [...rowEl.querySelectorAll<HTMLElement>('.claudian-input-info-linked')][0]!;

    harness.controller.selectExplicit(note.path);
    let item = linkedSlot();
    expect(item.querySelector<HTMLInputElement>('.claudian-input-info-linked-remove')!).not.toBeNull();
    const noteButton = item.querySelector<HTMLInputElement>('.claudian-input-info-linked-main')!;
    expect(noteButton?.getAttribute('aria-label')).toBe('Linked content: Notes/Plan.md');
    expect(noteButton?.getAttribute('title')).toBeNull();
    noteButton?.click();
    await flushPromises();
    expect(harness.app.workspace.getLeaf).toHaveBeenCalledWith('tab');
    expect(harness.openFile).toHaveBeenCalledWith(note);

    harness.controller.selectExplicit(folder.path);
    item = linkedSlot();
    item.querySelector<HTMLInputElement>('.claudian-input-info-linked-main')?.click();
    await flushPromises();
    expect(harness.app.workspace.revealLeaf).toHaveBeenCalledWith(harness.explorerLeaf);
    expect(harness.revealInFolder).toHaveBeenCalledWith(folder);

    harness.controller.selectExplicit('Missing/Plan.md');
    item = linkedSlot();
    expect(item.hasClass('claudian-input-info-linked--missing')).toBe(true);
    expect(item.querySelector<HTMLInputElement>('.claudian-input-info-linked-label')?.textContent)
      .toContain('Missing content');
    expect(item.querySelector<HTMLInputElement>('.claudian-input-info-linked-main')?.getAttribute('aria-label'))
      .toBe('Linked content: Missing/Plan.md. Missing content');
    item.querySelector<HTMLInputElement>('.claudian-input-info-linked-main')?.click();
    expect(Notice).toHaveBeenCalledWith('Linked content is missing: Missing/Plan.md');
  });

  it('reveals the existing main editor tab showing the linked file', async () => {
    const image = createFile('Images/Diagram.png');
    const existingLeaf = { view: createFileView(image) };
    const harness = createHarness({ entries: [image], rootLeaves: [existingLeaf] });
    harness.controller.selectExplicit(image.path);

    await harness.controller.activateCurrentContent();

    expect(harness.app.workspace.revealLeaf).toHaveBeenCalledWith(existingLeaf);
    expect(harness.app.workspace.getLeaf).not.toHaveBeenCalled();
    expect(harness.openFile).not.toHaveBeenCalled();
  });

  it('removes editable Linked content from the info row but keeps locked content immutable', () => {
    const note = createFile('Notes/Plan.md');
    const harness = createHarness({ entries: [note] });
    const rowEl = document.body.createDiv();
    harness.controller.mountInfoRow(new ComposerInfoRow(rowEl as unknown as HTMLElement));

    harness.controller.selectExplicit(note.path);
    rowEl.querySelector<HTMLInputElement>('.claudian-input-info-linked-remove')?.click();

    expect(harness.controller.getSnapshot()).toEqual({
      mode: 'explicit-draft',
      path: null,
    });
    expect(rowEl.querySelector<HTMLInputElement>('.claudian-input-info-linked-main')!).toBeNull();

    harness.controller.selectExplicit(note.path);
    const submission = harness.controller.beginSubmission();
    expect(rowEl.querySelector<HTMLInputElement>('.claudian-input-info-linked-main')!).not.toBeNull();
    expect(rowEl.querySelector<HTMLInputElement>('.claudian-input-info-linked-remove')!).toBeNull();
    harness.controller.commitSubmission(submission);

    expect(rowEl.querySelector<HTMLInputElement>('.claudian-input-info-linked-main')!).not.toBeNull();
    expect(rowEl.querySelector<HTMLInputElement>('.claudian-input-info-linked-remove')!).toBeNull();
  });

  it('reconciles locked Linked content presentation when content disappears and returns', () => {
    const note = createFile('Notes/Plan.md');
    const harness = createHarness({ entries: [note] });
    const rowEl = document.body.createDiv();
    harness.controller.mountInfoRow(new ComposerInfoRow(rowEl as unknown as HTMLElement));
    harness.controller.lock(note.path);

    expect(rowEl.querySelector<HTMLInputElement>('.claudian-input-info-linked--missing')!).toBeNull();

    harness.entries.delete(note.path);
    harness.controller.handleDeleted(note.path);
    expect(rowEl.querySelector<HTMLInputElement>('.claudian-input-info-linked--missing')!).not.toBeNull();
    expect(rowEl.querySelector<HTMLInputElement>('.claudian-input-info-linked-label')?.textContent)
      .toContain('Missing content');

    harness.entries.set(note.path, note);
    harness.controller.handleCreated(note.path);
    expect(rowEl.querySelector<HTMLInputElement>('.claudian-input-info-linked--missing')!).toBeNull();
    expect(rowEl.querySelector<HTMLInputElement>('.claudian-input-info-linked-label')?.textContent).toBe('Plan');
  });

  it('removes owned DOM and event listeners on destruction', () => {
    const harness = createHarness({ entries: [createFolder('Projects')] });
    const welcome = createWelcomeElement(document.body.createDiv(), 'Hello') as unknown as HTMLElement;
    harness.controller.mountWelcome(welcome as unknown as HTMLElement);
    const selector = welcome.querySelector<HTMLElement>('.claudian-linked-content-selector')!;
    selector.click();
    const search = welcome.querySelector<HTMLInputElement>('.claudian-linked-content-picker-search')!;
    search.value = 'Projects';
    fireEvent.input(search);

    harness.controller.destroy();

    selector.click();
    expect(welcome.querySelector<HTMLElement>('.claudian-linked-content-selector')!).toBeNull();
    expect(welcome.querySelector<HTMLElement>('.claudian-linked-content-picker')!).toBeNull();
  });
});

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });
