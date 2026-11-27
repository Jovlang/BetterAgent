import '@test/helpers/registeredCodex';

import {
  getBuiltInCommandsForDropdown,
} from '@/core/commands/builtInCommands';

describe('getBuiltInCommandsForDropdown - provider filtering', () => {

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
