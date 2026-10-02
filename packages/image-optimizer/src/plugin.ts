import type { SandboxedPlugin } from 'emdash/plugin';

/**
 * Sandboxed entry. The scan job and report page are not wired yet; the scanner core lives in
 * `scanner.ts` and does not depend on EmDash.
 */
const plugin: SandboxedPlugin = {};

export default plugin;
