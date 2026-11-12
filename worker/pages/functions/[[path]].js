/*
 * worker/pages/functions/[[path]].js - run the same API as a Pages Function.
 *
 * workers.dev is DNS-blocked by some Indonesian ISPs (see docs/CLOUDFLARE.md),
 * while pages.dev is reachable. Pages Functions receive the same env bindings,
 * so the handler in ../../src/index.js is reused unchanged.
 *
 * Only the API paths go to that handler. Everything else goes through
 * context.next(), so Pages can serve the static landing page in ../public -
 * a catch-all function otherwise intercepts "/" and returns the API's 404.
 */
import worker from '../../src/index.js';

const API = new Set(['/health', '/history', '/ingest']);

export const onRequest = (context) => {
  const { pathname } = new URL(context.request.url);
  if (!API.has(pathname)) return context.next();
  return worker.fetch(context.request, context.env);
};
