# Contributing to nodejs-questdb-client

Thank you for your interest in contributing to nodejs-questdb-client! This document provides guidelines and instructions for contributing to the project.

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


## Running Tests

The project uses Vitest for testing. Tests are located in the `test` directory.

1. Run tests in watch mode during development:
```bash
pnpm run test
```

### Test Requirements

- Some tests use mock servers and certificates located in the `test/certs` directory

> You can generate the certificates by running the `generateCerts.sh` script in the `scripts` directory. The script requires two arguments: the output directory and the password for the certificates.
`./scripts/generateCerts.sh . questdbPwd123`


## Code Style and Quality

1. The project uses TypeScript. Make sure your code is properly typed.

2. Format your code using Prettier

3. Lint your code:
```bash
pnpm run lint
```

4. Fix linting issues:
```bash
pnpm run lint --fix
```

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

By contributing to nodejs-questdb-client, you agree that your contributions will be licensed under the project's license.

