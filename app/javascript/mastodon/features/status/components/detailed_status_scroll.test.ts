import { shouldScrollDetailedStatus } from './detailed_status_scroll';

describe('shouldScrollDetailedStatus', () => {
  it('does not scroll when thread ancestor props are omitted', () => {
    expect(shouldScrollDetailedStatus(undefined, undefined)).toBe(false);
  });

  it('does not scroll when ancestors are first supplied on mount', () => {
    expect(shouldScrollDetailedStatus(undefined, 0)).toBe(false);
  });

  it('scrolls only when explicit ancestor count increases', () => {
    expect(shouldScrollDetailedStatus(0, 1)).toBe(true);
    expect(shouldScrollDetailedStatus(1, 1)).toBe(false);
    expect(shouldScrollDetailedStatus(2, 1)).toBe(false);
  });
});
