import { TFile, TFolder } from 'obsidian';
import type { Mock } from 'vitest';

import {
  LinkedContentController,
  type LinkedContentControllerOptions,
} from '@/features/chat/linked-content/LinkedContentController';



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

function createHarness(initialFiles: Array<TFile | TFolder> = []) {
  const entries = new Map(initialFiles.map(entry => [entry.path || '.', entry]));
  let activeFile: TFile | null = null;
  const app = {
    vault: {
      getRoot: vi.fn(() => createFolder('')),
      getAbstractFileByPath: vi.fn((path: string) => entries.get(path) ?? null),
    },
    workspace: {
      getActiveFile: vi.fn(() => activeFile),
      getLeaf: vi.fn(() => ({ openFile: vi.fn().mockResolvedValue(undefined) })),
      getLeavesOfType: vi.fn(() => []),
      getLeftLeaf: vi.fn(() => null),
      revealLeaf: vi.fn().mockResolvedValue(undefined),
    },
    metadataCache: {
      getFileCache: vi.fn(() => null),
    },
  };
  const options: LinkedContentControllerOptions = {
    app: app as never,
    getExcludedTags: () => [],
    getCachedVaultFiles: () => [...entries.values()].filter(
      (entry): entry is TFile => entry instanceof TFile,
    ),
    getCachedVaultFolders: () => [...entries.values()].filter(
      (entry): entry is TFolder => entry instanceof TFolder,
    ),
  };

  return {
    app,
    controller: new LinkedContentController(options),
    entries,
    setActiveFile(file: TFile | null) {
      activeFile = file;
    },
  };
}

describe('LinkedContentController', () => {
  it('follows eligible active Notes only in auto-draft and keeps explicit choices sticky', () => {
    const first = createFile('Notes/First.md');
    const second = createFile('Notes/Second.md');
    const folder = createFolder('Projects');
    const harness = createHarness([first, second, folder]);

    harness.setActiveFile(first);
    harness.controller.resetAutoDraft();
    expect(harness.controller.getSnapshot()).toMatchObject({
      mode: 'auto-draft',
      path: 'Notes/First.md',
    });

    harness.controller.selectExplicit('Projects');
    harness.controller.handleActiveFileChanged(second, true);
    expect(harness.controller.getSnapshot()).toMatchObject({
      mode: 'explicit-draft',
      path: 'Projects',
    });

    harness.controller.selectExplicit(null);
    harness.controller.handleActiveFileChanged(first, true);
    expect(harness.controller.getSnapshot()).toMatchObject({
      mode: 'explicit-draft',
      path: null,
    });

    harness.controller.resetAutoDraft();
    harness.controller.handleActiveFileChanged(second, false);
    expect(harness.controller.getSnapshot().path).toBe('Notes/First.md');
  });

  it('uses an active PDF as linked content for the first submission', () => {
    const pdf = createFile('Assets/Reference.pdf');
    const harness = createHarness([pdf]);

    harness.setActiveFile(pdf);
    harness.controller.resetAutoDraft();

    expect(harness.controller.getSnapshot()).toEqual({ mode: 'auto-draft', path: pdf.path });
    expect(harness.controller.beginSubmission()).toEqual({ path: pdf.path });
  });

  it('respects excluded tags when choosing automatic Linked content', () => {
    const markdown = createFile('Notes/Private.md');
    const image = createFile('Images/Diagram.png');
    const harness = createHarness([markdown, image]);
    (harness.app.metadataCache.getFileCache as Mock).mockReturnValue({
      tags: [{ tag: '#private' }],
    });
    const excludedController = new LinkedContentController({
      app: harness.app as never,
      getExcludedTags: () => ['private'],
      getCachedVaultFiles: () => [],
      getCachedVaultFolders: () => [],
    });

    harness.setActiveFile(markdown);
    excludedController.handleActiveFileChanged(markdown, true);
    expect(excludedController.getSnapshot().path).toBeNull();

    excludedController.handleActiveFileChanged(image, true);
    expect(excludedController.getSnapshot().path).toBeNull();
  });

  it('restores the exact draft after create failure', () => {
    const note = createFile('Notes/Draft.md');
    const harness = createHarness([note]);
    harness.setActiveFile(note);
    harness.controller.resetAutoDraft();

    const autoToken = harness.controller.beginSubmission();
    harness.controller.rollbackSubmission(autoToken);
    expect(harness.controller.getSnapshot()).toMatchObject({
      mode: 'auto-draft',
      path: 'Notes/Draft.md',
    });

    harness.controller.selectExplicit(null);
    const noneToken = harness.controller.beginSubmission();
    harness.controller.rollbackSubmission(noneToken);
    expect(harness.controller.getSnapshot()).toMatchObject({
      mode: 'explicit-draft',
      path: null,
    });
  });
});
