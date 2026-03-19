import ready from '../mastodon/ready';

ready(() => {
  const image = document.querySelector<HTMLImageElement>('img');

  if (!image) return;

  image.src = '/nutshell-oops.svg';
}).catch((e: unknown) => {
  console.error(e);
});
