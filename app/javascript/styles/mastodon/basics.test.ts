import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('basic layout styles', () => {
  const basicsScssPath = [
    resolve(process.cwd(), 'app/javascript/styles/mastodon/basics.scss'),
    resolve(process.cwd(), 'styles/mastodon/basics.scss'),
  ].find((path) => existsSync(path));

  if (!basicsScssPath) {
    throw new Error('Could not find basics.scss');
  }

  const basicsScss = readFileSync(basicsScssPath, { encoding: 'utf8' });

  it('resets the header scroll offset for the actual multi-column body class', () => {
    expect(basicsScss).toContain('&:has(body.layout-multiple-columns)');
    expect(basicsScss).not.toContain('layout-multi-column');
  });
});
