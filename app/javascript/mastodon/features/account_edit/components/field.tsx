import type { FC } from 'react';

import { EmojiText } from '@/mastodon/components/emoji/html';
import type { FieldData } from '@/mastodon/reducers/slices/profile_edit';

import classes from '../styles.module.scss';

export const AccountField: FC<FieldData> = (field) => {
  return (
    <>
      <EmojiText
        as='h2'
        text={field.name}
        className={classes.fieldName}
      />

      <EmojiText
        as='p'
        text={field.value}
        className={classes.fieldValue}
      />
    </>
  );
};
