# Changelog

All notable changes to this project are documented here. This project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- Fingerprinting now distinguishes `Map`, `Set`, `RegExp`, `URL`, `ArrayBuffer`, and typed array values instead of collapsing them to `{}`.
- Cost threshold checks and warning messages now tolerate IEEE 754 floating-point drift (such as repeated `0.1` increments) and ignore `NaN` cost inputs.
- Sub-second `maxMs` limits and elapsed times now format in milliseconds instead of rounding to `0s`.
- Cached `stop` verdicts are now frozen like `continue` verdicts.

## [0.1.0] - 2026-10-31

### Added

- `createLoopGuard(options)` with `check()`, `result()`, `addCost()`, `stats()` and `reset()`.
- Pattern checks for repeated calls, cycles and stale results, each warning first and then stopping.
- Hard limits on steps, time and cost, with one warning near each limit.
- `warn` and `stop` verdicts carry text written to be fed back to the model.
