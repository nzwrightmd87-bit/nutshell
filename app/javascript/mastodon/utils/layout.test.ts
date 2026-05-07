import { isRtlLayout } from './layout';

describe('isRtlLayout', () => {
  afterEach(() => {
    document.documentElement.className = '';
    document.body.className = '';
  });

  it('detects RTL layout from the html element', () => {
    document.documentElement.classList.add('rtl');

    expect(isRtlLayout()).toBe(true);
  });

  it('does not require the legacy body rtl class', () => {
    document.documentElement.classList.add('rtl');
    document.body.classList.remove('rtl');

    expect(isRtlLayout()).toBe(true);
  });

  it('ignores the legacy body rtl class', () => {
    document.body.classList.add('rtl');

    expect(isRtlLayout()).toBe(false);
  });

  it('returns false when neither layout root is rtl', () => {
    expect(isRtlLayout()).toBe(false);
  });
});
