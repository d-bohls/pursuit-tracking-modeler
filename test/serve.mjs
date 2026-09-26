// Builds the app and serves the production build on a free local port, so
// the browser tests run against exactly what is deployed.

import { build, preview } from 'vite';

export async function serve() {
  await build({ logLevel: 'warn' });
  const server = await preview({ logLevel: 'warn', preview: { port: 0 } });
  return {
    url: server.resolvedUrls.local[0],
    close: () => new Promise((resolve) => server.httpServer.close(resolve)),
  };
}
