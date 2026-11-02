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

## 2026-10-26 Audit Follow-up

`npm audit fix` upgraded the production dependency `@modelcontextprotocol/sdk`
to 1.32.2 (five high-severity advisories: OAuth credential leakage,
session fixation, cross-origin redirect replay, memory exhaustion and
bearer-token confusion) along with transitive `body-parser` and
`brace-expansion` fixes. The full deterministic suite and production
build were verified after the upgrade.

Remaining advisories (14 total: 2 critical, 7 high) live exclusively in
devDependencies and require breaking tooling upgrades tracked separately:

- `vite`/`esbuild`/`ws`: need `@cloudflare/vite-plugin@1.65.0` (outside declared range)
- `tinypool`: needs `oxfmt@0.74.0` (breaking)
- `zod`: needs `shadcn@4.22.1` (breaking)
- `sharp`, `undici`: transitive via Cloudflare/browser tooling

None of these ship in the production runtime paths served by
`server/index.mjs`; they affect local development and build tooling only.

## 2026-11-02 Audit Follow-up

### Production tree regression found

The 2026-10-26 note stated the remaining advisories lived "exclusively in
devDependencies". That had stopped being true: `npm audit --omit=dev` reported
**15 advisories (5 high)** in the production tree.

Root cause: `shadcn` — the scaffolding CLI, not the component source — was
declared in `dependencies`. It has **zero runtime imports** (`components/ui/*`
imports the separate `@shadcn/react` package), but it pulled
`@dotenvx/dotenvx` → `systeminformation` (high, Linux `networkStats()` path
traversal) plus `zod`, `ts-morph` and `deepmerge` into the production graph.
It is now a devDependency.

### Changes

| Package | From | To | Reason |
| --- | --- | --- | --- |
| `shadcn` | dep `4.18.0` | **devDep** `4.23.0` | Scaffolding CLI, never imported at runtime; removes `systeminformation`/`zod`/`ts-morph` from the production tree |
| `oxfmt` | `0.61.0` | `0.75.0` | `tinypool` prototype-pollution RCE gadget (critical) |
| `@cloudflare/vite-plugin` | `1.37.1` | `1.67.0` | `esbuild`/`ws` chain (the upgrade the previous note deferred) |
| `wrangler` | `4.92.0` | `4.156.1` | Required by the plugin bump; drags `miniflare`/`sharp` forward |
| `@cloudflare/workers-types` | `4.20260515.1` | `5.20261102.1` | `wrangler@4.156` peer requirement |
| `vite` | `8.0.16` | `8.3.5` | `launch-editor` Windows `escapeCmdArgs()` argument injection (high) |
| `postcss` (override) | — | `8.5.32` | Vite 8.3 nested its own copy; the duplicate broke `tsc --noEmit` with two incompatible `postcss` type identities |

`npm audit fix` (in-range only, no `--force`) was applied on top.

### Result

| Scope | Before | After |
| --- | --- | --- |
| Full tree | 23 (2 critical, 8 high) | **12 (0 critical, 1 high)** |
| Production (`--omit=dev`) | 15 (5 high) | **4 (0 high, all moderate)** |

### Deliberately not taken

- **`oxlint` 1.76 → 1.90.** Carries no advisory fix, and 1.90 removed the
  `react/react-compiler` rule entirely (absent from its
  `configuration_schema.json`, not renamed), so `.oxlintrc.json` fails to parse
  and the project silently loses React Compiler checking on a React 19
  codebase. Kept at `1.76.0` with `oxlint-tsgolint@7.0.2001`.
- **`shadcn` 4.23 → 1.0.0.** npm's "fix" is a semver-major downgrade-looking
  retag of the CLI. Now dev-only, so its 2 remaining advisories do not reach
  production.
- **`vinext` 1.0.0-beta.9 → 1.4.1.** This would clear all 4 remaining
  production advisories (`@vercel/og`, `satori`, `fast-uri`, `vinext`), but it
  is the web framework and the jump crosses beta → stable. It needs its own
  change with a full E2E run and a re-review of the Image Parser Limitation
  section above, which is written against beta.9. Tracked separately.

### Validation

`npm run lint`, `npm run typecheck`, `npm test` (305 tests, 0 fail, 12 skipped
— the documented platform-guard baseline), `npm run test:ui` (21 passed) and
`npm run build` all passed after a clean `node_modules` + `package-lock.json`
reinstall.

> `tsconfig.json` sets `incremental: true`. After a dependency change, a stale
> `tsconfig.tsbuildinfo` makes `tsc --noEmit` report type errors against
> `node_modules` paths that no longer exist. Delete it before trusting a
> typecheck failure that names a package directory.
