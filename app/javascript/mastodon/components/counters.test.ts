import { IntlMessageFormat } from 'intl-messageformat';

import frCaMessages from '../locales/fr-CA.json';
import frMessages from '../locales/fr.json';

describe('French counter locale messages', () => {
  it.each([
    ['fr', frMessages],
    ['fr-CA', frCaMessages],
  ])('formats the familiar-followers counter for %s', (locale, messages) => {
    const oneFollower = new IntlMessageFormat(
      messages['account.followers_you_know_counter'],
      locale,
    ).format({ count: 1, counter: '1' });
    const multipleFollowers = new IntlMessageFormat(
      messages['account.followers_you_know_counter'],
      locale,
    ).format({ count: 2, counter: '2' });

    expect(oneFollower).toBe('1 suivi·e');
    expect(multipleFollowers).toBe('2 suivi·e·s');
  });
});
