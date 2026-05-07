import { describe, expect, it } from 'vitest';

import {
  collectionEditorRouteId,
  getCollectionEditorPageTitle,
  messages,
  shouldResetCollectionEditor,
} from './index';

describe('collection editor route reset state', () => {
  it('normalizes new collection routes to an explicit null route id', () => {
    expect(collectionEditorRouteId(undefined)).toBeNull();
    expect(collectionEditorRouteId('123')).toBe('123');
  });

  it('resets on fresh new editor mounts without resetting between new-editor steps', () => {
    expect(shouldResetCollectionEditor(undefined, null)).toBe(true);
    expect(shouldResetCollectionEditor(null, null)).toBe(false);
  });

  it('resets when the edited collection id changes', () => {
    expect(shouldResetCollectionEditor(null, '123')).toBe(true);
    expect(shouldResetCollectionEditor('123', '123')).toBe(false);
    expect(shouldResetCollectionEditor('123', '456')).toBe(true);
  });
});

describe('collection editor page title routing', () => {
  const path = '/collections/:id/edit';

  it('uses the manage accounts title for the edit route', () => {
    expect(
      getCollectionEditorPageTitle({
        id: '123',
        path,
        pathname: '/collections/123/edit',
      }),
    ).toBe(messages.manageAccounts);
  });

  it('uses the details title for the exact details route', () => {
    expect(
      getCollectionEditorPageTitle({
        id: '123',
        path,
        pathname: '/collections/123/edit/details',
      }),
    ).toBe(messages.editDetails);
  });

  it('falls back instead of throwing for malformed edit subroutes', () => {
    expect(
      getCollectionEditorPageTitle({
        id: '123',
        path,
        pathname: '/collections/123/edit/foo',
      }),
    ).toBe(messages.manageAccounts);
  });

  it('does not treat malformed details subroutes as the details page', () => {
    expect(
      getCollectionEditorPageTitle({
        id: '123',
        path,
        pathname: '/collections/123/edit/details/foo',
      }),
    ).toBe(messages.manageAccounts);
  });
});
