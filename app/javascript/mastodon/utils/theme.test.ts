import { getIsSystemTheme, isDarkMode } from './theme';

describe('theme DOM helpers', () => {
  afterEach(() => {
    delete document.documentElement.dataset.colorScheme;
    delete document.documentElement.dataset.systemTheme;
    document.body.className = '';
  });

  it('detects dark mode from the html data attribute', () => {
    document.documentElement.dataset.colorScheme = 'dark';
    document.body.classList.add('theme-mastodon-light');

    expect(isDarkMode()).toBe(true);
  });

  it('detects system theme from the html data attribute', () => {
    document.documentElement.dataset.systemTheme = 'true';
    document.body.classList.add('theme-mastodon-light');

    expect(getIsSystemTheme()).toBe(true);
  });
});
