import { render, screen } from '@/testing/rendering';

import { EmojiTextAreaField, EmojiTextInputField } from './emoji_text_field';

vi.mock('../emoji/picker_button', () => ({
  EmojiPickerButton: ({ disabled }: { disabled?: boolean }) => (
    <button type='button' aria-label='Pick emoji' disabled={disabled} />
  ),
}));

describe('Emoji text fields', () => {
  it('disables the native input and emoji picker button', () => {
    render(
      <EmojiTextInputField
        label='Display name'
        value='Nutshell'
        disabled
      />,
    );

    const input = screen.getByRole('textbox', {
      name: 'Display name',
    });
    const emojiButton = screen.getByRole('button', {
      name: 'Pick emoji',
    });

    expect(input).toHaveProperty('disabled', true);
    expect(emojiButton).toHaveProperty('disabled', true);
  });

  it('disables the native textarea and emoji picker button', () => {
    render(<EmojiTextAreaField label='Bio' value='Hello' disabled />);

    const textarea = screen.getByRole('textbox', {
      name: 'Bio',
    });
    const emojiButton = screen.getByRole('button', {
      name: 'Pick emoji',
    });

    expect(textarea).toHaveProperty('disabled', true);
    expect(emojiButton).toHaveProperty('disabled', true);
  });
});
