import { act, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryHistory } from 'history';
import { IntlProvider } from 'react-intl';
import { Router, Route } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { List } from 'mastodon/models/list';
import { createList as createListRecord } from 'mastodon/models/list';

import NewListWrapper from './new';

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  fetchList: vi.fn((id: string) => ({ payload: id, type: 'lists/fetch' })),
  updateList: vi.fn((list: Partial<List>) => ({
    payload: list,
    type: 'lists/update',
  })),
  createList: vi.fn((list: Partial<List>) => ({
    payload: list,
    type: 'lists/create',
  })),
  apiGetAccounts: vi.fn(() => new Promise(() => undefined)),
  lists: new Map<string, List>(),
}));

vi.mock('mastodon/actions/lists', () => ({
  fetchList: mocks.fetchList,
}));

vi.mock('mastodon/actions/lists_typed', () => ({
  createList: mocks.createList,
  updateList: mocks.updateList,
}));

vi.mock('mastodon/api/lists', () => ({
  apiGetAccounts: mocks.apiGetAccounts,
}));

vi.mock('mastodon/components/avatar', () => ({
  Avatar: () => null,
}));

vi.mock('mastodon/components/avatar_group', () => ({
  AvatarGroup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock('mastodon/components/column', () => ({
  Column: ({ children }: { children: React.ReactNode }) => (
    <section>{children}</section>
  ),
}));

vi.mock('mastodon/components/column_header', () => ({
  ColumnHeader: () => null,
}));

vi.mock('mastodon/components/icon', () => ({
  Icon: () => null,
}));

vi.mock('mastodon/components/loading_indicator', () => ({
  LoadingIndicator: () => <span>Loading</span>,
}));

vi.mock('mastodon/components/form_fields', () => ({
  SelectField: ({
    children,
    id,
    label,
    onChange,
    value,
  }: {
    children: React.ReactNode;
    id: string;
    label: React.ReactNode;
    onChange: React.ChangeEventHandler<HTMLSelectElement>;
    value: string;
  }) => (
    <label htmlFor={id}>
      {label}
      <select id={id} onChange={onChange} value={value}>
        {children}
      </select>
    </label>
  ),
  TextInputField: ({
    id,
    label,
    maxLength,
    onChange,
    required,
    value,
  }: {
    id: string;
    label: React.ReactNode;
    maxLength?: number;
    onChange: React.ChangeEventHandler<HTMLInputElement>;
    required?: boolean;
    value: string;
  }) => (
    <label htmlFor={id}>
      {label}
      <input
        id={id}
        maxLength={maxLength}
        onChange={onChange}
        required={required}
        value={value}
      />
    </label>
  ),
}));

vi.mock('mastodon/store', () => ({
  useAppDispatch: () => mocks.dispatch,
  useAppSelector: (
    selector: (state: { lists: Map<string, List> }) => unknown,
  ) => selector({ lists: mocks.lists }),
}));

describe('NewListWrapper', () => {
  beforeEach(() => {
    mocks.dispatch.mockReset();
    mocks.dispatch.mockReturnValue(new Promise(() => undefined));
    mocks.fetchList.mockClear();
    mocks.updateList.mockClear();
    mocks.createList.mockClear();
    mocks.apiGetAccounts.mockClear();
    mocks.apiGetAccounts.mockReturnValue(new Promise(() => undefined));
    mocks.lists = new Map([
      [
        'list-a',
        createListRecord({
          id: 'list-a',
          title: 'Alpha title',
          exclusive: true,
          replies_policy: 'none',
        }),
      ],
      [
        'list-b',
        createListRecord({
          id: 'list-b',
          title: 'Beta title',
          exclusive: false,
          replies_policy: 'followed',
        }),
      ],
    ]);
  });

  it('remounts cached edit forms when the route list id changes', () => {
    const history = createMemoryHistory({
      initialEntries: ['/lists/list-a/edit'],
    });

    render(
      <IntlProvider locale='en'>
        <Router history={history}>
          <Route path='/lists/:id/edit'>
            <NewListWrapper />
          </Route>
        </Router>
      </IntlProvider>,
    );

    expect(screen.getByLabelText<HTMLInputElement>('List name').value).toBe(
      'Alpha title',
    );
    expect(screen.getByRole<HTMLInputElement>('checkbox').checked).toBe(true);
    expect(
      screen.getByLabelText<HTMLSelectElement>(
        'Include replies from list members to',
      ).value,
    ).toBe('none');

    act(() => {
      history.push('/lists/list-b/edit');
    });

    expect(screen.getByLabelText<HTMLInputElement>('List name').value).toBe(
      'Beta title',
    );
    expect(screen.getByRole<HTMLInputElement>('checkbox').checked).toBe(false);
    expect(
      screen.getByLabelText<HTMLSelectElement>(
        'Include replies from list members to',
      ).value,
    ).toBe('followed');

    const form = screen.getByRole('button', { name: 'Save' }).closest('form');
    if (!form) {
      throw new Error('Expected list edit form to be present');
    }
    fireEvent.submit(form);

    expect(mocks.updateList).toHaveBeenCalledWith({
      id: 'list-b',
      title: 'Beta title',
      exclusive: false,
      replies_policy: 'followed',
    });
  });
});
