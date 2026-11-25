import { App, TFile, TFolder } from 'obsidian';

import { FileContextManager } from '@/features/chat/composer/FileContextManager';
import { VaultMentionDataProvider } from '@/shared/mention/VaultMentionDataProvider';

function createFile(path: string): TFile {
  const file = new TFile();
  Object.assign(file, {
    path,
    name: path.split('/').pop() ?? '',
    basename: (path.split('/').pop() ?? '').replace(/\.[^.]+$/, ''),
    extension: path.split('.').pop() ?? '',
    stat: { ctime: 0, mtime: 0, size: 0 },
  });
  return file;
}

function createFolder(path: string): TFolder {
  const folder = new TFolder();
  Object.assign(folder, { path, name: path.split('/').pop() ?? '' });
  return folder;
}

function createMockApp(entries: Array<TFile | TFolder> = []) {
  const app = new App();
  app.vault.getFiles = vi.fn(() => entries.filter((entry): entry is TFile => entry instanceof TFile));
  app.vault.getAllLoadedFiles = vi.fn(() => entries);
  return { app };

}

describe('FileContextManager', () => {
  it('offers vault notes as wikilinks in the main chat picker', async () => {
    const { app } = createMockApp([createFile('DEMO.md'), createFile('- Bases/DEMO.md')]);
    const manager = new FileContextManager(new VaultMentionDataProvider(app));
    try {
      const source = manager.getMentionSource();
      const match = source.match('@DEMO', 5)!;
      const items = await source.load(match, new AbortController().signal);
      for (const [path, text] of [
        ['DEMO.md', '[[DEMO.md|DEMO]] '],
        ['- Bases/DEMO.md', '[[- Bases/DEMO.md|DEMO]] '],
      ]) {
        const item = items.find(item => item.kind === 'value' && item.label === path);
        if (!item || item.kind !== 'value') throw new Error('Missing note option');
        expect(source.select(item, match)).toEqual(expect.objectContaining({ kind: 'replace', text }));
      }
    } finally {
      manager.destroy();
    }
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shares vault cache reads across composers while keeping mention selection independent', async () => {
    const note = createFile('Notes/Plan.md');
    const folder = createFolder('Projects');
    const { app } = createMockApp([note, folder]);
    const data = new VaultMentionDataProvider(app);
    const first = new FileContextManager(data);
    const second = new FileContextManager(data);
    expect(first.getCachedVaultFiles()).toEqual([note]);
    expect(second.getCachedVaultFiles()).toEqual([note]);
    expect(first.getCachedVaultFolders()).toEqual([{ name: 'Projects', path: 'Projects' }]);
    expect(second.getCachedVaultFolders()).toEqual([{ name: 'Projects', path: 'Projects' }]);
    vi.runOnlyPendingTimers();
    expect((app).vault.getFiles).toHaveBeenCalledTimes(1);
    expect((app).vault.getAllLoadedFiles).toHaveBeenCalledTimes(1);
    first.destroy();
    data.markFilesDirty();
    expect(second.getCachedVaultFiles()).toEqual([note]);
    expect((app).vault.getFiles).toHaveBeenCalledTimes(2);
    const source = second.getMentionSource();
    const items = await source.load(source.match('@Plan', 5)!, new AbortController().signal);
    expect(items.some(item => item.label === 'Notes/Plan.md')).toBe(true);
    second.destroy();
  });

});
