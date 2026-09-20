# Dependency Security Review

Reviewed on 2026-09-10 for the Node.js production deployment.

| Package                                          | Selected version | Reason                                                                                                              |
| ------------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| `react`, `react-dom`, `react-server-dom-webpack` | `19.2.8`         | Match the React packages and include the Server Functions denial-of-service fix.                                    |
| `yaml`                                           | `2.8.3`          | Include the deeply nested collection stack-overflow fix.                                                            |
| `vinext`                                         | `1.0.0-beta.9`   | Take the supported beta fixes and the corresponding build dependency layout. See the image parser limitation below. |
| `@vitejs/plugin-rsc`                             | `0.5.34`         | Meet the updated vinext peer dependency.                                                                            |
| `vite`                                           | `8.0.16`         | Include the Windows filesystem-deny and editor UNC-path fixes.                                                      |

Two dependency-specific overrides keep production resolution within the existing
declared version ranges: `@dotenvx/dotenvx` uses `undici@7.29.1`, and Vite's optional
esbuild peer requires `0.28.1`. They do not override the separate versions pinned
by the Cloudflare development tooling. The current build uses Rolldown and does
not require Vite's optional esbuild peer.

Validation completed:

- `npm run build`, `npm run typecheck`, and `npm run lint` passed.
- Provider, encrypted-vault, native-runtime, and capability regression tests passed
  with a local model fixture: 18 tests, no paid model calls and no skips.
- `npm audit --omit=dev` reported zero known vulnerabilities.
- A temporary production server returned HTTP 400 for both
  `/_next/image?url=/malformed.icns&w=640&q=75` and the `/_vinext/image` alias.
  The homepage then returned HTTP 200, and the temporary server was closed.

## Image Parser Limitation

The vinext update is not a claim that `image-size@2.0.2` itself was fixed.
[Upstream change #2913](https://github.com/cloudflare/vinext/pull/2913) bundles
that parser into build tooling and removes it from the published dependency
graph. It can therefore disappear from an npm audit while remaining present in
the installed framework files.

The Node production image endpoints validate parameters and allowed content
types, then serve static files without invoking that parser. The application has
no `next/image` imports or configured image transformation backend. The generated
`dist/server` files contained no `image-size` package references or known parser
identifiers during this review. This check and the rejected-request smoke test
cover the current Node deployment, not a future image backend or Worker adapter.

Untrusted image files must not be introduced as static imports or metadata images
during a build until the bundled parser is patched. The `images.unoptimized`
setting does not disable these server routes in this vinext release and is not
used as a security control.

## Development Tooling Follow-up

The full `npm audit` still reports seven entries: four high, two moderate, and one
low. They belong to the development-only Cloudflare tooling chain
(`@cloudflare/vite-plugin`, `wrangler`, `miniflare`, and its `sharp`, `undici`, `ws`,
and esbuild dependencies). Its pinned dependencies were preserved during this
bounded update. These tools are not enabled in `vite.config.ts` or the Linux
Node deployment scripts. A Cloudflare Workers deployment requires its own
compatible tooling upgrade and validation before use.

Audit results are a dated dependency check, not a security guarantee. In
particular, npm audit does not inspect bundled third-party source or the Undici
version bundled into the Node.js executable; production still requires a
maintained Node.js security release.

References:

- [React Server Functions advisory](https://github.com/advisories/GHSA-wx67-qw84-cm4g)
- [YAML 2.8.3 release](https://github.com/eemeli/yaml/releases/tag/v2.8.3)
- [Vinext beta.9 release](https://github.com/cloudflare/vinext/releases/tag/vinext%401.0.0-beta.9)
- [Undici 7.29.1 security fixes](https://github.com/nodejs/undici/releases/tag/v7.29.1)
