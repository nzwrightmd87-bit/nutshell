import { accountHeaderObserverOptions } from './account_header_visibility';

describe('accountHeaderObserverOptions', () => {
  it('uses the bottom-nav offset on mobile', () => {
    expect(accountHeaderObserverOptions('mobile')).toEqual({
      rootMargin: '0px 0px -55px 0px',
    });
  });

  it.each(['single-column', 'multi-column'] as const)(
    'uses a valid zero root margin on %s layout',
    (layout) => {
      expect(accountHeaderObserverOptions(layout)).toEqual({
        rootMargin: '0px',
      });
    },
  );
});
