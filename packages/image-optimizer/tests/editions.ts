/**
 * Drivers that call each edition's handlers the way EmDash does: the sandboxed entry takes
 * `(routeCtx, ctx)`, the native entry one context with the request's input merged in. Tests written
 * against `Edition` run the same scenario on both.
 */
import type { PluginContext, PluginUiContext } from 'emdash/plugin';

import { createPlugin } from '../src/native.ts';
import sandboxPlugin from '../src/plugin.ts';

export interface Edition {
  name: 'sandboxed' | 'native';
  route(ctx: PluginContext, name: string, input?: unknown, ui?: PluginUiContext): Promise<unknown>;
  hook(ctx: PluginContext, name: string, event: unknown): Promise<unknown>;
  /** What the edition declares for a hook besides its handler. */
  hookErrorPolicy(name: string): string | undefined;
  /** The route names the edition handles, and the methods each accepts (`undefined` for any). */
  routes(): Record<string, readonly string[] | undefined>;
}

type Handler = (...args: unknown[]) => Promise<unknown>;

/** Routes only the native edition declares. */
export const NATIVE_ONLY_ROUTES: readonly string[] = [
  'apply',
  'restore',
  'bulk-start',
  'bulk-pause',
  'bulk-resume',
  'bulk-cancel',
  'bulk-retry',
  'bulk-reconcile',
  'bulk-status',
];

function handlerOf(entry: unknown): Handler {
  const handler = typeof entry === 'function' ? entry : (entry as { handler?: unknown } | undefined)?.handler;
  if (typeof handler !== 'function') throw new Error('No such handler');
  return handler as Handler;
}

const sandboxed: Edition = {
  name: 'sandboxed',
  route: (ctx, name, input, ui) =>
    handlerOf(sandboxPlugin.routes?.[name])({ input, request: { url: 'https://site.test/', method: 'POST', headers: {} }, ui }, ctx),
  hook: (ctx, name, event) => handlerOf(sandboxPlugin.hooks?.[name as keyof typeof sandboxPlugin.hooks])(event, ctx),
  hookErrorPolicy: (name) => {
    const entry = sandboxPlugin.hooks?.[name as keyof typeof sandboxPlugin.hooks];
    return typeof entry === 'object' ? (entry as { errorPolicy?: string }).errorPolicy : undefined;
  },
  routes: () =>
    Object.fromEntries(
      Object.entries(sandboxPlugin.routes ?? {}).map(([name, entry]) => [
        name,
        typeof entry === 'object' ? (entry as { methods?: readonly string[] }).methods : undefined,
      ]),
    ),
};

const native: Edition = {
  name: 'native',
  route: (ctx, name, input, ui) =>
    handlerOf(createPlugin().routes[name])({
      ...ctx,
      input,
      request: new Request('https://site.test/', { method: 'POST' }),
      requestMeta: { ip: null, userAgent: null, referer: null, geo: null },
      ui,
    }),
  hook: (ctx, name, event) =>
    handlerOf(createPlugin().hooks[name as keyof ReturnType<typeof createPlugin>['hooks']])(event, ctx),
  hookErrorPolicy: (name) => createPlugin().hooks[name as keyof ReturnType<typeof createPlugin>['hooks']]?.errorPolicy,
  // The shared routes; apply, restore and the bulk routes are the native edition's own (checked in `editions.test.ts`).
  routes: () =>
    Object.fromEntries(
      Object.entries(createPlugin().routes)
        .filter(([name]) => !NATIVE_ONLY_ROUTES.includes(name))
        .map(([name, route]) => [name, route.methods]),
    ),
};

export const editions: Edition[] = [sandboxed, native];
