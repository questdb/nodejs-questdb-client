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
