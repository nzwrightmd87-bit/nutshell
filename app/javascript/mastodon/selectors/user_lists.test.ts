import { List as ImmutableList, Map as ImmutableMap } from 'immutable';

import type { RootState } from 'mastodon/store';

import { selectUserListWithoutMe } from './user_lists';

const buildState = (list: ImmutableMap<string, unknown>) =>
  ({
    meta: ImmutableMap({ me: 'me' }),
    user_lists: ImmutableMap({
      following: ImmutableMap({
        alice: list,
      }),
    }),
  }) as unknown as RootState;

describe('selectUserListWithoutMe', () => {
  it('filters the current account and derives pagination from the reducer next key', () => {
    const list = ImmutableMap({
      items: ImmutableList(['me', 'bob']),
      isLoading: false,
      next: '/api/v1/accounts/alice/following?max_id=2',
    });

    expect(selectUserListWithoutMe(buildState(list), 'following', 'alice')).toEqual(
      {
        items: ['bob'],
        isLoading: false,
        hasMore: true,
      },
    );
  });

  it('does not report more pages when the reducer next key is empty', () => {
    const list = ImmutableMap({
      items: ImmutableList(['me']),
      isLoading: false,
      next: null,
    });

    expect(selectUserListWithoutMe(buildState(list), 'following', 'alice')).toEqual(
      {
        items: [],
        isLoading: false,
        hasMore: false,
      },
    );
  });
});
