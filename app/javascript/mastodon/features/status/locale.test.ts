import { IntlMessageFormat } from 'intl-messageformat';

import laMessages from '../../locales/la.json';

describe('Latin status locale messages', () => {
  it('formats the mute action label with the supplied account name', () => {
    const muteLabel = new IntlMessageFormat(
      laMessages['status.mute'],
      'la',
    ).format({ name: 'alice' });

    expect(muteLabel).toBe('Tace @alice');
  });
});
