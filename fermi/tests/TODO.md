# tests/ — TODO (Stage 3, not yet)

Tests for the `../lib/` runners. Per the repo's node rules, new code in a `lib/` folder
requires a matching test — so `graph-runner.js` and `loop-runner.js` each need one here.

Test runner (from repo root): `node tests/run-all.js`; individual files via
`node fermi/tests/<name>.test.js`. Plain CommonJS, no framework required.

## Checklist

- [ ] `graph-runner.test.js`
  - [ ] runs nodes in dependency order
  - [ ] runs independent nodes in parallel
  - [ ] threads a node's result to its dependents
  - [ ] detects cycles and fails closed
- [ ] `loop-runner.test.js`
  - [ ] `loopUntil` stops on `done` and on `max`
  - [ ] `refineWithCritic` stops when the critic reports clean
  - [ ] `boundedRetry` respects the attempt cap
- [ ] Mock the `agent()` call so tests never spawn real subagents.
