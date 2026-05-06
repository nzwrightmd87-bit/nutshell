import { render, screen } from '@/testing/rendering';

import { EmojiText } from './html';

describe('EmojiText', () => {
  it('renders raw HTML-looking text without parsing markup', () => {
    const input = '<a href="javascript:alert(1)">click</a>';
    const { container } = render(<EmojiText text={input} />);

    expect(screen.getByText(input)).toBeDefined();
    expect(container.querySelector('a')).toBeNull();
  });
});
