/** @vitest-environment jsdom */

import { axe } from '@test/helpers/accessibility';
import { createEvent, fireEvent, within } from '@testing-library/dom';
import { App } from 'obsidian';
import type { Mock } from 'vitest';

import type { ImageAttachment } from '@/core/types';
import { ImageContextManager } from '@/features/chat/composer/ImageContextManager';

let visibility: HTMLStyleElement;
let host: HTMLElement;
let wrapper: HTMLElement;
let input: HTMLTextAreaElement;
let manager: ImageContextManager;
let changed: Mock<() => void>;

function imagesChanged(count: number): Promise<void> {
  return new Promise(resolve => changed.mockImplementation(() => {
    if (manager.getAttachedImages().length === count) resolve();
  }));
}

function imageFile(name: string, type = 'image/png') {
  // jsdom has no File.arrayBuffer; byte reading is the browser boundary.
  return Object.assign(new File(['hello'], name, { type }), {
    arrayBuffer: vi.fn(async () => new TextEncoder().encode('hello').buffer),
  });
}

beforeEach(() => {
  visibility = document.head.appendChild(document.createElement('style'));
  visibility.textContent = '.claudian-hidden { display: none; }';
  host = document.body.createDiv();
  wrapper = host.createDiv({ cls: 'claudian-input-wrapper' });
  input = wrapper.createEl('textarea', { attr: { 'aria-label': 'Message' } });
  changed = vi.fn();
  manager = new ImageContextManager(new App().keymap, host, input, { onUserImagesChanged: changed });
});

afterEach(() => {
  manager.destroy();
  host.remove();
  visibility.remove();
  vi.restoreAllMocks();
});

it('reads supported dropped image extensions into ordered, removable context items', async () => {
  const entries = [
    ['photo.jpg', 'image/jpeg'], ['photo.jpeg', 'image/jpeg'], ['image.png', 'image/png'],
    ['animation.gif', 'image/gif'], ['photo.webp', 'image/webp'], ['PHOTO.JPG', 'image/jpeg'], ['image.Png', 'image/png'],
  ];
  const files = entries.map(([name]) => imageFile(name));
  fireEvent.dragEnter(wrapper, { dataTransfer: { types: ['Files'] } });
  const overlay = within(wrapper).getByText('Drop image here').closest('.claudian-drop-overlay')!;
  expect(overlay.classList.contains('visible')).toBe(true);
  const processed = imagesChanged(entries.length);
  const event = createEvent.drop(wrapper, { dataTransfer: { files } });
  fireEvent(wrapper, event);
  expect(event.defaultPrevented).toBe(true);
  expect(overlay.classList.contains('visible')).toBe(false);
  await processed;
  expect(manager.getAttachedImages()).toEqual(entries.map(([name, mediaType]) => expect.objectContaining({
    name, mediaType, source: 'drop', size: 5, data: 'aGVsbG8=',
  })));
  expect(changed).toHaveBeenCalledTimes(entries.length);
  expect(within(host).getAllByRole('button', { name: /^Image attachment:/ }).map(button => button.textContent))
    .toEqual(['Image 1', 'Image 2', 'Image 3', 'Image 4', 'Image 5', 'Image 6', 'Image 7']);
  fireEvent.click(within(host).getByRole('button', { name: 'Remove Image attachment: photo.jpg · 5 B' }));
  expect(manager.getAttachedImages().map(image => image.name)).toEqual(entries.slice(1).map(([name]) => name));
  expect(within(host).queryByRole('button', { name: 'Image attachment: photo.jpg · 5 B' })).toBeNull();
  expect(changed).toHaveBeenCalledTimes(entries.length + 1);
  expect(await axe(host)).toHaveNoViolations();
});

it('skips unsupported dropped names and MIME types before reading bytes while accepting the next image', async () => {
  const rejected = [imageFile('document.pdf', 'application/pdf'), imageFile('noextension'), imageFile('test.bmp', 'image/bmp')];
  const accepted = imageFile('valid.png');
  const processed = imagesChanged(1);
  fireEvent.drop(wrapper, { dataTransfer: { files: [...rejected, accepted] } });
  await processed;
  expect(within(host).getByRole('button', { name: 'Image attachment: valid.png · 5 B' })).toBeDefined();
  expect(manager.getAttachedImages()).toEqual([expect.objectContaining({ name: 'valid.png' })]);
  for (const file of rejected) expect(file.arrayBuffer).not.toHaveBeenCalled();
  expect(changed).toHaveBeenCalledTimes(1);
});

