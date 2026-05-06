import type { ApiCollectionJSON } from 'mastodon/api_types/collections';
import { me } from 'mastodon/initial_state';

type SensitiveCollectionFields = Pick<
  ApiCollectionJSON,
  'account_id' | 'sensitive'
>;

export const shouldGateSensitiveCollection = (
  collection: SensitiveCollectionFields | undefined,
) => Boolean(collection?.sensitive && collection.account_id !== me);
