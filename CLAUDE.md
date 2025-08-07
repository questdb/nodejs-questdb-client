# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is the QuestDB Node.js client library (@questdb/nodejs-client) that provides data ingestion capabilities to QuestDB databases. The client supports multiple transport protocols (HTTP/HTTPS, TCP/TCPS) and authentication methods.

## Development Commands

### Build
```bash
pnpm build          # Build the library using bunchee (produces both ESM and CJS outputs)
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
pnpm docs           # Build JSDoc documentation
pnpm preview:docs   # Preview generated documentation locally
```

## Architecture

### Core Components

1. **Sender** (`src/sender.ts`): Main API class that orchestrates data ingestion. Handles auto-flushing, connection management, and provides the builder pattern API for constructing rows.

2. **Transport Layer** (`src/transport/`):
   - `http/undici.ts`: Default HTTP transport using Undici library for high performance
   - `http/stdlib.ts`: Alternative HTTP transport using Node.js built-in modules
   - `tcp.ts`: TCP/TCPS transport for persistent connections with JWK authentication
   - Protocol negotiation and retry logic for HTTP transports

3. **Buffer System** (`src/buffer/`):
   - `bufferv1.ts`: Text-based protocol (version 1) for backward compatibility
   - `bufferv2.ts`: Binary protocol (version 2) with double encoding and array support
   - Dynamic buffer resizing and row-level transaction support

4. **Configuration** (`src/options.ts`): Comprehensive options parsing from connection strings with validation and deprecation handling.

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