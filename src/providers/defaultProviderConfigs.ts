import type { ProviderConfigMap } from '../core/types/settings';
import { DEFAULT_CODEX_PROVIDER_CONFIG } from './codex/config';

export function getBuiltInProviderDefaultConfigs(): ProviderConfigMap {
  return {
    codex: { ...DEFAULT_CODEX_PROVIDER_CONFIG },
  };
}
