/*
 * worker/pages/functions/[[path]].js - run the same API as a Pages Function.
 *
 * workers.dev is DNS-blocked by some Indonesian ISPs (see docs/CLOUDFLARE.md),
 * while pages.dev is reachable. Pages Functions receive the same env bindings,
 * so the handler in ../../src/index.js is reused unchanged.
 */
import worker from '../../src/index.js';

export const onRequest = (context) => worker.fetch(context.request, context.env);
