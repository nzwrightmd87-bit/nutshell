import { profileEdit } from './profile_edit';

const setSearchQuery = (query: string) => ({
  payload: query,
  type: 'profileEdit/setSearchQuery',
});

describe('profileEdit search reducer', () => {
  it('does not leave blank tag searches loading', () => {
    const state = profileEdit(undefined, setSearchQuery('   '));

    expect(state.search).toEqual({
      query: '   ',
      isLoading: false,
      results: undefined,
    });
  });

  it('marks non-blank tag searches loading while results are fetched', () => {
    const state = profileEdit(undefined, setSearchQuery('security'));

    expect(state.search).toEqual({
      query: 'security',
      isLoading: true,
      results: undefined,
    });
  });
});
