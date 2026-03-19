import PropTypes from 'prop-types';
import { PureComponent } from 'react';

import { injectIntl } from 'react-intl';

import { Link } from 'react-router-dom';

import { connect } from 'react-redux';

import { fetchServer } from 'mastodon/actions/server';
import { StackedLogo } from 'mastodon/components/logo';
import { Skeleton } from 'mastodon/components/skeleton';

const mapStateToProps = state => ({
  server: state.getIn(['server', 'server']),
});

class ServerBanner extends PureComponent {

  static propTypes = {
    server: PropTypes.object,
    dispatch: PropTypes.func,
    intl: PropTypes.object,
  };

  componentDidMount () {
    const { dispatch } = this.props;
    dispatch(fetchServer());
  }

  render () {
    const { server } = this.props;
    const isLoading = server.get('isLoading');

    return (
      <div className='server-banner'>
        <Link to='/' className='server-banner__logo'>
          <StackedLogo />
        </Link>

        <div className='server-banner__description'>
          {isLoading ? (
            <>
              <Skeleton width='100%' />
              <br />
              <Skeleton width='100%' />
              <br />
              <Skeleton width='70%' />
            </>
          ) : server.get('description')}
        </div>
      </div>
    );
  }

}

export default connect(mapStateToProps)(injectIntl(ServerBanner));
