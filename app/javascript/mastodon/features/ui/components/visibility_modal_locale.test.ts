import { IntlMessageFormat } from 'intl-messageformat';

import nanTwMessages from '../../../locales/nan-TW.json';

describe('nan-TW visibility modal locale messages', () => {
  it('formats rich-text instructions with a balanced link placeholder', () => {
    const instructions = new IntlMessageFormat(
      nanTwMessages['visibility_modal.instructions'],
      'nan-TW',
    ).format({
      link: (chunks) =>
        ['[', ...chunks.filter((chunk): chunk is string => typeof chunk === 'string'), ']'].join(''),
    });

    expect(instructions).toContain('[偏愛ê設定 > PO文預設]');
    expect(instructions).not.toContain('<link>');
  });
});
