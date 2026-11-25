import type { TFile } from 'obsidian';

import { formatComposerWikilink } from '@/features/chat/composer/composerWikilinks';
import { MentionSource } from '@/shared/composer-dropdown/MentionSource';
import type { FolderMentionItem } from '@/shared/mention/types';
import type { VaultMentionDataProvider } from '@/shared/mention/VaultMentionDataProvider';

/**
 * Owns composer mention selection over the shared view cache.
 * Linked content state and presentation belong to LinkedContentController.
 */
export class FileContextManager {
  private readonly mentionSource: MentionSource;

  /** The view-owned provider is required: the view registers and releases its vault listeners. */
  constructor(private readonly mentionDataProvider: VaultMentionDataProvider) {
    this.mentionSource = new MentionSource({
      getCachedVaultFolders: () => this.mentionDataProvider.getCachedVaultFolders(),
      getCachedVaultFiles: () => this.mentionDataProvider.getCachedVaultFiles(),
    }, {
      formatVaultFileMention: formatComposerWikilink,
    });
  }

  getCachedVaultFiles(): readonly TFile[] {
    return this.mentionDataProvider.getCachedVaultFiles();
  }

  getCachedVaultFolders(): readonly FolderMentionItem[] {
    return this.mentionDataProvider.getCachedVaultFolders();
  }

  getMentionSource(): MentionSource {
    return this.mentionSource;
  }

  destroy(): void {
    this.mentionSource.destroy();
  }
}
