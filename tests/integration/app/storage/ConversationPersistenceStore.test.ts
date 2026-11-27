import '@test/helpers/registeredCodex';

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { DesktopVault } from '@test/helpers/core/DesktopVault';
import { DEFAULT_CLAUDIAN_SETTINGS } from '@test/helpers/defaultSettings';
import { createObsidianPlugin } from '@test/helpers/ObsidianSettingsHost';
import type { App} from 'obsidian';
import { Notice } from 'obsidian';

import { ConversationRepository } from '@/app/conversations/ConversationRepository';
import { ConversationPersistenceStore } from '@/app/storage/ConversationPersistenceStore';
import { migrateSessionSidecars } from '@/app/storage/migrateSessionSidecars';
import { SharedStorageService } from '@/app/storage/SharedStorageService';
import { CLAUDIAN_SETTINGS_PATH, getDeviceSessionsPath, SESSIONS_PATH } from '@/core/bootstrap/storagePaths';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import type { Conversation, SessionMetadata } from '@/core/types';
import { organizeSessionList } from '@/features/chat/session-manager/SessionListOrganizer';



const DEVICE_KEY = `device-${'a'.repeat(64)}`;
const DEVICE_PATH = getDeviceSessionsPath(DEVICE_KEY);
const metadata: SessionMetadata = {
  id: 'conversation-1', providerId: 'codex', title: 'Example', createdAt: 1, lastActivityAt: 2,
};

let root: string;
let app: App;
let adapter: VaultFileAdapter;
let store: ConversationPersistenceStore;

let vault: DesktopVault;
beforeEach(async () => {
  vault = await DesktopVault.create();
  root = vault.root;
  app = vault.app;
  adapter = vault.files;
  store = new ConversationPersistenceStore(adapter, DEVICE_KEY);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await vault.dispose();
});

test('does not create storage directories during read-only initialization', async () => {
  const mkdir = vi.spyOn(app.vault.adapter, 'mkdir');
  const write = vi.spyOn(app.vault.adapter, 'write');
  await new SharedStorageService(createObsidianPlugin(app), DEFAULT_CLAUDIAN_SETTINGS).initialize();
  expect(mkdir).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  expect(await vault.snapshot()).toEqual(new Map());
});

test('writes compact metadata without changing its contents', async () => {
  const data = { ...metadata, providerState: { futureField: { values: ['one', 'two'], multiline: 'line one\nline two' } } };
  await store.saveMetadata(data);
  const content = await adapter.read(`${DEVICE_PATH}/${metadata.id}.meta.json`);
  expect(content).toBe(JSON.stringify(data));
  expect(await store.metadataReader.loadMetadata(metadata.id)).toEqual(data);
});

test('isolates device metadata and preserves unscoped authority across read-only scans', async () => {
  const betaKey = `device-${'b'.repeat(64)}`;
  const beta = new ConversationPersistenceStore(adapter, betaKey);
  const current = { ...metadata, id: 'duplicate', linkedContentPath: 'Notes/current.md' };
  const legacy = { ...current, title: 'Unscoped duplicate' };
  const shared = { ...metadata, id: 'shared' };
  const betaOnly = { ...metadata, id: 'beta-only' };
  await store.saveMetadata(current);
  await store.saveMetadata(legacy, 'unscoped');
  await store.saveMetadata(shared, 'unscoped');
  await beta.saveMetadata(betaOnly);

  const files = [
    [`${DEVICE_PATH}/duplicate.meta.json`, current],
    [`${SESSIONS_PATH}/duplicate.meta.json`, legacy],
    [`${SESSIONS_PATH}/shared.meta.json`, shared],
    [`${getDeviceSessionsPath(betaKey)}/beta-only.meta.json`, betaOnly],
  ] as const;
  for (const [file, expected] of files) expect(await adapter.read(file)).toBe(JSON.stringify(expected));
  const writes = vi.spyOn(adapter, 'write');
  const deletes = vi.spyOn(adapter, 'delete');
  const renames = vi.spyOn(adapter, 'rename');

  expect(await store.metadataReader.load('duplicate')).toEqual({ metadata: current, source: 'device', needsMigration: false });
  expect(await store.metadataReader.load('shared')).toEqual({ metadata: shared, source: 'unscoped', needsMigration: false });
  expect(await store.metadataReader.loadMetadata('shared')).toEqual(shared);
  const scanned = await store.metadataReader.scan();
  expect(scanned.complete).toBe(true);
  expect(scanned.records).toEqual([
    { metadata: current, source: 'device', needsMigration: false },
    { metadata: shared, source: 'unscoped', needsMigration: false },
  ]);
  expect(await store.metadataReader.listMetadata()).toEqual([current, shared]);
  expect(await beta.metadataReader.listMetadata()).toEqual([betaOnly, legacy, shared]);
  expect(writes).not.toHaveBeenCalled();
  expect(deletes).not.toHaveBeenCalled();
  expect(renames).not.toHaveBeenCalled();
});

