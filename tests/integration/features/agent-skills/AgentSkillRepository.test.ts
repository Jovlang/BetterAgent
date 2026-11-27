const actualModule0 = await vi.importActual<typeof fs>('node:fs/promises');
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { DesktopVault } from '@test/helpers/core/DesktopVault';

import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import {
  AGENT_SKILLS_ROOT,
  AgentSkillRepository,
  AgentSkillRevisionConflictError,
} from '@/features/agent-skills/AgentSkillRepository';


vi.mock('node:fs/promises', async () => {
  const actual = (await vi.importActual<typeof fs>('node:fs/promises'));
  return { ...actual, mkdir: vi.fn(actual.mkdir), writeFile: vi.fn(actual.writeFile) };
});
const actualFs = actualModule0;

function markdown(name: string, description = 'Description', instructions = 'Instructions'): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    'license: MIT',
    'metadata: {"owner":"team"}',
    '---',
    instructions,
    '',
  ].join('\n');
}

describe('AgentSkillRepository', () => {
  let vault: DesktopVault;
  let vaultFiles: VaultFileAdapter;
  let repository: AgentSkillRepository;

  beforeEach(async () => {
    vault = await DesktopVault.create();
    await vault.mkdir(AGENT_SKILLS_ROOT);
    vaultFiles = vault.files;
    repository = new AgentSkillRepository(vaultFiles);
  });

  afterEach(async () => {
    vi.mocked(fs.mkdir).mockImplementation(actualFs.mkdir);
    vi.mocked(fs.writeFile).mockImplementation(actualFs.writeFile);
    await vault.dispose();
  });

  function addSkill(name: string, content = markdown(name)): Promise<void> {
    return vault.write(`${AGENT_SKILLS_ROOT}/${name}/SKILL.md`, content);
  }

  it('treats an unsafe managed root as fatal and unsafe child packages as diagnostics', async () => {
    const rootUnsafeFiles = {
      verifyManagedPath: vi.fn().mockRejectedValue(new Error('Managed resource must not be a symlink')),
    } as unknown as VaultFileAdapter;
    await expect(new AgentSkillRepository(rootUnsafeFiles).list()).rejects.toThrow('symlink');

    const childUnsafeFiles = {
      readManagedFile: vi.fn().mockRejectedValue(new Error('Managed resource must not be a symlink')),
      verifyManagedPath: vi.fn(async (candidate: string) => {
        if (candidate.endsWith('/unsafe')) throw new Error('Managed resource must not be a symlink');
        return true;
      }),
      listManagedFolderEntries: vi.fn().mockResolvedValue([
        { path: `${AGENT_SKILLS_ROOT}/unsafe`, type: 'folder' },
      ]),
    } as unknown as VaultFileAdapter;
    const result = await new AgentSkillRepository(childUnsafeFiles).list();
    expect(result.skills).toEqual([]);
    expect(result.diagnostics).toEqual([{
      directoryPath: `${AGENT_SKILLS_ROOT}/unsafe`,
      message: 'Managed resource must not be a symlink',
    }]);
  });

  it('updates owned fields while preserving unknown metadata and ancillary files', async () => {
    await addSkill('portable-skill');
    await vault.write(`${AGENT_SKILLS_ROOT}/portable-skill/script.ts`, 'export {};');
    const loaded = (await repository.list()).skills[0];

    const updated = await repository.update('portable-skill', loaded.revision, {
      name: 'portable-skill',
      description: 'Updated description',
      instructions: 'Updated instructions',
    });

    expect(updated.frontmatter).toMatchObject({ license: 'MIT', metadata: { owner: 'team' } });
    expect(await vault.read(`${AGENT_SKILLS_ROOT}/portable-skill/script.ts`)).toBe('export {};');
  });

  it('rejects a stale update after an external edit', async () => {
    await addSkill('portable-skill');
    const loaded = (await repository.list()).skills[0];
    await vault.write(loaded.filePath, markdown('portable-skill', 'Externally changed'));

    await expect(repository.update('portable-skill', loaded.revision, {
      name: 'portable-skill',
      description: 'My edit',
      instructions: 'My instructions',
    })).rejects.toBeInstanceOf(AgentSkillRevisionConflictError);
  });

  it('restores the original package and content when the renamed write fails', async () => {
    await addSkill('old-name');
    await vault.write(`${AGENT_SKILLS_ROOT}/old-name/reference.txt`, 'reference');
    const loaded = (await repository.list()).skills[0];
    vi.mocked(fs.writeFile).mockImplementation(async (file, data, options) => {
      if (path.dirname(String(file)) === vault.resolve(`${AGENT_SKILLS_ROOT}/new-name`)) throw new Error('write failed');
      return actualFs.writeFile(file, data, options);
    });

    await expect(repository.update('old-name', loaded.revision, {
      name: 'new-name',
      description: 'Updated',
      instructions: 'Updated instructions',
    })).rejects.toThrow('Could not write managed resource');

    expect(await vault.read(`${AGENT_SKILLS_ROOT}/old-name/SKILL.md`)).toBe(markdown('old-name'));
    expect(await vault.read(`${AGENT_SKILLS_ROOT}/old-name/reference.txt`)).toBe('reference');
    expect(await vault.exists(`${AGENT_SKILLS_ROOT}/new-name`)).toBe(false);
  });
  describe('repairing packages that need attention', () => {

    it('rewrites a flagged package as a valid skill, renaming its folder', async () => {
      await vault.write(`${AGENT_SKILLS_ROOT}/Bad_Name/SKILL.md`, '---\nname: Bad_Name\ndescription: Desc\n---\nBody\n');
      await vault.write(`${AGENT_SKILLS_ROOT}/Bad_Name/asset.txt`, 'asset');

      const draft = await repository.readForRepair('Bad_Name');
      await repository.repair('Bad_Name', draft.revision, {
        name: 'fixed-skill', description: 'Now valid', instructions: 'Body',
      });

      const result = await repository.list();
      expect(result.diagnostics).toEqual([]);
      expect(result.skills.map(skill => [skill.name, skill.description])).toEqual([['fixed-skill', 'Now valid']]);
      expect(await vault.read(`${AGENT_SKILLS_ROOT}/fixed-skill/asset.txt`)).toBe('asset');
    });
  });
  describe('on a filesystem-backed vault', () => {

    it.for(['success', 'write failure'] as const)('repairs native case aliases with physical spelling preserved through %s', async (outcome, context) => {
      const original = markdown('Example', 'Original', 'Original instructions');
      await addSkill('Example', original);
      await vault.write(`${AGENT_SKILLS_ROOT}/Example/assets/reference.txt`, 'nested asset');
      await vault.write(`${AGENT_SKILLS_ROOT}/Example/notes.md`, 'additional file');
      const root = vault.resolve(AGENT_SKILLS_ROOT);
      const source = vault.resolve(`${AGENT_SKILLS_ROOT}/Example`);
      const target = vault.resolve(`${AGENT_SKILLS_ROOT}/example`);
      const canonicalTarget = await actualFs.realpath(target).catch(error => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (canonicalTarget === undefined) context.skip();
      expect(await actualFs.readdir(root)).toEqual(['Example']);
      expect(canonicalTarget).toBe(await actualFs.realpath(source));
      const originalSnapshot = await vault.snapshot();
      const draft = await repository.readForRepair('Example');
      const input = { name: 'example', description: 'Repaired', instructions: 'Updated instructions' };
      let spellingAtFailure: string[] | undefined;
      let rollback: unknown;
      if (outcome === 'write failure') {
        vi.mocked(fs.writeFile).mockImplementation(async (file, data, options) => {
          if (path.dirname(String(file)) === target && path.basename(String(file)).startsWith('.claudian-')) {
            spellingAtFailure = await actualFs.readdir(root);
            throw new Error('case repair write failed');
          }
          return actualFs.writeFile(file, data, options);
        });
        try {
          const error = await repository.repair('Example', draft.revision, input).catch(error => error);
          rollback = {
            error, spellingAtFailure, entries: await actualFs.readdir(root),
            raw: await vault.read(`${AGENT_SKILLS_ROOT}/Example/SKILL.md`),
            draft: await repository.readForRepair('Example'), snapshot: await vault.snapshot(),
            packageEntries: (await actualFs.readdir(source)).sort(),
          };
        } finally {
          vi.mocked(fs.writeFile).mockImplementation(actualFs.writeFile);
        }
      }
      const expectedRollback = {
        error: expect.objectContaining({ message: expect.stringContaining('Could not write managed resource') }),
        spellingAtFailure: ['example'], entries: ['Example'], raw: original,
        draft, snapshot: originalSnapshot, packageEntries: ['SKILL.md', 'assets', 'notes.md'],
      };
      expect(rollback).toEqual(outcome === 'write failure' ? expectedRollback : undefined);
      const repaired = await repository.repair('Example', draft.revision, input);
      expect(await actualFs.readdir(root)).toEqual(['example']);
      expect(repaired).toMatchObject({ ...input, directoryPath: `${AGENT_SKILLS_ROOT}/example`, frontmatter: { license: 'MIT', metadata: { owner: 'team' } } });
      expect(repaired.revision).not.toBe(draft.revision);
      expect(await vault.read(`${AGENT_SKILLS_ROOT}/example/assets/reference.txt`)).toBe('nested asset');
      expect(await vault.read(`${AGENT_SKILLS_ROOT}/example/notes.md`)).toBe('additional file');
      expect((await actualFs.readdir(target)).sort()).toEqual(['SKILL.md', 'assets', 'notes.md']);
      const reloaded = await new AgentSkillRepository(vault.files).list();
      expect(reloaded.diagnostics).toEqual([]);
      expect(reloaded.skills).toEqual([repaired]);
    });
  });
});
