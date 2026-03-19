import { FormattedMessage } from 'react-intl';

import nutshellMascot from '@/images/nutshell_mascot.svg';

export const RegenerationIndicator: React.FC = () => (
  <div className='regeneration-indicator'>
    <img
      src={nutshellMascot}
      className='regeneration-indicator__figure'
      alt=''
      role='presentation'
    />

    <div className='regeneration-indicator__label'>
      <strong>
        <FormattedMessage
          id='regeneration_indicator.preparing_your_home_feed'
          defaultMessage='Preparing your home feed…'
        />
      </strong>
      <FormattedMessage
        id='regeneration_indicator.please_stand_by'
        defaultMessage='Please stand by.'
      />
    </div>
  </div>
);
