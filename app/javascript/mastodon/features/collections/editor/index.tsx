import { useEffect, useRef } from 'react';

import { defineMessages, useIntl } from 'react-intl';

import { Helmet } from 'react-helmet';
import {
  Redirect,
  Switch,
  Route,
  useParams,
  useRouteMatch,
  matchPath,
  useLocation,
} from 'react-router-dom';

import ListAltIcon from '@/material-icons/400-24px/list_alt.svg?react';
import { Column } from 'mastodon/components/column';
import { ColumnHeader } from 'mastodon/components/column_header';
import { LoadingIndicator } from 'mastodon/components/loading_indicator';
import {
  collectionEditorActions,
  fetchCollection,
} from 'mastodon/reducers/slices/collections';
import { useAppDispatch, useAppSelector } from 'mastodon/store';

import { CollectionAccounts } from './accounts';
import { CollectionDetails } from './details';

export const messages = defineMessages({
  create: {
    id: 'collections.create_collection',
    defaultMessage: 'Create collection',
  },
  newCollection: {
    id: 'collections.new_collection',
    defaultMessage: 'New collection',
  },
  editDetails: {
    id: 'collections.edit_details',
    defaultMessage: 'Edit details',
  },
  manageAccounts: {
    id: 'collections.manage_accounts',
    defaultMessage: 'Manage accounts',
  },
});

export const collectionEditorRouteId = (id: string | undefined) => id ?? null;

export const shouldResetCollectionEditor = (
  previousRouteId: string | null | undefined,
  currentRouteId: string | null,
) => previousRouteId !== currentRouteId;

export const getCollectionEditorPageTitle = ({
  id,
  path,
  pathname,
}: {
  id: string | undefined;
  path: string;
  pathname: string;
}) => {
  if (!id) {
    return messages.newCollection;
  }

  if (matchPath(pathname, { path, exact: true })) {
    return messages.manageAccounts;
  } else if (matchPath(pathname, { path: `${path}/details`, exact: true })) {
    return messages.editDetails;
  } else {
    return messages.manageAccounts;
  }
};

function usePageTitle(id: string | undefined) {
  const { path } = useRouteMatch();
  const location = useLocation();

  return getCollectionEditorPageTitle({ id, path, pathname: location.pathname });
}

export const CollectionEditorPage: React.FC<{
  multiColumn?: boolean;
}> = ({ multiColumn }) => {
  const intl = useIntl();
  const dispatch = useAppDispatch();
  const { id } = useParams<{ id?: string }>();
  const { path, url } = useRouteMatch();
  const collection = useAppSelector((state) =>
    id ? state.collections.collections[id] : undefined,
  );
  const editorRouteId = collectionEditorRouteId(id);
  const previousEditorRouteIdRef = useRef<string | null>();
  const isEditMode = !!id;
  const isLoading = isEditMode && !collection;

  useEffect(() => {
    if (id) {
      void dispatch(fetchCollection({ collectionId: id }));
    }
  }, [dispatch, id]);

  useEffect(() => {
    if (
      shouldResetCollectionEditor(
        previousEditorRouteIdRef.current,
        editorRouteId,
      )
    ) {
      void dispatch(collectionEditorActions.reset());
    }

    previousEditorRouteIdRef.current = editorRouteId;
  }, [dispatch, editorRouteId]);

  useEffect(() => {
    if (collection) {
      void dispatch(collectionEditorActions.init(collection));
    }
  }, [dispatch, collection]);

  const pageTitle = intl.formatMessage(usePageTitle(id));

  return (
    <Column bindToDocument={!multiColumn} label={pageTitle}>
      <ColumnHeader
        title={pageTitle}
        icon='list-ul'
        iconComponent={ListAltIcon}
        multiColumn={multiColumn}
        showBackButton
      />

      <div className='scrollable'>
        {isLoading ? (
          <LoadingIndicator />
        ) : (
          <Switch>
            <Route
              exact
              path={path}
              // eslint-disable-next-line react/jsx-no-bind
              render={() => <CollectionAccounts collection={collection} />}
            />
            <Route
              exact
              path={`${path}/details`}
              // eslint-disable-next-line react/jsx-no-bind
              render={() => <CollectionDetails />}
            />
            <Route
              // eslint-disable-next-line react/jsx-no-bind
              render={() => <Redirect to={url} />}
            />
          </Switch>
        )}
      </div>

      <Helmet>
        <title>{pageTitle}</title>
        <meta name='robots' content='noindex' />
      </Helmet>
    </Column>
  );
};
