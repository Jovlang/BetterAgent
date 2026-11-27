import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { codexProviderRegistration } from '@/providers/codex/registration';

export function registerCodexForTests(): void {
  ProviderRegistry.register('codex', codexProviderRegistration);
  ProviderWorkspaceRegistry.register('codex', codexProviderRegistration.workspace);
}
