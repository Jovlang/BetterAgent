# Test constraints

- Use `npm test` for the full suite or `npm test -- <path>` while iterating. There is no changed-file selection. Run native launch tests on the relevant OS; WSL tests that need a real distro skip when unavailable.
- Protect supported behavior at the boundary where a regression is visible. Prefer real cooperating modules with narrowly scoped Obsidian, native-peer, or OS doubles. Use unit tests for distinct contracts that do not need that integration. Do not add production hooks just for tests.
- Check existing coverage before adding cases. Prioritize data integrity, Codex history and resume, permissions, cancellation, streaming, process cleanup, attachments, linked content, and conversation navigation. Remove redundant, retired, and speculative tests rather than transferring all of their assertions.
- Drive UI actions with real DOM events and accessible names. jsdom cannot prove layout or host compatibility; use `npm run smoke:obsidian` on macOS or a repeatable desktop check for host-specific changes.
- Use observed events or controlled barriers for async work; timeouts should bound failures, not order the test. Restore mocks, environment and timers, and dispose mounted surfaces and child processes. Use fixture clocks from `@test/helpers/testClock` for expiry tests.
