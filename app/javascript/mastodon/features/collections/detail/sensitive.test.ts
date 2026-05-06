import { describe, expect, it, vi } from 'vitest';

import { shouldGateSensitiveCollection } from './sensitive';

vi.mock('mastodon/initial_state', () => ({
  me: 'viewer-account',
}));

describe('shouldGateSensitiveCollection', () => {
  it('gates sensitive collections owned by another account', () => {
    expect(
      shouldGateSensitiveCollection({
        account_id: 'collection-owner',
        sensitive: true,
      }),
    ).toBe(true);
  });

  it('does not gate non-sensitive collections', () => {
    expect(
      shouldGateSensitiveCollection({
        account_id: 'collection-owner',
        sensitive: false,
      }),
    ).toBe(false);
  });

  it("does not gate the current account's own sensitive collections", () => {
    expect(
      shouldGateSensitiveCollection({
        account_id: 'viewer-account',
        sensitive: true,
      }),
    ).toBe(false);
  });
});
