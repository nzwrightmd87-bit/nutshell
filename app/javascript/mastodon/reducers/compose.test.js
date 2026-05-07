/* global describe, expect, it */

import { pasteLinkCompose } from '@/mastodon/actions/compose_typed';

import {
  COMPOSE_REPLY_CANCEL,
  COMPOSE_RESET,
  COMPOSE_SUBMIT_SUCCESS,
} from '../actions/compose';

import { composeReducer } from './compose';

const pendingPasteLinkAction = (requestId) => ({
  type: pasteLinkCompose.pending.type,
  meta: { requestId },
});

describe('compose reducer paste-link state', () => {
  it.each([
    ['compose reset', COMPOSE_RESET],
    ['reply cancel', COMPOSE_REPLY_CANCEL],
    ['submit success', COMPOSE_SUBMIT_SUCCESS],
  ])('clears fetching_link on %s', (_label, type) => {
    const requestId = 'req-abc';
    const pendingState = composeReducer(undefined, pendingPasteLinkAction(requestId))
      .set('text', 'https://example.com/statuses/1')
      .set('quoted_status_id', '1');

    const state = composeReducer(pendingState, { type });

    expect(state.get('fetching_link')).toBeNull();
    expect(state.get('quoted_status_id')).toBeNull();
    expect(state.get('text')).toBe('');
  });
});
