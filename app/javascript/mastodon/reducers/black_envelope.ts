import { createSlice } from '@reduxjs/toolkit';

import { apiFetchBlackEnvelopeUnreadCount } from '@/mastodon/api/black_envelope';
import { createAppAsyncThunk } from '@/mastodon/store/typed_functions';

export const fetchBlackEnvelopeUnreadCount = createAppAsyncThunk(
  'blackEnvelope/fetchUnreadCount',
  async () => {
    return apiFetchBlackEnvelopeUnreadCount();
  },
);

interface BlackEnvelopeState {
  unreadCount: number;
}

const initialState: BlackEnvelopeState = {
  unreadCount: 0,
};

const blackEnvelopeSlice = createSlice({
  name: 'blackEnvelope',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder.addCase(fetchBlackEnvelopeUnreadCount.fulfilled, (state, action) => {
      state.unreadCount = action.payload.unread_count;
    });
  },
});

export const blackEnvelopeReducer = blackEnvelopeSlice.reducer;