it('reads every image in a mixed clipboard batch and renders their retained order', async () => {
  const files = [imageFile('first.jpg', 'image/jpeg'), imageFile('second.png')];
  const event = createEvent.paste(input, { clipboardData: { items: [
    { type: 'image/jpeg', getAsFile: () => files[0] },
    { type: 'text/plain', getAsFile: () => null },
    { type: 'image/png', getAsFile: () => files[1] },
  ] } });
  const processed = imagesChanged(files.length);
  fireEvent(input, event);
  expect(event.defaultPrevented).toBe(true);
  await processed;
  expect(manager.getAttachedImages()).toEqual([
    expect.objectContaining({ name: 'first.jpg', mediaType: 'image/jpeg', source: 'paste', data: 'aGVsbG8=' }),
    expect.objectContaining({ name: 'second.png', mediaType: 'image/png', source: 'paste', data: 'aGVsbG8=' }),
  ]);
  expect(changed).toHaveBeenCalledTimes(2);
  expect(within(host).getAllByRole('button', { name: /^Image attachment:/ }).map(button => button.getAttribute('aria-label')))
    .toEqual(['Image attachment: first.jpg · 5 B', 'Image attachment: second.png · 5 B']);
});

function pasteFiles(files: File[]): Event {
  const event = createEvent.paste(input, { clipboardData: {
    items: files.map(file => ({ type: file.type || 'image/png', getAsFile: () => file })),
  } });
  fireEvent(input, event);
  return event;
}

function attachment(overrides: Partial<ImageAttachment> = {}): ImageAttachment {
  return { id: 'image', name: 'photo.png', mediaType: 'image/png', data: 'aGVsbG8=', size: 5, source: 'paste', ...overrides };
}

it('replaces, deduplicates and clears queued attachments through the rendered tray', () => {
  expect(manager.hasImages()).toBe(false);
  expect(manager.getAttachedImages()).toEqual([]);
  manager.setImages([attachment({ id: 'old' })]);
  manager.setImages([
    attachment({ id: 'same', name: 'first.png' }), attachment({ id: 'same', name: 'last.png' }),
    attachment({ id: 'second', name: 'second.png' }),
  ]);
  expect(manager.getAttachedImages().map(image => [image.id, image.name])).toEqual([['same', 'last.png'], ['second', 'second.png']]);
  expect(within(host).queryByRole('button', { name: /^Image attachment: photo.png/ })).toBeNull();
  expect(within(host).getAllByRole('button', { name: /^Image attachment:/ })).toHaveLength(2);
  manager.setImages([]);
  expect(manager.hasImages()).toBe(false);
  expect(within(host).queryByRole('button', { name: /^Image attachment:/ })).toBeNull();
  manager.setImages([attachment()]);
  manager.clearImages();
  expect(manager.getAttachedImages()).toEqual([]);
  expect(within(host).queryByRole('button', { name: /^Image attachment:/ })).toBeNull();
});

it('does not attach a pending paste after destruction or intercept subsequent events', async () => {
  let resolveBuffer!: (value: ArrayBuffer) => void;
  const pending = imageFile('pending.png');
  pending.arrayBuffer.mockImplementation(() => new Promise(resolve => { resolveBuffer = resolve; }));
  pasteFiles([pending]);
  expect(pending.arrayBuffer).toHaveBeenCalledTimes(1);
  manager.destroy();
  resolveBuffer(new ArrayBuffer(4));
  const ignored = imageFile('ignored.png');
  for (const event of [
    createEvent.paste(input, { clipboardData: { items: [{ type: 'image/png', getAsFile: () => ignored }] } }),
    createEvent.dragEnter(wrapper, { dataTransfer: { types: ['Files'] } }),
    createEvent.dragOver(wrapper), createEvent.dragLeave(wrapper),
    createEvent.drop(wrapper, { dataTransfer: { files: [ignored] } }),
  ]) {
    fireEvent(event.type === 'paste' ? input : wrapper, event);
    expect(event.defaultPrevented).toBe(false);
  }
  // A new owner completes a fresh read while the destroyed owner's pending read settles.
  const original = manager;
  const oldChanged = changed;
  changed = vi.fn();
  manager = new ImageContextManager(new App().keymap, host, input, { onUserImagesChanged: changed });
  const processed = imagesChanged(1);
  pasteFiles([imageFile('fresh.png')]);
  await processed;
  expect(original.getAttachedImages()).toEqual([]);
  expect(oldChanged).not.toHaveBeenCalled();
  expect(ignored.arrayBuffer).not.toHaveBeenCalled();
  expect(manager.getAttachedImages().map(image => image.name)).toEqual(['fresh.png']);
});

it('opens the selected image from its named control and closes the preview on destruction', () => {
  manager.setImages([attachment()]);
  fireEvent.click(within(host).getByRole('button', { name: 'Image attachment: photo.png · 5 B' }));
  const preview = within(document.body).getByRole('dialog', { name: 'Image preview: photo.png' });
  expect(within(preview).getByRole('img', { name: 'photo.png' }).getAttribute('src')).toBe('data:image/png;base64,aGVsbG8=');
  manager.destroy();
  expect(within(document.body).queryByRole('dialog', { name: 'Image preview: photo.png' })).toBeNull();
});
