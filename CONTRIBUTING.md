# Contributing to the QuestDB JavaScript Client

Thank you for your interest in contributing to the QuestDB JavaScript Client!
This repository contains both the Node.js and browser npm packages.

## Development Setup

1. Fork and clone the repository:

```bash
git clone https://github.com/YOUR_USERNAME/nodejs-questdb-client.git
cd nodejs-questdb-client
```

2. Install dependencies:

```bash
pnpm install
```

## Repository Layout

The repository is a pnpm workspace of three packages:

| Package                              | Published | Contents                                                              |
| ------------------------------------ | --------- | --------------------------------------------------------------------- |
| `packages/client-core`               | no        | Shared runtime-neutral QWP protocol and session code                   |
| `packages/nodejs-client`             | yes       | `@questdb/nodejs-client`: ILP transports plus the Node QWP adapter     |
| `packages/browser-client`            | yes       | `@questdb/browser-client`: the browser QWP adapter                     |

`client-core` is private and never published; both public packages inline it at
build time. Each published package exposes its whole API from its package root,
so `packages/*/src/index.ts` are the only public entry points.

Build both packages with:

```bash
pnpm build
```

`packages/browser-client` must stay free of Node built-ins, Node typings,
`undici`, and `ws`. Run `pnpm test:dist` after any change to a package boundary:
it loads both built tarball layouts through their `exports` maps and checks the
browser bundle for Node imports.

## Running Tests

The project uses Vitest for testing. Tests are located in the `test` directory.

1. Run tests in watch mode during development:

```bash
pnpm run test
```

### Test Requirements

- Some tests use mock servers and certificates located in the `test/certs` directory

> You can generate the certificates by running the `generateCerts.sh` script in the `scripts` directory. The script requires two arguments: the output directory and the password for the certificates.
> `./scripts/generateCerts.sh . questdbPwd123`

## Code Style and Quality

1. The project uses TypeScript. Make sure your code is properly typed.

2. Format your code using Prettier

3. Lint your code:

```bash
pnpm eslint
```

4. Fix linting issues:

```bash
pnpm eslint --fix
```

## CI Gates

`.github/workflows/build.yml` runs the following on every pull request, across
Node.js 20, 22, and latest. Run them locally before pushing — `pnpm test` alone
does not cover the type-checking, packaging, or browser-bundle gates.

| Command                             | Covers                                                        |
| ----------------------------------- | ------------------------------------------------------------- |
| `pnpm eslint`                       | `packages/*/src`                                               |
| `pnpm format:check`                 | Prettier style across `packages/**` and `test/**`              |
| `pnpm typecheck`                    | Package sources plus the QWP public API contract               |
| `pnpm typecheck:qwp-browser`        | The browser source graph, with DOM libs and no `@types/node`   |
| `pnpm typecheck:test`               | `test/**`, which `pnpm typecheck` does not reach               |
| `pnpm typecheck:bench`              | `benchmarks/**`                                                |
| `pnpm lint:bench`                   | `benchmarks/**`                                                |
| `pnpm test`                         | The Vitest suite, including containerized integration tests    |
| `pnpm test:dist`                    | Both built packages loaded through their `exports` maps        |
| `pnpm typecheck:dist`               | The emitted `.d.ts` files, as a consumer sees them             |
| `pnpm check:packages`               | That everything `exports` references is present and packed     |

A separate job drives the built browser bundle in real Chromium against a local
mock server:

```bash
pnpm test:qwp-browser
```

Vitest strips types without checking them, so a test can reference a deleted
export and still pass; `pnpm typecheck:test` is what catches that. Likewise the
compiled table writers promise per-column row typing that lives only in the
emitted declarations, which is why `pnpm typecheck:dist` exists alongside
`pnpm test:dist`.

## Generated API reference

`docs/` is committed and GitHub Pages serves it directly from the branch, so it
is published output rather than a local build artifact. Regenerate it in the same
commit whenever you add or rename a public export, or edit `QWP.md` or
`README.md`:

```bash
pnpm run docs
```

`test/docs-reference.test.ts` runs inside `pnpm test` and fails when the
committed reference has no page for an exported symbol, or when its embedded
copy of `QWP.md` has fallen behind the real one. It deliberately does not
compare the tree byte for byte: TypeDoc stamps the current commit SHA into every
source link, so a regenerated tree always differs from the one committed a commit
earlier, and a strict diff would be unsatisfiable rather than merely noisy.

## Releasing

`.github/workflows/publish.yml` publishes the selected packages (both by
default, see below) from one commit, so bump `packages/nodejs-client/package.json` and
`packages/browser-client/package.json` to the same new version before
dispatching it. `node scripts/check-release-versions.mjs` runs first and
refuses a dispatch whose version **every** selected package has already
published, because each publish step skips a version npm already has and
such a dispatch would publish nothing at all. For a single-package dispatch
that means re-dispatching a package already on npm is refused even while the
other package is still missing; the error names the missing package and the
`packages` value that publishes it.