test.each([
  { name: 'legacy currentNote', stored: { currentNote: 'Notes\\Legacy.md' }, linkedContentPath: 'Notes/Legacy.md' },
  { name: 'canonical precedence', stored: { linkedContentPath: './Projects//Current', currentNote: 'Notes/Legacy.md' }, linkedContentPath: 'Projects/Current' },
  { name: 'invalid canonical path', stored: { linkedContentPath: '../escape', currentNote: 'Notes/Legacy.md' }, linkedContentPath: undefined },
])('decodes $name without rewriting the stored metadata', async ({ stored, linkedContentPath }) => {
  const file = `${DEVICE_PATH}/${metadata.id}.meta.json`;
  const original = JSON.stringify({ ...metadata, ...stored });
  await adapter.write(file, original);
  const writes = vi.spyOn(adapter, 'write');

  expect(await store.metadataReader.load(metadata.id)).toEqual({
    metadata: { ...metadata, ...(linkedContentPath ? { linkedContentPath } : {}) },
    needsMigration: true,
    source: 'device',
  });
  expect(writes).not.toHaveBeenCalled();
  expect(await adapter.read(file)).toBe(original);
});

test('refuses assignment over existing device metadata and retains both authorities', async () => {
  const device = { ...metadata, title: 'Device winner' };
  await store.saveMetadata(metadata, 'unscoped');
  await store.saveMetadata(device);
  const rename = vi.spyOn(adapter, 'rename');

  await expect(store.assignMetadataToDevice(metadata.id)).rejects.toThrow('device metadata already exists');

  expect(rename).not.toHaveBeenCalled();
  expect(JSON.parse(await adapter.read(`${DEVICE_PATH}/${metadata.id}.meta.json`))).toEqual(device);
  expect(JSON.parse(await adapter.read(`${SESSIONS_PATH}/${metadata.id}.meta.json`))).toEqual(metadata);
});

test.each([
  { providerId: 'codex' as const, locator: { threadId: 'native', sessionFilePath: '/history/codex.jsonl' } },
])('preserves $providerId native locators and opaque state in unloaded and recovery records', async ({ providerId, locator }) => {
  const state = { ...locator, futureField: { cursor: 'keep' } };
  const recoverySource = { sessionId: 'recovery-session', providerState: state, resumeAtMessageId: 'checkpoint' };
  const conversation: Conversation = {
    ...metadata, providerId, sessionId: null, messages: [], providerState: state,
    modelRecoverySource: recoverySource,
  };
  const repository = createRepository();
  repository.mergeMetadataConversations([conversation], 'unscoped');

  await repository.assignToCurrentDevice(conversation.id);

  const saved = await store.metadataReader.loadMetadata(conversation.id);
  expect(saved).toMatchObject({ sessionId: null, providerState: state, modelRecoverySource: recoverySource });
});

test('metadata scan and revalidation read unchanged payloads once through the storage adapter', async () => {
  for (let index = 0; index < 25; index++) {
    await store.saveMetadata({ ...metadata, id: `saved-${index}` });
  }
  const read = vi.spyOn(adapter, 'read');
  const scan = await store.metadataReader.scan();
  const records = await store.metadataReader.revalidate(scan.records);
  expect(records).toHaveLength(25);
  expect(scan.complete).toBe(true);
  expect(records.every(record => record.source === 'device')).toBe(true);
  expect(read).toHaveBeenCalledTimes(25);
});

