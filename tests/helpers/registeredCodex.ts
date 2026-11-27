import { registerCodexForTests } from '@test/helpers/registerCodexForTests';

import { codexProviderRegistration } from '@/providers/codex/registration';

registerCodexForTests();
export const BUILT_IN_PROVIDER_MODULES = [codexProviderRegistration] as const;