Dispatches run one at a time. A dispatch made while another is running waits
for it to finish, so its version check sees everything the earlier one
published; GitHub keeps only the newest waiting dispatch and cancels any older
one still waiting.

If a dispatch fails between the two publish steps, leaving one package on npm
and the other not, **re-dispatch the same commit**. That is the supported
repair: the gate verifies that the published package's npm `gitHead` is the
commit being dispatched, reports `resuming a partial release`, and passes. The
published package's step skips it, and the missing one lands.
A package with the same version but a different or missing `gitHead` is an older
unrelated artifact, not a partial release; the gate rejects it and the version
must be bumped, unless that package was deliberately released on its own (see
below). Do not bump merely to escape a genuine same-commit partial
release -- that strands the missing half at the old version permanently.

### Releasing one package on its own

The workflow's `packages` input (`both`, `nodejs`, or `browser`; default
`both`) publishes a subset, for example when a package depends on server
support that has not shipped yet. The manifests must still carry the same
version, but the gate checks only the selected packages against npm, so the
other package can follow later under that same version from a later commit:
dispatch it with its own `packages` value. Do not dispatch `both` for a
follow-up from a later commit; the gate sees the already-published package's
`gitHead` differ from the new commit and rejects the release as an unrelated
artifact. A follow-up from the same commit may dispatch either the missing
package or `both`; with `both`, the gate reports it as a resumed partial
release and the already-published package is skipped.

If the first package needs a fix before the second ships, bump both manifests
and dispatch only the first again. The second then ships under the newer
version.

`check-release-versions.mjs` decides *whether* to bump, never by how much.
Pick the level from the changes the release carries: a change that alters the
behaviour of a published API, its emitted wire bytes, or the errors it throws
is breaking and needs a major bump, even when the new behaviour is a fix. The
signal comes from the commits, so mark a breaking change where Conventional
Commits puts it (see below) rather than leaving it for the release to
rediscover.

### npm authentication

The publish steps authenticate with npm
[trusted publishing](https://docs.npmjs.com/trusted-publishers): npm trades the
job's GitHub OIDC token for a short-lived publish token, so the repository
stores no long-lived npm token, and every version carries a provenance
statement. Each package needs a trusted publisher on npmjs.com (package
Settings, Trusted publishing, GitHub Actions) with organization `questdb`,
repository `nodejs-questdb-client`, workflow filename `publish.yml` and no
environment. Its allowed actions must include `npm publish`; npm defaults a new
configuration to `npm stage publish` only. npm also expires a configuration
that has not published within 48 hours of its creation, so add it shortly
before the dispatch that first uses it, and recreate it if it lapsed.
`ENEEDAUTH` from a publish step means npm got no token over OIDC and had no
token to fall back to. Usually no trusted publisher matches this workflow, but
a failed OIDC request to GitHub or npm ends the same way, so check the
configuration and re-dispatch. `404 Not Found - PUT` means npm rejected a
token.

npm attaches a trusted publisher only to a package that already exists, so a
new package's first version needs a token. Create a granular access token with
read and write access to the `@questdb` scope, **Bypass 2FA** enabled and a
short expiry, store it as the `NPM_BOOTSTRAP_TOKEN` repository secret, and
dispatch. npm still tries trusted publishing first, but while the secret is
set it falls back to the token whenever that fails, for every package in the
dispatch: a package whose trusted publisher does not match this workflow or
has expired also publishes with the token, and the run still passes. So check
each version the dispatch published: one published over OIDC shows a
`trustedPublisher` entry in `npm view <package>@<version> _npmUser`, and one
without it used the token. Then delete the secret and revoke the token.
Shortly before the next release, add a trusted publisher for the new package
and for any other package that published with the token, deleting its broken
or expired one first.

## Making Changes

1. Create a new branch for your changes:

```bash
git checkout -b feature/your-feature-name
```

2. Make your changes and commit them with clear, descriptive commit messages:

```bash
git add .
git commit -m "feat: add new feature"
```

We follow the [Conventional Commits](https://www.conventionalcommits.org/) specification for commit messages.

A commit that breaks a published API marks it, either as `!` after the
type/scope (`feat(qwp)!: ...`) or as a `BREAKING CHANGE:` footer. That marker
is what tells a release it has to be a major one, so a pull request carrying
such a change needs it on the pull request title too.

3. Push your changes to your fork:

```bash
git push origin feature/your-feature-name
```

4. Create a Pull Request from your fork to the main repository.

## Pull Request Guidelines

1. Make sure all tests pass
2. Update documentation if needed
3. Add tests for new features
4. Keep PRs focused - one feature or bug fix per PR
5. Link any related issues in the PR description

## Documentation

- Update the README.md if you're adding new features or changing existing ones
- Add JSDoc comments for new public APIs
- Include examples in the documentation when appropriate

## Need Help?

If you have questions or need help, you can:

- Open an issue with your question
- Join our community discussions (if available)

## License

By contributing to the QuestDB JavaScript Client, you agree that your contributions will be licensed under the project's license.
