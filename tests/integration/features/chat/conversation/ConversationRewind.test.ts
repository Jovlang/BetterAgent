// @vitest-environment jsdom
import { createConversationControllerDeps } from '@test/helpers/features/chat/ConversationControllerFixture';
import { fireEvent, within } from '@testing-library/dom';
import { Modal, Notice } from 'obsidian';
import type { Mock, Mocked } from 'vitest';

import type { ImageAttachment } from '@/core/types';
import { ConversationController } from '@/features/chat/conversation/ConversationController';
import type { ChatExecutionCoordinator } from '@/features/chat/execution/ChatExecutionCoordinator';
import * as confirmation from '@/shared/modals/ConfirmModal';

const mockNotice = Notice as Mock;
let respondToConfirmation = () => true;
const nativeOpen = Modal.prototype.open;
beforeEach(() => {
  respondToConfirmation = () => true;
  vi.spyOn(confirmation, 'confirm');
  vi.spyOn(Modal.prototype, 'open').mockImplementation(function (this: Modal) {
    nativeOpen.call(this);
    const dialog = within(document.body).getByRole('dialog', { name: 'Confirm' });
    const accepted = respondToConfirmation();
    const button = accepted
      ? within(dialog).getAllByRole('button').find(button => button.textContent !== 'Cancel')!
      : within(dialog).getByRole('button', { name: 'Cancel' });
    fireEvent.click(button);
  });
});
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

describe('ConversationRewind', () => {
  let controller: ConversationController;
  let deps: Awaited<ReturnType<typeof createConversationControllerDeps>>;
  let mockCoordinator: Mocked<Pick<ChatExecutionCoordinator, 'previewRewind' | 'rewind'>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockCoordinator = {
      previewRewind: vi.fn().mockResolvedValue({ canRewind: true }),
      rewind: vi.fn().mockResolvedValue({ canRewind: true, filesChanged: ['a.ts'] }),
    };
    deps = (await createConversationControllerDeps({
      getExecutionCoordinator: () => mockCoordinator,
    }));
    controller = new ConversationController(deps);
  });

  it('should restore the rewound message through the composer owner', async () => {
    deps = (await createConversationControllerDeps({
      getExecutionCoordinator: () => mockCoordinator,
    }));
    controller = new ConversationController(deps);
    const images: ImageAttachment[] = [{ id: 'image-1', name: 'reference.png', mediaType: 'image/png', data: 'aA==', size: 1, source: 'file' }];
    deps.state.currentConversationId = 'conv-1';
    deps.state.messages = [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'prev-a' },
      {
        content: '',
        displayContent: 'restore this prompt',
        id: 'm2',
        images: images,
        role: 'user',
        timestamp: 2,
        userMessageId: 'user-uuid',
      },
      { id: 'm3', role: 'assistant', content: 'resp', timestamp: 3, assistantMessageId: 'resp-a' },
    ];

    await controller.rewind('m2');

    expect(deps.getInputEl().value).toBe('restore this prompt');
    expect(deps.getInputEl().focus).toHaveBeenCalled();
  });

  it('should rewind to before the first user message and clear provider session state', async () => {
    deps.state.currentConversationId = 'conv-1';
    deps.state.messages = [
      { id: 'm1', role: 'user', content: 'first prompt', timestamp: 1, userMessageId: 'user-uuid' },
      { id: 'm2', role: 'assistant', content: 'resp', timestamp: 2, assistantMessageId: 'resp-a' },
    ];

    await controller.rewind('m1');

    expect(mockCoordinator.rewind).toHaveBeenCalledWith('user-uuid', undefined, 'code-and-conversation');
    expect(deps.state.messages).toEqual([]);
    expect(deps.plugin.updateConversation).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({
        messages: [],
        sessionId: null,
        providerState: undefined,
        resumeAtMessageId: undefined,
      })
    );
    expect(deps.getInputEl().value).toBe('first prompt');
  });

  it('should preview file rewind and surface provider conflicts before confirmation', async () => {
    deps.state.currentConversationId = 'conv-1';
    deps.state.messages = [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'prev-a' },
      { id: 'm2', role: 'user', content: 'test', timestamp: 2, userMessageId: 'user-uuid' },
      { id: 'm3', role: 'assistant', content: 'resp', timestamp: 3, assistantMessageId: 'resp-a' },
    ];
    mockCoordinator.previewRewind = vi.fn().mockResolvedValue({
      canRewind: true,
      conflicts: [{ conflictType: 'modified_externally', path: 'notes/conflicted.md' }],
      filesChanged: ['notes/conflicted.md'],
    });

    await controller.rewind('m2');

    expect(mockCoordinator.previewRewind).toHaveBeenCalledWith(
      'user-uuid',
      'prev-a',
      'code-and-conversation',
    );
    expect(confirmation.confirm).toHaveBeenCalledWith(
      deps.plugin.app,
      expect.stringContaining('notes/conflicted.md'),
      'Rewind',
    );
    expect(vi.mocked(confirmation.confirm).mock.calls[0][1]).toContain('overwritten');
    expect(mockCoordinator.rewind).toHaveBeenCalled();
  });

  it('should abort when confirmation is declined', async () => {
    deps.state.currentConversationId = 'conv-1';
    deps.state.messages = [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'a1' },
      { id: 'm2', role: 'user', content: 'test', timestamp: 2, userMessageId: 'u1' },
      { id: 'm3', role: 'assistant', content: '', timestamp: 3, assistantMessageId: 'a2' },
    ];
    respondToConfirmation = () => false;

    await controller.rewind('m2');

    expect(mockCoordinator.rewind).not.toHaveBeenCalled();
    expect(mockNotice).not.toHaveBeenCalled();
  });

  it('should show a warning notice when rewind succeeded but save failed', async () => {
    deps.state.currentConversationId = 'conv-1';
    deps.state.messages = [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'prev-a' },
      { id: 'm2', role: 'user', content: 'test', timestamp: 2, userMessageId: 'user-uuid' },
      { id: 'm3', role: 'assistant', content: 'resp', timestamp: 3, assistantMessageId: 'resp-a' },
    ];

    (deps.plugin.updateConversation as Mock).mockRejectedValueOnce(new Error('Save failed'));

    await controller.rewind('m2');

    expect(mockCoordinator.rewind).toHaveBeenCalledWith('user-uuid', 'prev-a', 'code-and-conversation');
    const msg = mockNotice.mock.calls[0][0] as string;
    expect(msg).toContain('Save failed');
  });
});
