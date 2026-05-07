import { fromJS } from 'immutable';
import type { List as ImmutableList } from 'immutable';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { act, fireEvent, render, screen } from '@/testing/rendering';

import type { MediaAttachment } from '@/mastodon/models/status';

import { MediaModal } from './media_modal';

const mocks = vi.hoisted(() => ({
  springStarts: [] as { x: string }[],
  dragHandler: undefined as
    | ((state: {
        active: boolean;
        movement: [number, number];
        direction: [number, number];
        cancel: () => void;
      }) => void)
    | undefined,
}));

vi.mock('@react-spring/web', () => ({
  animated: {
    div: ({
      children,
      ...props
    }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  },
  useSpring: (initializer: () => { x: string }) => [
    initializer(),
    {
      start: (props: { x: string }) => {
        mocks.springStarts.push(props);
        return Promise.resolve();
      },
    },
  ],
}));

vi.mock('@use-gesture/react', () => ({
  useDrag: (
    handler: (state: {
      active: boolean;
      movement: [number, number];
      direction: [number, number];
      cancel: () => void;
    }) => void,
  ) => {
    mocks.dragHandler = handler;
    return () => ({});
  },
}));

vi.mock('mastodon/components/gifv', () => ({
  GIFV: () => null,
}));

vi.mock('mastodon/components/icon', () => ({
  Icon: () => null,
}));

vi.mock('mastodon/components/icon_button', () => ({
  IconButton: ({
    onClick,
    title,
  }: {
    onClick: () => void;
    title: string;
  }) => (
    <button aria-label={title} onClick={onClick} type='button'>
      {title}
    </button>
  ),
}));

vi.mock('mastodon/features/picture_in_picture/components/footer', () => ({
  Footer: () => null,
}));

vi.mock('mastodon/features/video', () => ({
  Video: () => null,
}));

vi.mock('./zoomable_image', () => ({
  ZoomableImage: ({ alt }: { alt: string }) => <div>{alt}</div>,
}));

const makeMedia = (): ImmutableList<MediaAttachment> =>
  fromJS([
    {
      type: 'image',
      url: 'https://example.test/first.jpg',
      blurhash: undefined,
      description: 'first media',
      meta: { original: { width: 800, height: 600 } },
    },
    {
      type: 'image',
      url: 'https://example.test/second.jpg',
      blurhash: undefined,
      description: 'second media',
      meta: { original: { width: 800, height: 600 } },
    },
  ]) as unknown as ImmutableList<MediaAttachment>;

const renderModal = () =>
  render(
    <MediaModal
      media={makeMedia()}
      index={0}
      onClose={vi.fn()}
      onChangeBackgroundColor={vi.fn()}
    />,
  );

describe('MediaModal', () => {
  beforeEach(() => {
    mocks.springStarts = [];
    mocks.dragHandler = undefined;
  });

  it('moves the spring when a pagination dot changes the selected media', () => {
    renderModal();

    fireEvent.click(screen.getByRole('button', { name: '2' }));

    expect(mocks.springStarts).toEqual([{ x: 'calc(-100% + 0px)' }]);
    expect(screen.getByRole('button', { name: '2' }).className).toContain(
      'active',
    );
  });

  it('settles to the new media index after a threshold swipe', () => {
    renderModal();
    const cancel = vi.fn();

    act(() => {
      mocks.dragHandler?.({
        active: true,
        movement: [500, 0],
        direction: [-1, 0],
        cancel,
      });
    });

    expect(cancel).toHaveBeenCalledOnce();
    expect(mocks.springStarts).toEqual([{ x: 'calc(-100% + 0px)' }]);
  });
});
