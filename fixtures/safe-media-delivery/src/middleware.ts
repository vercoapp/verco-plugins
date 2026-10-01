import { defineMiddleware } from 'astro:middleware';
import { createFixtureStorage } from './storage.mjs';

export const onRequest = defineMiddleware((context, next) => {
  const source = context.url.pathname === '/_image'
    ? new URL(context.url.searchParams.get('href') ?? '', context.url)
    : context.url;
  context.locals.emdash = { storage: createFixtureStorage({ expectedDigest: source.searchParams.get('rev') }) };
  return next();
});
