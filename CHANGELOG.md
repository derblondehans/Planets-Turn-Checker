# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/).

## [0.2.1] - 2026-11-22

### Changed

- S5 no longer counts supplies on a Merlin, or minerals and MC on a torpedo
  ship with `mkt` (any case): that cargo is being worked on, not forgotten.
- S6 no longer lists a Merlin with the friendly code `alm`, `ald` or `alt`
  (any case) as idle.

## [0.2.0] - 2026-11-22

### Added

- Warning on End Turn: if the checks find errors, a dialog lists them and the
  turn ends only after *End turn anyway*. Can be turned off in the settings.
- Ship check S8: friendly code `mkt`, `lfm` or `HYP` (exact spelling) at a
  foreign starbase.

## 0.1.0 - 2026-11-22

Never published on its own; its changes are part of 0.2.0.

### Added

- **Check turn** button and panel with errors and hints; a click on a finding
  opens the ship, planet or starbase.
- Ship checks: S1 fuel for the route, S3 mission does not fit the ship,
  S5 ship with cargo idle at an own planet, S6 idle ship.
- Planet checks: P1 / P2 colonist and native happiness below a threshold
  (default 40), P3 untaxed natives at high happiness (default 100),
  P5 `bum` / `dmp` for at least 2 turns.
- Starbase check: B1 `cln` without enough minerals.
- Settings: each check on or off, thresholds, stored in `localStorage`.
- Compatibility check of the planets.nu client parts the script uses.

[0.2.1]: https://github.com/derblondehans/Planets-Turn-Checker/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/derblondehans/Planets-Turn-Checker/releases/tag/v0.2.0