test('preserves higher-priority metadata authority when its stat is unavailable', async () => {
  await store.saveMetadata(metadata, 'unscoped');
  const scanned = await store.metadataReader.scan();
  await store.saveMetadata({ ...metadata, title: 'Device owner' });
  const stat = app.vault.adapter.stat.bind(app.vault.adapter);
  vi.spyOn(app.vault.adapter, 'stat').mockImplementation(async file => {
    if (file === `${DEVICE_PATH}/${metadata.id}.meta.json`) throw new Error('Stat temporarily unavailable');
    return stat(file);
  });
  const resolved = await store.metadataReader.revalidate(scanned.records);
  expect(resolved).toEqual([expect.objectContaining({ source: 'device', metadata: expect.objectContaining({ title: 'Device owner' }) })]);
});

test('assignment moves the metadata to its device and the shared folder contains only the device directory', async () => {
  await store.saveMetadata(metadata, 'unscoped');
  await store.assignMetadataToDevice(metadata.id);

  expect(await fs.readdir(path.join(root, SESSIONS_PATH))).toEqual(['devices']);
  expect(JSON.parse(await adapter.read(`${DEVICE_PATH}/${metadata.id}.meta.json`))).toEqual(metadata);
  expect(await store.metadataReader.loadMetadata(metadata.id)).toEqual(metadata);
});

function createRepository() {
  return new ConversationRepository({
    providers: ProviderRegistry,
    providerSettings: ProviderSettingsCoordinator,
    persistence: store, getSettings: () => ({}), getVaultPath: () => root,
    onConversationDeleted: async () => undefined,
  });
}

test('deleting a conversation removes its metadata while leaving provider history intact', async () => {
  const repository = createRepository();
  const conversation = await repository.create();
  const nativePath = 'provider/session.jsonl';
  await adapter.write(nativePath, 'native history');

  await repository.delete(conversation.id);

  expect(await adapter.listFiles(DEVICE_PATH)).toEqual([]);
  expect(await store.metadataReader.loadMetadata(conversation.id)).toBeNull();
  expect(await adapter.read(nativePath)).toBe('native history');
});

test('reopening uses provider messages as the authoritative history', async () => {
  const repository = createRepository();
  const conversation = { ...metadata, providerId: 'codex', sessionId: 'native-session', messages: [] };
  repository.replaceAll([conversation]);
  const nativeMessage = {
    id: 'native-message', userMessageId: 'native-user', role: 'user' as const,
    content: 'Provider text', displayContent: 'Provider text', timestamp: 2,
  };
  vi.spyOn(ProviderRegistry, 'getConversationHistoryService').mockReturnValue({
    hydrateConversationHistory: async () => ({ messages: [nativeMessage] }),
  } as unknown as ReturnType<typeof ProviderRegistry.getConversationHistoryService>);
  await adapter.write(`${SESSIONS_PATH}/${metadata.id}.inputs.json`, JSON.stringify({
    schemaVersion: 1, conversationId: metadata.id, records: [{
      schemaVersion: 1, id: 'old-input', state: 'accepted', userTurnOrdinal: 1,
      providerUserMessageId: 'native-user', timestamp: 2,
      rawDisplayText: 'Old overlay', canonicalText: 'Old overlay', images: [], contentDigest: 'a'.repeat(64),
    }],
  }));

  const reopened = await repository.ensureHydrated(metadata.id);

  expect(reopened?.messages[0]?.displayContent).toBe('Provider text');
});

test('migration completes old assignments and deletions before removing their sidecars', async () => {
  await store.saveMetadata(metadata, 'unscoped');
  await adapter.write(`${SESSIONS_PATH}/${metadata.id}.assigned.json`, JSON.stringify({
    schemaVersion: 1, conversationId: metadata.id, deviceKey: DEVICE_KEY,
  }));
  const removed = { ...metadata, id: 'removed' };
  await store.saveMetadata(removed);
  await adapter.write(`${DEVICE_PATH}/removed.deleted.json`, JSON.stringify({
    schemaVersion: 1, conversationId: removed.id, deletedAt: 3,
  }));
  await adapter.write(`${SESSIONS_PATH}/${metadata.id}.inputs.json`, '{}');

  const obsoleteInputs = await migrateSessionSidecars(adapter);
  expect(obsoleteInputs).toEqual([`${SESSIONS_PATH}/${metadata.id}.inputs.json`]);
  expect(await adapter.exists(obsoleteInputs[0])).toBe(true);
  for (const file of obsoleteInputs) await adapter.delete(file);
  expect(await migrateSessionSidecars(adapter)).toEqual([]);

  expect(await adapter.listFilesRecursive(SESSIONS_PATH)).toEqual([`${DEVICE_PATH}/${metadata.id}.meta.json`]);
  expect(await store.metadataReader.loadMetadata(metadata.id)).toEqual(metadata);
  expect(await store.metadataReader.loadMetadata(removed.id)).toBeNull();
});

