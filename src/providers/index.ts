import { registerProviderModules } from '../core/providers/registerProviderModules';
import { codexProviderRegistration } from './codex/registration';

export const BUILT_IN_PROVIDER_MODULES = [
  codexProviderRegistration,
] as const;

registerProviderModules(BUILT_IN_PROVIDER_MODULES);
