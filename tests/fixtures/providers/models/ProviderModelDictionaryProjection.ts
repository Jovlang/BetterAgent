import { getOpencodeProviderSettings, updateOpencodeProviderSettings } from '@/providers/opencode/settings';

/** Runs untransformed object-spread semantics at the provider configuration/persistence boundary. */
export function roundTripModelMetadata(): unknown {
  const aliases = JSON.parse('{"__proto__":"Gateway alias"}') as Record<string, string>;
  const reasoning = JSON.parse('{"__proto__":"high"}') as Record<string, string>;
  const settings: Record<string, unknown> = {};
  updateOpencodeProviderSettings(settings, { visibleModels: ['__proto__'], modelAliases: aliases, preferredThinkingByModel: reasoning });
  const reopened = JSON.parse(JSON.stringify(settings)) as Record<string, unknown>;
  return {
    opencode: {
      aliases: Object.entries(getOpencodeProviderSettings(reopened).modelAliases),
      reasoning: Object.entries(getOpencodeProviderSettings(reopened).preferredThinkingByModel),
    },
  };
}
