# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This repository builds the QuestDB JavaScript clients: `@questdb/nodejs-client`
for Node.js and `@questdb/browser-client` for browsers. A private
`@questdb/client-core` workspace package owns their shared implementation.

## Development Commands

### Build

```bash
pnpm build          # Build both public ESM/CJS packages from client-core
```

### Testing

```bash
pnpm test           # Run all tests using Vitest
```

### Code Quality

```bash
pnpm eslint         # Run ESLint on all source files
pnpm typecheck      # Run TypeScript type checking without emitting files
pnpm format         # Format code using Prettier
```

### Documentation

```bash
pnpm run docs       # Build TypeDoc documentation
pnpm preview:docs   # Preview generated documentation locally
```

## Architecture

### Core Components

Runtime-neutral QWP implementation lives under `packages/client-core/src`.
Each public package owns its runtime-specific source, package metadata,
documentation, and single root build.

1. **Sender** (`packages/nodejs-client/src/sender.ts`): Main Node.js API class that orchestrates data ingestion. Handles auto-flushing, connection management, and provides the builder pattern API for constructing rows.

2. **Transport Layer** (`packages/nodejs-client/src/transport/`):

   - `http/undici.ts`: Default HTTP transport using Undici library for high performance
   - `http/stdlib.ts`: Alternative HTTP transport using Node.js built-in modules
   - `tcp.ts`: TCP/TCPS transport for persistent connections with JWK authentication
   - Protocol negotiation and retry logic for HTTP transports

3. **Buffer System** (`packages/nodejs-client/src/buffer/`):

   - `bufferv1.ts`: Text-based protocol (version 1) for backward compatibility
   - `bufferv2.ts`: Binary protocol (version 2) with double encoding and array support
   - Dynamic buffer resizing and row-level transaction support

4. **Configuration** (`packages/nodejs-client/src/options.ts`): Comprehensive options parsing from connection strings with validation and deprecation handling.

5. **QWP core** (`packages/client-core/src/qwp/` and `packages/client-core/src/_qwp/`): Shared browser-safe protocol/session code.

6. **Runtime adapters**: `packages/nodejs-client/src/qwp.ts` owns Node WebSocket, UDP, TLS, and persistence support; `packages/browser-client/src/index.ts` owns the browser WebSocket and authentication adapter. The browser package must remain free of Node built-ins, Node typings, `undici`, and `ws`.

### Protocol Versions

- **Version 1**: Text-based serialization, compatible with older QuestDB versions
- **Version 2**: Binary encoding for doubles, supports array columns, better performance
- **Auto-negotiation**: HTTP transport can automatically detect and use the best protocol version

### Key Design Patterns

- Builder pattern for row construction with method chaining
- Factory methods (`Sender.fromConfig()`, `Sender.fromEnv()`) for validated initialization
- Abstract base classes for transport and buffer implementations
- Automatic buffer management with configurable auto-flush behavior

## Testing Strategy

Tests are organized by component:

- `sender.config.test.ts`: Configuration parsing and validation
- `sender.buffer.test.ts`: Buffer operations and protocol serialization
- `sender.transport.test.ts`: Transport layer functionality
- `sender.integration.test.ts`: End-to-end integration tests with QuestDB

Integration tests use TestContainers to spin up QuestDB instances for realistic testing.

## Important Implementation Notes

- The client requires Node.js v20+ for Undici support
- Authentication is handled differently per transport (Basic/Bearer for HTTP, JWK for TCP)
- Buffer automatically resizes up to `max_buf_size` (default 100MB)
- Auto-flush triggers based on row count or time interval
- Each worker thread needs its own Sender instance (buffers cannot be shared)
- Protocol version 2 is recommended for new implementations with array column support
- Run `pnpm test:dist` after package-boundary changes; it checks both npm tarballs, ESM/CJS loading, browser bundling, and the absence of Node modules from the browser artifact.
