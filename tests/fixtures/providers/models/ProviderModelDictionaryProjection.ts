import { getCodexProviderSettings, updateCodexProviderSettings } from '@/providers/codex/settings';

/** Exercises model alias serialization in the production ES2022 configuration. */
export function roundTripModelMetadata(): unknown {
  const aliases = JSON.parse('{"__proto__":"Model alias"}') as Record<string, string>;
  const settings: Record<string, unknown> = {};
  updateCodexProviderSettings(settings, { visibleModels: ['__proto__'], modelAliases: aliases });
  const reopened = JSON.parse(JSON.stringify(settings)) as Record<string, unknown>;
  return Object.entries(getCodexProviderSettings(reopened).modelAliases);
}
