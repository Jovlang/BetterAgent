import '@/providers';

import {
  BUILT_IN_COMMANDS,
  getBuiltInCommandsForDropdown,
} from '@/core/commands/builtInCommands';

describe('getBuiltInCommandsForDropdown - provider filtering', () => {

  it('excludes Codex-only commands for the Claude provider', () => {
    const commands = getBuiltInCommandsForDropdown('claude');
    expect(commands.length).toBe(BUILT_IN_COMMANDS.length - 2);
    expect(commands.map(c => c.name)).toContain('new');
    expect(commands.map(c => c.name)).toContain('sessions');
    expect(commands.map(c => c.name)).not.toContain('fast');
    expect(commands.map(c => c.name)).not.toContain('approve');
  });

  it('returns only commands supported by codex capabilities', () => {
    const commands = getBuiltInCommandsForDropdown('codex');
    expect(commands.map(c => c.name)).toEqual([
      'new',
      'approve',
      'compact',
      'sessions',
      'fast',
      'side',
    ]);
  });
});
