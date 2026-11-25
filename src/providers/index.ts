import { registerProviderModules } from '../core/providers/registerProviderModules';
import { claudeProviderRegistration } from './claude/registration';
import { codexProviderRegistration } from './codex/registration';
import { grokProviderRegistration } from './grok/registration';
import { opencodeProviderRegistration } from './opencode/registration';
import { piProviderRegistration } from './pi/registration';

export const BUILT_IN_PROVIDER_MODULES = [
  claudeProviderRegistration,
  codexProviderRegistration,
  grokProviderRegistration,
  opencodeProviderRegistration,
  piProviderRegistration,
] as const;

registerProviderModules(BUILT_IN_PROVIDER_MODULES);