test('migration retains assigned metadata and respects the scope of old deletion markers', async () => {
  const otherKey = `device-${'b'.repeat(64)}`;
  const otherPath = getDeviceSessionsPath(otherKey);
  await store.saveMetadata({ ...metadata, title: 'Stale shared copy' }, 'unscoped');
  await adapter.write(`${otherPath}/${metadata.id}.meta.json`, JSON.stringify(metadata));
  await adapter.write(`${SESSIONS_PATH}/${metadata.id}.assigned.json`, JSON.stringify({
    schemaVersion: 1, conversationId: metadata.id, deviceKey: otherKey,
  }));
  await adapter.write(`${SESSIONS_PATH}/${metadata.id}.deleted.json`, '{}');
  await adapter.write(`.claude/sessions/${metadata.id}.meta.json`, JSON.stringify(metadata));
  await store.saveMetadata({ ...metadata, id: 'device-deleted' });
  await store.saveMetadata({ ...metadata, id: 'device-deleted', title: 'Shared' }, 'unscoped');
  await adapter.write(`${DEVICE_PATH}/device-deleted.deleted.json`, '{}');

  await migrateSessionSidecars(adapter);

  const otherStore = new ConversationPersistenceStore(adapter, otherKey);
  expect(await otherStore.metadataReader.loadMetadata(metadata.id)).toEqual(metadata);
  expect(await store.metadataReader.loadMetadata(metadata.id)).toBeNull();
  expect(await store.metadataReader.loadMetadata('device-deleted')).toEqual({
    ...metadata, id: 'device-deleted', title: 'Shared',
  });
});

test('assignment recovery retains its valid source until the existing device target is readable', async () => {
  const source = `${SESSIONS_PATH}/${metadata.id}.meta.json`;
  const target = `${DEVICE_PATH}/${metadata.id}.meta.json`;
  const marker = `${SESSIONS_PATH}/${metadata.id}.assigned.json`;
  await store.saveMetadata(metadata, 'unscoped');
  await adapter.write(target, '{');
  await adapter.write(marker, JSON.stringify({ schemaVersion: 1, conversationId: metadata.id, deviceKey: DEVICE_KEY }));
  await adapter.write(CLAUDIAN_SETTINGS_PATH, JSON.stringify({ userName: 'Example' }));

  await new SharedStorageService(createObsidianPlugin(app), DEFAULT_CLAUDIAN_SETTINGS).initialize();

  expect(await adapter.read(source)).toBe(JSON.stringify(metadata));
  expect(await adapter.read(target)).toBe('{');
  expect(await adapter.exists(marker)).toBe(true);

  const repaired = { ...metadata, title: 'Repaired device record' };
  await adapter.write(target, JSON.stringify(repaired));
  await new SharedStorageService(createObsidianPlugin(app), DEFAULT_CLAUDIAN_SETTINGS).initialize();
  expect(await adapter.exists(source)).toBe(false);
  expect(await adapter.exists(marker)).toBe(false);
  expect(await store.metadataReader.load(metadata.id)).toMatchObject({ source: 'device', metadata: repaired });
});

test.each(['{', JSON.stringify({ schemaVersion: 1, conversationId: metadata.id, deviceKey: '../invalid' })])(
  'migration retains unassigned metadata when its obsolete assignment is invalid: %s', async (content) => {
    await store.saveMetadata(metadata, 'unscoped');
    await adapter.write(`${SESSIONS_PATH}/${metadata.id}.assigned.json`, content);

    await migrateSessionSidecars(adapter);

    expect(await store.metadataReader.load(metadata.id)).toEqual({ metadata, source: 'unscoped', needsMigration: false });
    expect(await adapter.listFilesRecursive(SESSIONS_PATH)).toEqual([`${SESSIONS_PATH}/${metadata.id}.meta.json`]);
  },
);

