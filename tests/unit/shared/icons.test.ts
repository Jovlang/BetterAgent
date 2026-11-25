/** @vitest-environment jsdom */

import {
  ANTIGRAVITY_PROVIDER_ICON,
  createProviderIconSvg,
  OPENAI_PROVIDER_ICON,
} from '@/shared/icons';

describe('createProviderIconSvg', () => {
  it('renders path-based provider icons with currentColor fill', () => {
    const svg = createProviderIconSvg(OPENAI_PROVIDER_ICON, {
      className: 'test-icon',
      height: 12,
      parent: document.body,
      width: 12,
    });

    expect(svg.getAttribute('viewBox')).toBe(OPENAI_PROVIDER_ICON.viewBox);
    expect(svg.getAttribute('width')).toBe('12');
    expect(svg.getAttribute('height')).toBe('12');
    expect(svg.classList.contains('claudian-provider-icon')).toBe(true);
    expect(svg.classList.contains('test-icon')).toBe(true);

    const path = svg.querySelector('path');
    expect(path).not.toBeNull();
    expect(path?.getAttribute('fill')).toBe('currentColor');
  });

  it('keeps each full-colour Antigravity icon\'s mask and blur references inside its own SVG', () => {
    const first = createProviderIconSvg(ANTIGRAVITY_PROVIDER_ICON, { parent: document.body });
    const second = createProviderIconSvg(ANTIGRAVITY_PROVIDER_ICON, { parent: document.body });
    document.body.append(first, second);

    for (const svg of [first, second]) {
      expect(svg.querySelectorAll('mask')).toHaveLength(1);
      expect(svg.querySelectorAll('filter feGaussianBlur')).toHaveLength(11);
      expect(svg.querySelectorAll('[fill="#FC413D"], [fill="#00B95C"], [fill="#FFE432"]').length).toBeGreaterThan(0);
      const references = Array.from(svg.querySelectorAll('[mask], [filter]'))
        .flatMap(element => [element.getAttribute('mask'), element.getAttribute('filter')])
        .filter((value): value is string => Boolean(value));
      expect(references).toHaveLength(12);
      for (const reference of references) {
        const id = /^url\(#(.+)\)$/.exec(reference)?.[1];
        expect(id).toBeDefined();
        // A duplicate id would make the second icon borrow the first icon's mask or blur.
        expect(document.querySelectorAll(`[id="${id}"]`)).toHaveLength(1);
        expect(svg.querySelector(`[id="${id}"]`)).not.toBeNull();
      }
    }
    first.remove();
    second.remove();
  });
});
