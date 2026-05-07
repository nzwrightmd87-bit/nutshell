import { IntlMessageFormat } from 'intl-messageformat';

import euMessages from '../../locales/eu.json';

describe('Basque annual report locale messages', () => {
  it('formats supplied annual report values', () => {
    const title = new IntlMessageFormat(
      euMessages['annual_report.announcement.title'],
      'eu',
    ).format({ year: '2025' });
    const shareMessage = new IntlMessageFormat(
      euMessages['annual_report.summary.share_message'],
      'eu',
    ).format({ archetype: 'Arkularia' });

    expect(title).toBe('Hemen da 2025(e)ko Wrapstodon');
    expect(shareMessage).toBe('Arkularia arketipoa daukat!');
  });
});