test('a pending deletion rejects execution authority', async () => {
  const repository = createRepository();
  const conversation = await repository.create();
  repository.registerExecutionBinding(conversation.id, 'binding', 0);
  const deletion = repository.delete(conversation.id);
  const authority = repository.assertConversationExecutionAuthority(conversation.id, 'binding', 0);

  await expect(authority).rejects.toThrow('no longer available');
  await deletion;
  expect(await store.metadataReader.loadMetadata(conversation.id)).toBeNull();
});

test('a delayed scan cannot undo a local assignment or redirect later writes and deletion', async () => {
  const repository = createRepository();
  const conversation = { ...metadata, providerId: 'codex', sessionId: null, messages: [] };
  await store.saveMetadata(metadata, 'unscoped');
  const entry = { conversation, source: 'unscoped' as const, needsMigration: false };
  await repository.adoptMetadataConversations([entry]);
  const scanned = await store.metadataReader.load(metadata.id);

  await repository.assignToCurrentDevice(metadata.id);
  await repository.adoptMetadataConversations([{ ...entry, ...scanned!, conversation }]);
  await repository.rename(metadata.id, 'Assigned title');

  expect(await store.metadataReader.load(metadata.id)).toMatchObject({ source: 'device', metadata: { title: 'Assigned title' } });
  expect(await adapter.listFilesRecursive(SESSIONS_PATH)).toEqual([`${DEVICE_PATH}/${metadata.id}.meta.json`]);
  await repository.delete(metadata.id);
  expect(await store.metadataReader.loadMetadata(metadata.id)).toBeNull();
});


test('migration continues when a listed assignment disappears before it is read', async () => {
  const assignmentPath = `${SESSIONS_PATH}/${metadata.id}.assigned.json`;
  await store.saveMetadata(metadata, 'unscoped');
  await adapter.write(assignmentPath, '{}');
  await adapter.write(`${SESSIONS_PATH}/${metadata.id}.inputs.json`, '{}');
  const read = app.vault.adapter.read.bind(app.vault.adapter);
  vi.spyOn(app.vault.adapter, 'read').mockImplementation(async (file) => {
    if (file === assignmentPath) await fs.unlink(path.join(root, file));
    return read(file);
  });

  await expect(migrateSessionSidecars(adapter)).resolves.toEqual([`${SESSIONS_PATH}/${metadata.id}.inputs.json`]);

  expect(await fs.readdir(path.join(root, SESSIONS_PATH))).toEqual([`${metadata.id}.inputs.json`, `${metadata.id}.meta.json`]);
  expect(await store.metadataReader.loadMetadata(metadata.id)).toEqual(metadata);
});

test('initialization loads settings while sidecar discovery is pending and waits for assignment recovery', async () => {
  await store.saveMetadata(metadata, 'unscoped');
  await adapter.write(`${SESSIONS_PATH}/${metadata.id}.assigned.json`, JSON.stringify({
    schemaVersion: 1, conversationId: metadata.id, deviceKey: DEVICE_KEY,
  }));
  await adapter.write(CLAUDIAN_SETTINGS_PATH, JSON.stringify({ userName: 'Example' }));
  const list = app.vault.adapter.list.bind(app.vault.adapter);
  let entered!: () => void;
  const listingStarted = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const listingGate = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(app.vault.adapter, 'list').mockImplementation(async folder => {
    entered();
    await listingGate;
    return list(folder);
  });
  const exists = vi.spyOn(app.vault.adapter, 'exists');
  const storage = new SharedStorageService(createObsidianPlugin(app), DEFAULT_CLAUDIAN_SETTINGS);
  let finished = false;
  const initializing = storage.initialize().then(result => { finished = true; return result; });
  try {
    await listingStarted;
    expect(exists).toHaveBeenCalledWith(CLAUDIAN_SETTINGS_PATH);
    expect(finished).toBe(false);
  } finally {
    release();
    await initializing;
  }
  expect(JSON.parse(await adapter.read(`${DEVICE_PATH}/${metadata.id}.meta.json`))).toEqual(metadata);
  expect(await adapter.exists(`${SESSIONS_PATH}/${metadata.id}.meta.json`)).toBe(false);
});

