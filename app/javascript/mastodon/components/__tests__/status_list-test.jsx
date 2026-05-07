import { List as ImmutableList } from 'immutable';

import { render, screen } from '@/testing/rendering';

import StatusList from '../status_list';

vi.mock('../scrollable_list', async () => {
  const { forwardRef } = await vi.importActual('react');

  return {
    default: forwardRef(({ children }, _ref) => (
      <div data-testid='scrollable-list'>
        {children}
      </div>
    )),
  };
});

vi.mock('../status_quoted', () => ({
  // eslint-disable-next-line react/prop-types -- Test mock only needs the props passed by StatusList.
  StatusQuoteManager: ({ featured, id }) => (
    <article data-testid={featured ? `featured-${id}` : `status-${id}`}>
      {id}
    </article>
  ),
}));

vi.mock('@/mastodon/features/account_timeline/v2/pinned_statuses', () => ({
  PinnedShowAllButton: () => <button type='button'>View all pinned posts</button>,
}));

describe('<StatusList />', () => {
  it('renders featured statuses when the regular timeline is empty', () => {
    render(
      <StatusList
        scrollKey='account'
        statusIds={ImmutableList()}
        featuredStatusIds={ImmutableList(['pin-1'])}
        emptyMessage='No posts found'
        isLoading={false}
      />,
    );

    expect(screen.getByTestId('featured-pin-1')).toBeTruthy();
  });
});
