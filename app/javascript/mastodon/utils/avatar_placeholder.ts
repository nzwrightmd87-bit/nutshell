type AccountLike =
  | {
      id?: string;
      acct?: string;
      username?: string;
      display_name?: string;
      get?: (key: string) => unknown;
    }
  | undefined;

const readAccountString = (account: AccountLike, key: string): string => {
  if (!account) return '';

  const value =
    typeof account.get === 'function'
      ? account.get(key)
      : (account as Record<string, unknown>)[key];

  return typeof value === 'string' ? value : '';
};

const hashString = (value: string): number => {
  let hash = 0;

  for (const char of value) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) | 0;
  }

  return Math.abs(hash);
};

export const isMissingAvatar = (path?: string | null): boolean => {
  if (!path) return true;

  const normalizedPath = (path.split('?')[0] ?? path).toLowerCase();
  return normalizedPath.endsWith('/avatars/original/missing.png');
};

export const avatarPlaceholderInitial = (account: AccountLike): string => {
  const displayName = readAccountString(account, 'display_name').trim();
  const username = readAccountString(account, 'username').trim();
  const acct = readAccountString(account, 'acct').trim();
  const [acctLocalPart = ''] = acct.split('@');
  const source =
    displayName.length > 0
      ? displayName
      : username.length > 0
        ? username
        : acctLocalPart.length > 0
          ? acctLocalPart
          : '?';
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const first = segmenter.segment(source)[Symbol.iterator]().next().value;
  const initial = first?.segment ?? '?';

  return initial.toUpperCase();
};

export const avatarPlaceholderColor = (account: AccountLike): string => {
  const seed =
    readAccountString(account, 'id') ||
    readAccountString(account, 'acct') ||
    readAccountString(account, 'username') ||
    'nutshell';
  const hue = hashString(seed) % 360;

  return `hsl(${hue}deg 68% 46%)`;
};

export const avatarPlaceholderFontSize = (size: number): string =>
  `${Math.max(11, Math.floor(size * 0.45))}px`;
