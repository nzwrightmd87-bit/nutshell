import { useCallback, useState } from 'react';

import { useHovering } from 'mastodon/hooks/useHovering';
import { autoPlayGif } from 'mastodon/initial_state';
import type { Account } from 'mastodon/models/account';
import {
  avatarPlaceholderColor,
  avatarPlaceholderFontSize,
  avatarPlaceholderInitial,
  isMissingAvatar,
} from 'mastodon/utils/avatar_placeholder';

interface Props {
  account: Account | undefined; // FIXME: remove `undefined` once we know for sure its always there
  friend: Account | undefined; // FIXME: remove `undefined` once we know for sure its always there
  size?: number;
  baseSize?: number;
  overlaySize?: number;
}

export const AvatarOverlay: React.FC<Props> = ({
  account,
  friend,
  size = 46,
  baseSize = 36,
  overlaySize = 24,
}) => {
  const [isBaseAvatarBroken, setIsBaseAvatarBroken] = useState(false);
  const [isOverlayAvatarBroken, setIsOverlayAvatarBroken] = useState(false);
  const { hovering, handleMouseEnter, handleMouseLeave } =
    useHovering(autoPlayGif);
  const accountSrc = hovering
    ? account?.get('avatar')
    : account?.get('avatar_static');
  const friendSrc = hovering
    ? friend?.get('avatar')
    : friend?.get('avatar_static');
  const accountImageSrc = typeof accountSrc === 'string' ? accountSrc : '';
  const friendImageSrc = typeof friendSrc === 'string' ? friendSrc : '';

  const handleBaseAvatarError = useCallback(() => {
    setIsBaseAvatarBroken(true);
  }, [setIsBaseAvatarBroken]);

  const handleOverlayAvatarError = useCallback(() => {
    setIsOverlayAvatarBroken(true);
  }, [setIsOverlayAvatarBroken]);

  const showBaseInitialAvatar =
    isBaseAvatarBroken || isMissingAvatar(accountImageSrc);
  const showOverlayInitialAvatar =
    isOverlayAvatarBroken || isMissingAvatar(friendImageSrc);

  return (
    <div
      className='account__avatar-overlay'
      style={{ width: size, height: size }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div className='account__avatar-overlay-base'>
        <div
          className='account__avatar'
          style={{ width: `${baseSize}px`, height: `${baseSize}px` }}
        >
          {showBaseInitialAvatar ? (
            <span
              className='account__avatar__initials'
              style={{
                backgroundColor: avatarPlaceholderColor(account),
                fontSize: avatarPlaceholderFontSize(baseSize),
              }}
            >
              {avatarPlaceholderInitial(account)}
            </span>
          ) : (
            <img
              src={accountImageSrc}
              alt={account?.get('acct')}
              onError={handleBaseAvatarError}
            />
          )}
        </div>
      </div>
      <div className='account__avatar-overlay-overlay'>
        <div
          className='account__avatar'
          style={{ width: `${overlaySize}px`, height: `${overlaySize}px` }}
        >
          {showOverlayInitialAvatar ? (
            <span
              className='account__avatar__initials'
              style={{
                backgroundColor: avatarPlaceholderColor(friend),
                fontSize: avatarPlaceholderFontSize(overlaySize),
              }}
            >
              {avatarPlaceholderInitial(friend)}
            </span>
          ) : (
            <img
              src={friendImageSrc}
              alt={friend?.get('acct')}
              onError={handleOverlayAvatarError}
            />
          )}
        </div>
      </div>
    </div>
  );
};
