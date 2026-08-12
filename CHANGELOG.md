# Changelog

All notable changes to `omp-compact` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- Reject duplicate `TranscriptFold` ownership when the same checkout is loaded through both a user-installed symlink and an explicit `-e` path, preventing recursive finalization and stack overflow.
- Run the source-checkout launcher with isolated extension discovery so it cannot double-load an ambient `omp-compact` installation.

## [1.0.0] - 2026-08-12

### Added

- Three presentation modes: `compact`, `live`, and `clear`.
- Evidence-based mutation audit for native `write` and `edit` tools.
- Conservative Git detection with a terminal aggregate commit summary.
- Configurable terminal usage statistics and project-relative display paths.
- Opt-in post-turn auto-shake through the stock public session API.
- Persistent `/compact-settings` UI, environment overrides, and atomic config updates.
- Same-session reconstruction after `/tree` and manual `/shake` without restarting OMP.
- Redacted replay corpus plus focused and stock-host integration coverage.

### Hardened

- Exact-instance, reversible host patches with capability checks and native fail-open fallback.
- Bounded config parsing, hydration, mutation evidence, and diff processing.
- Delayed terminal audit ownership and statistics-carrier ancestry across subsequent runs.
- Capability-checked stats-carrier placement and immediate JSON structural-underflow rejection.

### Verified

- OMP 17.2.12 compatibility.
- 762 tests, 0 failures, and 3,344 assertions across 25 files before the standalone repository migration.
- Strict TypeScript and Biome checks.
- Persistent-session manual smoke covering prior-session resume, all three modes, `/tree`, `/shake`, and new live tool calls after both reconstruction paths.

### Compatibility

- The plugin is intentionally pinned to the private TUI shapes of OMP 17.2.12.
- An incompatible host shape rolls back the presentation adapter and leaves native rendering active.

[Unreleased]: https://github.com/arksdev/omp-compact/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/arksdev/omp-compact/releases/tag/v1.0.0
