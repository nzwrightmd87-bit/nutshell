import { joinShortcodes } from 'emojibase';
import type { CompactEmoji, Locale, ShortcodesDataset } from 'emojibase';

import {
  putEmojiData,
  putCustomEmojiData,
  putCacheValue,
  putLegacyShortcodes,
  loadCacheValue,
} from './database';
import { toSupportedLocale, toValidCacheKey } from './locale';
import type { CacheKey, CustomEmojiData } from './types';
import { emojiLogger } from './utils';

const log = emojiLogger('loader');

export async function importEmojiData(localeString: string, shortcodes = true) {
  const locale = toSupportedLocale(localeString);

  log(
    'importing emoji data for locale %s%s',
    locale,
    shortcodes ? ' and shortcodes' : '',
  );

  const emojiCache = toCacheRequest({
    key: locale,
    path: localeToEmojiPath(locale),
  });

  const shortcodesCache = shortcodes
    ? toCacheRequest({
        key: `${locale}-shortcodes`,
        path: localeToShortcodesPath(locale),
      })
    : null;

  const [emojiCacheCurrent, shortcodesCacheCurrent] = await Promise.all([
    isCacheCurrent(emojiCache),
    shortcodesCache ? isCacheCurrent(shortcodesCache) : true,
  ]);

  if (emojiCacheCurrent && shortcodesCacheCurrent) {
    log('emoji data for %s already loaded, skipping fetch', locale);
    return;
  }

  const emojiResponse = await fetchJson(emojiCache);
  if (!emojiResponse) {
    return;
  }
  let emojis = emojiResponse.data as CompactEmoji[];

  const shortcodesData: ShortcodesDataset[] = [];
  if (shortcodesCache) {
    const shortcodesResponse = await fetchJson(shortcodesCache);
    if (shortcodesResponse) {
      shortcodesData.push(shortcodesResponse.data as ShortcodesDataset);
    } else {
      throw new Error(`No shortcodes data found for locale ${locale}`);
    }
  }

  emojis = joinShortcodes(emojis, shortcodesData);

  await putEmojiData(emojis, locale);
  await putCacheValue(emojiCache.key, emojiCache.path);
  if (shortcodesCache) {
    await putCacheValue(shortcodesCache.key, shortcodesCache.path);
  }

  return emojis;
}

export async function importCustomEmojiData() {
  const response = await fetchAndCheckEtag({
    oldEtag: await loadCacheValue('custom'),
    path: '/api/v1/custom_emojis',
  });

  if (!response) {
    return;
  }

  const etag = response.headers.get('ETag');
  const emojis = (await response.json()) as CustomEmojiData[];
  await putCustomEmojiData({ emojis, clear: true });

  if (etag) {
    log('Custom emoji data fetched and stored successfully, storing etag %s', etag);
    await putCacheValue('custom', etag);
  } else {
    log('No etag found in response for custom emoji data');
  }

  return emojis;
}

export async function importLegacyShortcodes() {
  const globPaths = import.meta.glob<string>(
    // We use import.meta.glob to eagerly load the URL, as the regular import() doesn't work inside the Web Worker.
    '../../../../../node_modules/emojibase-data/en/shortcodes/iamcal.json',
    { eager: true, import: 'default', query: '?url' },
  );
  const path = Object.values(globPaths)[0];
  if (!path) {
    throw new Error('IAMCAL shortcodes path not found');
  }
  const shortcodesCache = toCacheRequest({
    key: 'shortcodes',
    path,
  });
  if (await isCacheCurrent(shortcodesCache)) {
    log('data for %s already loaded, skipping fetch', shortcodesCache.key);
    return;
  }

  const shortcodesResponse = await fetchJson(shortcodesCache);
  if (!shortcodesResponse) {
    return;
  }

  const shortcodesData = shortcodesResponse.data as ShortcodesDataset;
  await putLegacyShortcodes(shortcodesData);
  await putCacheValue(shortcodesCache.key, shortcodesCache.path);
  return Object.keys(shortcodesData);
}

function localeToEmojiPath(locale: Locale) {
  const key = `../../../../../node_modules/emojibase-data/${locale}/compact.json`;
  const emojiModules = import.meta.glob<string>(
    '../../../../../node_modules/emojibase-data/**/compact.json',
    {
      query: '?url',
      import: 'default',
      eager: true,
    },
  );
  const path = emojiModules[key];
  if (!path) {
    throw new Error(`Unsupported locale: ${locale}`);
  }
  return path;
}

function localeToShortcodesPath(locale: Locale) {
  const key = `../../../../../node_modules/emojibase-data/${locale}/shortcodes/cldr.json`;
  const shortcodesModules = import.meta.glob<string>(
    '../../../../../node_modules/emojibase-data/**/shortcodes/cldr.json',
    {
      query: '?url',
      import: 'default',
      eager: true,
    },
  );
  const path = shortcodesModules[key];
  if (!path) {
    throw new Error(`Unsupported locale for shortcodes: ${locale}`);
  }
  return path;
}

function toCacheRequest({
  key: rawKey,
  path,
}: {
  key: string;
  path: string;
}) {
  return {
    key: toValidCacheKey(rawKey),
    path,
  } satisfies {
    key: CacheKey;
    path: string;
  };
}

async function isCacheCurrent({ key, path }: { key: CacheKey; path: string }) {
  const value = await loadCacheValue(key);

  if (value === path) {
    return true;
  }

  return false;
}

async function fetchJson({
  key,
  path,
}: {
  key: CacheKey;
  path: string;
}): Promise<{ data: object[] | object } | null> {
  const response = await fetchAndCheckEtag({ path });
  if (!response) {
    return null;
  }

  const data = (await response.json()) as object[] | object;

  log('data for %s fetched successfully', key);
  return { data };
}

async function fetchAndCheckEtag({
  oldEtag,
  path,
}: {
  oldEtag?: string;
  path: string;
}) {
  const headers = new Headers({
    'Content-Type': 'application/json',
  });
  if (oldEtag) {
    headers.set('If-None-Match', oldEtag);
  }

  // Use location.origin as this script may be loaded from a CDN domain.
  const url = new URL(path, location.origin);
  const response = await fetch(url, {
    headers,
  });

  // If not modified, return null
  if (response.status === 304) {
    log('etag not modified for %s', path);
    return null;
  }

  if (!response.ok) {
    throw new Error(
      `Failed to fetch emoji data for ${path}: ${response.statusText}`,
    );
  }

  return response;
}
