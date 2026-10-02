# Security

Report a vulnerability privately by email to **security@verco.app**. Please do not open a public
issue for it.

Include the affected package (for example `packages/image-optimizer`), its version, the EmDash
version and platform (Node or Cloudflare), and the steps that show the problem.

## Scope

- The plugins under `packages/`. The image optimizer declares only the `media:read` capability and
  never changes media; a way for it to read, change or expose more than that is in scope.
- The host patches under `host/emdash/patches/`. They are a pilot, off unless a site sets
  `safeMedia`, and not a supported EmDash release.

Vulnerabilities in EmDash itself belong to the
[EmDash project](https://github.com/emdash-cms/emdash/security/advisories/new).
