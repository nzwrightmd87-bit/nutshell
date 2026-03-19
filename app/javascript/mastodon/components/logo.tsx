import classNames from 'classnames';

import logo from '@/images/logo.svg';
import icon from '@/images/logo-symbol-icon.svg';
import stacked from '@/images/logo-stacked.svg';
import wordmark from '@/images/logo-symbol-wordmark.svg';

export const WordmarkLogo: React.FC = () => (
  <img src={wordmark} alt='Nutshell' className='logo logo--wordmark' />
);

export const IconLogo: React.FC<{ className?: string }> = ({ className }) => (
  <img src={icon} alt='Nutshell' className={classNames('logo logo--icon', className)} />
);

export const StackedLogo: React.FC<{ className?: string }> = ({ className }) => (
  <img src={stacked} alt='Nutshell' className={classNames('logo logo--stacked', className)} />
);

export const SymbolLogo: React.FC = () => (
  <img src={logo} alt='Nutshell' className='logo logo--icon' />
);
