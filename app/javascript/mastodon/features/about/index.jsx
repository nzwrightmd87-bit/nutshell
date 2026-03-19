import PropTypes from 'prop-types';
import { PureComponent } from 'react';

import { defineMessages, injectIntl, FormattedMessage } from 'react-intl';

import { Helmet } from 'react-helmet';

import ImmutablePropTypes from 'react-immutable-proptypes';
import { connect } from 'react-redux';

import { fetchServer, fetchExtendedDescription } from 'mastodon/actions/server';
import { Account } from 'mastodon/components/account';
import Column from 'mastodon/components/column';
import { ServerHeroImage } from 'mastodon/components/server_hero_image';
import { Skeleton } from 'mastodon/components/skeleton';
import { LinkFooter} from 'mastodon/features/ui/components/link_footer';

import { Section } from './components/section';

const messages = defineMessages({
  title: { id: 'column.about', defaultMessage: 'About' },
  publicFeed: { id: 'about.section.public_feed', defaultMessage: 'The Public Feed' },
  privateMessaging: { id: 'about.section.private_messaging', defaultMessage: 'Private Messaging & Groups' },
  theVision: { id: 'about.section.the_vision', defaultMessage: 'The Vision' },
});

const mapStateToProps = state => ({
  server: state.getIn(['server', 'server']),
  locale: state.getIn(['meta', 'locale']),
  extendedDescription: state.getIn(['server', 'extendedDescription']),
});

class About extends PureComponent {

  static propTypes = {
    server: ImmutablePropTypes.map,
    locale: ImmutablePropTypes.string,
    extendedDescription: ImmutablePropTypes.map,
    dispatch: PropTypes.func.isRequired,
    intl: PropTypes.object.isRequired,
    multiColumn: PropTypes.bool,
  };

  componentDidMount () {
    const { dispatch } = this.props;
    dispatch(fetchServer());
    dispatch(fetchExtendedDescription());
  }

  render () {
    const { multiColumn, intl, server, extendedDescription } = this.props;
    const isLoading = server.get('isLoading');

    return (
      <Column bindToDocument={!multiColumn} label={intl.formatMessage(messages.title)}>
        <div className='scrollable about'>
          <div className='about__header'>
            <ServerHeroImage blurhash={server.getIn(['thumbnail', 'blurhash'])} src={server.getIn(['thumbnail', 'url'])} srcSet={server.getIn(['thumbnail', 'versions'])?.map((value, key) => `${value} ${key.replace('@', '')}`).join(', ')} className='about__header__hero' />
            <h1>{isLoading ? <Skeleton width='10ch' /> : server.get('domain')}</h1>
            <p><FormattedMessage id='about.powered_by' defaultMessage='Community-first social media powered by Nutshell.' /></p>
          </div>

          <div className='about__meta'>
            <div className='about__meta__column'>
              <h4><FormattedMessage id='server_banner.administered_by' defaultMessage='Administered by:' /></h4>

              <Account id={server.getIn(['contact', 'account', 'id'])} size={36} minimal />
            </div>

            <hr className='about__meta__divider' />

            <div className='about__meta__column'>
              <h4><FormattedMessage id='about.contact' defaultMessage='Contact:' /></h4>

              {isLoading ? <Skeleton width='10ch' /> : <a className='about__mail' href={`mailto:${server.getIn(['contact', 'email'])}`}>{server.getIn(['contact', 'email'])}</a>}
            </div>
          </div>

          <Section open title={intl.formatMessage(messages.publicFeed)}>
            <div className='prose'>
              <p><FormattedMessage id='about.public_feed.p1' defaultMessage='Nutshell is a community-first social platform where your posts appear on a shared public feed visible to all members. Think of it as a town square — a place to share ideas, start conversations, and discover what others in the community are talking about.' /></p>
              <p><FormattedMessage id='about.public_feed.p2' defaultMessage='Unlike algorithm-driven platforms, there is no invisible hand deciding what you see. Your timeline is chronological and unfiltered. You follow people because you want to hear from them, not because a recommendation engine told you to.' /></p>
              <p><FormattedMessage id='about.public_feed.p3' defaultMessage='Posts can include text, images, video, polls, and more. You control the visibility of every post — public to the community, or visible only to your followers.' /></p>
            </div>
          </Section>

          <Section open title={intl.formatMessage(messages.privateMessaging)}>
            <div className='prose'>
              <p><FormattedMessage id='about.private_messaging.p1' defaultMessage='Nutshell integrates with BlackEnvelope, an end-to-end encrypted (E2EE) messaging application. When you create a Nutshell account, you automatically get access to BlackEnvelope through single sign-on — no separate registration required.' /></p>
              <p><FormattedMessage id='about.private_messaging.p2' defaultMessage='BlackEnvelope provides truly private direct messages and group conversations. End-to-end encryption means that only the participants in a conversation can read the messages — not even the server administrators have access to the content.' /></p>
              <p><FormattedMessage id='about.private_messaging.p3' defaultMessage='Groups in BlackEnvelope let you organize private spaces around shared interests, projects, or teams. Create invite-only groups, share files, and have conversations that stay between members.' /></p>
              <p><FormattedMessage id='about.private_messaging.p4' defaultMessage='The public feed is for open conversation. BlackEnvelope is for everything else — the private discussions, the sensitive topics, the things that should stay between you and the people you trust.' /></p>
            </div>
          </Section>

          <Section open title={intl.formatMessage(messages.theVision)}>
            <div className='prose'>
              <p><FormattedMessage id='about.the_vision.p1' defaultMessage='Nutshell exists because we believe social media should serve its users, not exploit them. No ads. No data harvesting. No engagement algorithms designed to keep you angry and scrolling. You pay a membership fee, and in return you get a platform that works for you instead of against you.' /></p>
              <p><FormattedMessage id='about.the_vision.p2' defaultMessage='We built Nutshell on open-source software because transparency matters. The source code is publicly available for anyone to review, audit, or learn from. If you want to see exactly how your data is handled, you can read the code yourself.' /></p>
              <p><FormattedMessage id='about.the_vision.p3' defaultMessage='The combination of a public feed and end-to-end encrypted private messaging gives you the best of both worlds — a place to speak openly with your community, and a place to communicate privately when you need to. No platform should force you to choose between being social and being secure.' /></p>
              <p><FormattedMessage id='about.the_vision.p4' defaultMessage='Nutshell is not trying to replace every social network. It is building something different — a smaller, intentional community where members support the platform directly and the platform respects its members in return.' /></p>
            </div>
          </Section>

          {extendedDescription.get('content')?.length > 0 && (
            <Section title={intl.formatMessage(messages.title)}>
              <div
                className='prose'
                dangerouslySetInnerHTML={{ __html: extendedDescription.get('content') }}
              />
            </Section>
          )}

          <LinkFooter />

          <div className='about__footer'>
            <p><FormattedMessage id='about.disclaimer' defaultMessage='Nutshell is open-source software built for your community.' /></p>
          </div>
        </div>

        <Helmet>
          <title>{intl.formatMessage(messages.title)}</title>
          <meta name='robots' content='all' />
        </Helmet>
      </Column>
    );
  }

}

export default connect(mapStateToProps)(injectIntl(About));
