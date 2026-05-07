import { describe, expect, it } from 'vitest';

import {
  collectionEditorRouteId,
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
