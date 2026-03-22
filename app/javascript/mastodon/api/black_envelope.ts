import { apiRequestGet } from 'mastodon/api';

export const apiFetchBlackEnvelopeUnreadCount = () =>
  apiRequestGet<{ unread_count: number }>('v1/black_envelope/notifications/unread_count');
