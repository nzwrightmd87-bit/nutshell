import type { LayoutType } from '@/mastodon/is_mobile';

const MOBILE_NAV_ROOT_MARGIN = '0px 0px -55px 0px';
const DEFAULT_ROOT_MARGIN = '0px';

export const accountHeaderObserverOptions = (
  layout: LayoutType,
): IntersectionObserverInit => ({
  rootMargin: layout === 'mobile' ? MOBILE_NAV_ROOT_MARGIN : DEFAULT_ROOT_MARGIN,
});
