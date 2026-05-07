import { render, screen } from '@/testing/rendering';

import { MutedBadge } from './badge';

describe('MutedBadge', () => {
  it('falls back to the generic muted label for invalid expiration timestamps', () => {
    render(<MutedBadge expiresAt='10000-01-01T00:00:00Z' />);

    expect(screen.getByText('Muted')).toBeTruthy();
    expect(screen.queryByText(/Invalid Date/)).toBeNull();
  });

  it('formats valid expiration timestamps', () => {
    render(<MutedBadge expiresAt='2026-05-30T12:00:00Z' />);

    expect(screen.getByText(/Muted until/)).toBeTruthy();
  });
});
