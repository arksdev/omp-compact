# Changelog

All notable changes to `omp-compact` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

### Fixed

- Reject duplicate `TranscriptFold` ownership when the same checkout is loaded through both a user-installed symlink and an explicit `-e` path, preventing recursive finalization and stack overflow.
- Run the source-checkout launcher with isolated extension discovery so it cannot double-load an ambient `omp-compact` installation.

### Hardened

- Exact-instance, reversible host patches with capability checks and native fail-open fallback.
- Bounded config parsing, hydration, mutation evidence, and diff processing.
- Delayed terminal audit ownership and statistics-carrier ancestry across subsequent runs.
- Capability-checked stats-carrier placement and immediate JSON structural-underflow rejection.

### Changed

- Reworked the repository README around marketplace installation, plain-language behavior, mode differences, additional settings, safe removal, and English/Russian navigation.
- Changed the opt-in auto-shake threshold default from 2,000,000 to 120,000 tokens; `0` still means every eligible logical run.
- Declared public compatibility as OMP 17.2.12 and later while keeping stock 17.2.12 as the pinned release-gate host; future incompatible TUI shapes fail open to native rendering.

### Verified

- Stock OMP 17.2.12 compatibility as the pinned release gate for the public `>=17.2.12` support range.
- 770 tests, 0 failures, and 3,388 assertions across 28 files in the standalone release gate.
- Strict TypeScript and Biome checks.
- Persistent-session manual smoke covering prior-session resume, all three modes, `/tree`, `/shake`, and new live tool calls after both reconstruction paths.

### Compatibility

- The plugin supports OMP 17.2.12 and later; its known private TUI shape and executable release gate are pinned to stock 17.2.12.
- A future incompatible host shape rolls back the presentation adapter, leaves native rendering active, and should be reported with the exact OMP version and reproduction.

[Unreleased]: https://github.com/arksdev/omp-compact/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/arksdev/omp-compact/releases/tag/v1.0.0
