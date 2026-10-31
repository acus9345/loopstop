# Changelog

All notable changes to this project are documented here. This project follows [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-31

### Added

- `createLoopGuard(options)` with `check()`, `result()`, `addCost()`, `stats()` and `reset()`.
- Pattern checks for repeated calls, cycles and stale results, each warning first and then stopping.
- Hard limits on steps, time and cost, with one warning near each limit.
- `warn` and `stop` verdicts carry text written to be fed back to the model.
