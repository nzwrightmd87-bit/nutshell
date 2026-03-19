import { useState, useCallback } from 'react';

import classNames from 'classnames';
import { Link } from 'react-router-dom';

import { useHovering } from 'mastodon/hooks/useHovering';
import { autoPlayGif } from 'mastodon/initial_state';
import type { Account } from 'mastodon/models/account';
import {
  avatarPlaceholderColor,
  avatarPlaceholderFontSize,
  avatarPlaceholderInitial,
  isMissingAvatar,
} from 'mastodon/utils/avatar_placeholder';

import { useAccount } from '../hooks/useAccount';

interface Props {
  account:
    | Pick<
        Account,
        'id' | 'acct' | 'avatar' | 'avatar_static' | 'display_name' | 'username'
      >
    | undefined; // FIXME: remove `undefined` once we know for sure its always there
  size?: number;
  style?: React.CSSProperties;
  inline?: boolean;
  animate?: boolean;
  withLink?: boolean;
  counter?: number | string;
  counterBorderColor?: string;
  className?: string;
}

export const Avatar: React.FC<Props> = ({
  account,
  animate = autoPlayGif,
  size = 20,
  inline = false,
  withLink = false,
  style: styleFromParent,
  className,
  counter,
  counterBorderColor,
}) => {
  const { hovering, handleMouseEnter, handleMouseLeave } = useHovering(animate);
  const [error, setError] = useState(false);

  const style = {
    ...styleFromParent,
    width: `${size}px`,
    height: `${size}px`,
  };

  const src = hovering || animate ? account?.avatar : account?.avatar_static;
  const showInitialAvatar = error || isMissingAvatar(src);
  const fallbackStyle: React.CSSProperties = {
    backgroundColor: avatarPlaceholderColor(account),
    fontSize: avatarPlaceholderFontSize(size),
  };

  const handleError = useCallback(() => {
    setError(true);
  }, [setError]);

  const avatar = (
    <span
      className={classNames(className, 'account__avatar', {
        'account__avatar--inline': inline,
      })}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      style={style}
    >
      {showInitialAvatar ? (
        <span className='account__avatar__initials' style={fallbackStyle}>
          {avatarPlaceholderInitial(account)}
        </span>
      ) : (
        <img src={src} alt='' onError={handleError} />
      )}

      {counter && (
        <span
          className='account__avatar__counter'
          style={{ borderColor: counterBorderColor }}
        >
          {counter}
        </span>
      )}
    </span>
  );

  if (withLink) {
    return (
      <Link
        to={`/@${account?.acct}`}
        title={`@${account?.acct}`}
        data-hover-card-account={account?.id}
      >
        {avatar}
      </Link>
    );
  }

  return avatar;
};

export const AvatarById: React.FC<
  { accountId: string } & Omit<Props, 'account'>
> = ({ accountId, ...otherProps }) => {
  const account = useAccount(accountId);
  return <Avatar account={account} {...otherProps} />;
};