test('initialization joins recovery before reporting a settings failure', async () => {
  await store.saveMetadata(metadata, 'unscoped');
  await adapter.write(`${SESSIONS_PATH}/${metadata.id}.assigned.json`, JSON.stringify({
    schemaVersion: 1, conversationId: metadata.id, deviceKey: DEVICE_KEY,
  }));
  await adapter.write(CLAUDIAN_SETTINGS_PATH, '{}');
  const failure = new Error('Settings unavailable');
  const read = app.vault.adapter.read.bind(app.vault.adapter);
  vi.spyOn(app.vault.adapter, 'read').mockImplementation(file => {
    if (file === CLAUDIAN_SETTINGS_PATH) return Promise.reject(failure);
    return read(file);
  });
  const storage = new SharedStorageService(createObsidianPlugin(app), DEFAULT_CLAUDIAN_SETTINGS);
  await expect(storage.initialize()).rejects.toBe(failure);
  expect(JSON.parse(await adapter.read(`${DEVICE_PATH}/${metadata.id}.meta.json`))).toEqual(metadata);
  expect(await adapter.exists(`${SESSIONS_PATH}/${metadata.id}.assigned.json`)).toBe(false);
});

test.each(['list', 'read', 'rename'] as const)(
  'initialization loads settings after a cleanup %s failure and retries next time',
  async (operation) => {
    await store.saveMetadata(metadata, 'unscoped');
    await adapter.write(`${SESSIONS_PATH}/${metadata.id}.assigned.json`, JSON.stringify({
      schemaVersion: 1, conversationId: metadata.id, deviceKey: DEVICE_KEY,
    }));
    await adapter.write(CLAUDIAN_SETTINGS_PATH, JSON.stringify({ userName: 'Example' }));
    const storage = new SharedStorageService(createObsidianPlugin(app), DEFAULT_CLAUDIAN_SETTINGS);
    const original = app.vault.adapter[operation].bind(app.vault.adapter) as (...args: string[]) => ReturnType<App['vault']['adapter'][typeof operation]>;
    let failed = false;
    (vi.spyOn(app.vault.adapter, operation) as import('vitest').MockInstance<(...args: string[]) => ReturnType<App['vault']['adapter'][typeof operation]>>).mockImplementation((...args: string[]): ReturnType<App['vault']['adapter'][typeof operation]> => {
      if (!failed && args[0].startsWith(SESSIONS_PATH)) {
        failed = true;
        throw new Error('Storage unavailable');
      }
      return original(...args);
    });
    vi.mocked(Notice).mockClear();

    await expect(storage.initialize()).resolves.toMatchObject({ claudian: { userName: 'Example' } });
    expect(Notice).toHaveBeenCalledWith('Failed to clean up obsolete session files; will retry next launch');

    await storage.initialize();
    expect(await fs.readdir(path.join(root, SESSIONS_PATH))).toEqual(['devices']);
    expect(JSON.parse(await adapter.read(`${DEVICE_PATH}/${metadata.id}.meta.json`))).toEqual(metadata);
  },
);


test.each([null, 42, {}, [], undefined])('leaves a malformed title record untouched and keeps the session list usable (%o)', async title => {
  const invalid = { ...metadata, id: 'zz-bad-title', title };
  const invalidPath = `${DEVICE_PATH}/${invalid.id}.meta.json`;
  await store.saveMetadata(metadata);
  await adapter.write(invalidPath, JSON.stringify(invalid));
  const before = await adapter.read(invalidPath);
  const scan = await store.metadataReader.scanMetadata();
  const repository = createRepository();
  repository.mergeMetadataConversations(scan.metadata.map(record => ({
    ...record, providerId: record.providerId ?? 'codex', messages: [], sessionId: null,
  })));
  const sections = organizeSessionList(repository.list(), { organization: 'list', sort: 'last-updated', language: 'en' });
  expect(sections[0].conversations.map(record => record.id)).toEqual([metadata.id]);
  expect(scan).toMatchObject({ complete: true, invalidMetadataCount: 1 });
  expect(await adapter.read(invalidPath)).toBe(before);
});
