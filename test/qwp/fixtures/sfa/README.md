# QWP/WebSocket SFA interoperability fixtures

These are byte-for-byte copies of the Java-produced fixtures maintained by
the Rust client under `questdb-rs/src/tests/interop/qwp-ws-sfa`. They exercise
the shared `.sfa` segment envelope and `.symbol-dict` formats without deriving
expected bytes from the TypeScript implementation under test.

- The segment starts at frame sequence 42 and contains payloads `one` and
  `two-two` in a 64-byte zero-padded file.
- The dictionary contains chunks `["one"]` and `["two", "three"]`.
- The torn variants corrupt the second frame/chunk and verify that recovery
  retains and durably truncates to the valid prefix.

The Rust fixture suite can regenerate and validate these bytes bidirectionally
against Java's real `MmapSegment` and `PersistedSymbolDict` implementations.
