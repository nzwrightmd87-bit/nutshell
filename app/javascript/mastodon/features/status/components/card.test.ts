import { describe, expect, it } from 'vitest';

import { handleIframeUrl } from './card';

const parseIframe = (html: string) =>
  new DOMParser()
    .parseFromString(html, 'text/html')
    .documentElement.querySelector('iframe');

describe('status card iframe handling', () => {
  it('does not override document referrer policy for YouTube embeds', () => {
    const html = handleIframeUrl(
      '<iframe src="https://www.youtube.com/embed/video-id"></iframe>',
      'https://www.youtube.com/watch?v=video-id&t=42',
      'YouTube',
    );

    const iframe = parseIframe(html);

    expect(iframe?.getAttribute('referrerpolicy')).toBeNull();
    expect(iframe?.src).toContain('autoplay=1');
    expect(iframe?.src).toContain('auto_play=1');
    expect(iframe?.src).toContain('start=42');
  });
});
