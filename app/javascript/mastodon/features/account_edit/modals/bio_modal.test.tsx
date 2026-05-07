import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IntlProvider } from 'react-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BioModal } from './bio_modal';

interface TestState {
  profileEdit: {
    profile?: {
      bio?: string;
    };
    isPending: boolean;
  };
  server: {
    getIn: (path: unknown[]) => number | undefined;
  };
}

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  state: {
    profileEdit: {
      profile: {
        bio: 'Existing bio',
      },
      isPending: false,
    },
    server: {
      getIn: vi.fn(() => 500),
    },
  },
}));

vi.mock('@/mastodon/store', () => ({
  useAppDispatch: () => mocks.dispatch,
  useAppSelector: (selector: (state: TestState) => unknown) =>
    selector(mocks.state),
}));

vi.mock('@/mastodon/components/form_fields', () => ({
  EmojiTextAreaField: function MockEmojiTextAreaField({
    value = '',
    label,
    maxLength,
    ...props
  }: {
    value?: string;
    label?: string;
    maxLength?: number;
    [key: string]: unknown;
  }) {
    const ariaLabel = label && label.length > 0 ? label : 'Bio';

    return (
      <textarea
        aria-label={ariaLabel}
        aria-labelledby={props['aria-labelledby'] as string | undefined}
        maxLength={maxLength}
        readOnly
        value={value}
      />
    );
  },
}));

describe('BioModal', () => {
  beforeEach(() => {
    mocks.dispatch.mockReset();
    mocks.dispatch.mockReturnValue(Promise.resolve());
    mocks.state.profileEdit = {
      profile: {
        bio: 'Existing bio',
      },
      isPending: false,
    };
    mocks.state.server.getIn.mockReturnValue(500);
  });

  it('closes once after saving the profile update', async () => {
    const onClose = vi.fn();
    let resolveSave!: () => void;

    mocks.dispatch.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveSave = resolve;
      }),
    );

    render(
      <IntlProvider locale='en'>
        <BioModal onClose={onClose} />
      </IntlProvider>,
    );

    expect(screen.getByLabelText('Bio')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    resolveSave();

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});
