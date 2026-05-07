import type { CompactEmoji, ShortcodesDataset } from 'emojibase';

const database = vi.hoisted(() => {
  const cache = new Map<string, string>();

  return {
    cache,
    loadCacheValue: vi.fn((key: string) => Promise.resolve(cache.get(key))),
    putCacheValue: vi.fn((key: string, value: string) => {
      cache.set(key, value);
      return Promise.resolve();
    }),
    putEmojiData: vi.fn(() => Promise.resolve()),
    putCustomEmojiData: vi.fn(() => Promise.resolve()),
    putLegacyShortcodes: vi.fn(() => Promise.resolve()),
  };
});

vi.mock('./database', () => database);

const emojiModules = import.meta.glob<string>(
  '../../../../../node_modules/emojibase-data/**/compact.json',
  { query: '?url', import: 'default', eager: true },
);

const shortcodesModules = import.meta.glob<string>(
  '../../../../../node_modules/emojibase-data/**/shortcodes/cldr.json',
  { query: '?url', import: 'default', eager: true },
);

const enEmojiPath =
  emojiModules['../../../../../node_modules/emojibase-data/en/compact.json'];
const enShortcodesPath =
  shortcodesModules[
    '../../../../../node_modules/emojibase-data/en/shortcodes/cldr.json'
  ];

if (!enEmojiPath || !enShortcodesPath) {
  throw new Error('Missing en emoji fixture paths');
}

const compactEmoji: CompactEmoji = {
  group: 0,
  hexcode: '1F600',
  label: 'grinning face',
  order: 1,
  tags: ['face'],
  unicode: '😀',
};

const shortcodes: ShortcodesDataset = {
  '1F600': ['grinning'],
};

const jsonResponse = (data: object | object[], init?: ResponseInit) =>
  new Response(JSON.stringify(data), init);

const responseBodyFails = () =>
  new Response('not-json', {
    headers: {
      ETag: '"custom-v2"',
    },
  });

describe('emoji loader cache handling', () => {
  beforeEach(() => {
    database.cache.clear();
    database.loadCacheValue.mockClear();
    database.putCacheValue.mockClear();
    database.putEmojiData.mockClear();
    database.putCustomEmojiData.mockClear();
    database.putLegacyShortcodes.mockClear();

    vi.stubGlobal(
      'fetch',
      vi.fn((input: URL | RequestInfo) => {
        const requestUrl =
          input instanceof Request
            ? input.url
            : input instanceof URL
              ? input.href
              : input;
        const pathname = new URL(requestUrl, location.origin).pathname;

        if (pathname === enEmojiPath) {
          return Promise.resolve(jsonResponse([compactEmoji]));
        }

        if (pathname === enShortcodesPath) {
          return Promise.resolve(jsonResponse(shortcodes));
        }

        if (pathname === '/api/v1/custom_emojis') {
          return Promise.resolve(
            jsonResponse([], {
              headers: {
                ETag: '"custom-v2"',
              },
            }),
          );
        }

        throw new Error(`Unexpected fetch path ${pathname}`);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('refreshes emoji data when only the shortcode path is stale', async () => {
    database.cache.set('en', enEmojiPath);
    database.cache.set('en-shortcodes', '/old-shortcodes.json');

    const { importEmojiData } = await import('./loader');

    await expect(importEmojiData('en', true)).resolves.toBeDefined();

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(database.putEmojiData).toHaveBeenCalledTimes(1);
    expect(database.putCacheValue).toHaveBeenCalledWith('en', enEmojiPath);
    expect(database.putCacheValue).toHaveBeenCalledWith(
      'en-shortcodes',
      enShortcodesPath,
    );
  });

  it('refreshes emoji data when compact data is stale but shortcodes are cached', async () => {
    database.cache.set('en', '/old-compact.json');
    database.cache.set('en-shortcodes', enShortcodesPath);

    const { importEmojiData } = await import('./loader');

    await expect(importEmojiData('en', true)).resolves.toBeDefined();

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(database.putEmojiData).toHaveBeenCalledTimes(1);
    expect(database.putCacheValue).toHaveBeenCalledWith('en', enEmojiPath);
    expect(database.putCacheValue).toHaveBeenCalledWith(
      'en-shortcodes',
      enShortcodesPath,
    );
  });

  it('does not write path markers when emoji persistence fails', async () => {
    database.putEmojiData.mockRejectedValueOnce(new Error('idb failed'));

    const { importEmojiData } = await import('./loader');

    await expect(importEmojiData('en', true)).rejects.toThrow('idb failed');

    expect(database.putCacheValue).not.toHaveBeenCalled();
  });

  it('does not write the custom emoji etag when JSON parsing fails', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(responseBodyFails());

    const { importCustomEmojiData } = await import('./loader');

    await expect(importCustomEmojiData()).rejects.toThrow();

    expect(database.putCustomEmojiData).not.toHaveBeenCalled();
    expect(database.putCacheValue).not.toHaveBeenCalled();
  });

  it('stores the custom emoji etag only after persistence succeeds', async () => {
    database.putCustomEmojiData.mockRejectedValueOnce(new Error('idb failed'));

    const { importCustomEmojiData } = await import('./loader');

    await expect(importCustomEmojiData()).rejects.toThrow('idb failed');

    expect(database.putCacheValue).not.toHaveBeenCalled();
  });
});
