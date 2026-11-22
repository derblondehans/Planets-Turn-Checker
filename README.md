# Planets Turn Checker

A Tampermonkey userscript for [planets.nu](https://planets.nu/) that checks
your turn for common manual mistakes. It only reads the turn: it does not
change, save or send any game data, and it never ends a turn on its own.

Desktop interface only.

## Install

1. Install the Tampermonkey browser extension.
2. Open the Tampermonkey dashboard, create a new script and replace its content
   with `planets-turn-checker.user.js`, then save.
3. Open a game on planets.nu. A **Check turn** button appears at the bottom
   left of the map, to the right of the Minefields button if you use the
   minefield simulation.

## Use

Press **Check turn**. The panel lists the findings in two groups:

- **Errors**: very likely a mistake.
- **Hints**: maybe intended, worth a look.

Click a finding to open the ship, planet or starbase on the map. Press
**Check again** after you have fixed something. Under **Settings** you can turn
each check on or off and change the thresholds. Settings are kept in the
browser's `localStorage`.

### Warning on End Turn

When you end the turn (End Turn and its confirmation, or any other way the
game offers), the script runs the checks first. If there are **errors**, a
dialog lists them:

- **Show findings**: the turn is not ended; the panel opens.
- **Cancel**: the turn is not ended.
- **End turn anyway**: your click goes on to the game, which ends the turn.

Hints alone do not stop the turn. With no errors the turn ends as usual,
without a dialog. Turn the warning off under **Settings** (*Warn on End Turn
when there are errors*). Un-marking a turn as ready is never checked.

## Checks

| Id | Level | What it finds |
|----|-------|---------------|
| S1 | Error | A ship has less fuel than its route needs (cloak fuel included). Arriving with 0 fuel is fine. |
| S3 | Error | The mission does not fit the ship: laying mines without torpedoes, sweeping mines without beams (or fighters for the Colonies), towing without a target or with a target at another position, intercepting without a visible target. |
| S5 | Hint | A ship with cargo (clans, minerals, supplies, MC) stays at an own planet and does not move. Unloading forgotten? Not counted: supplies on a Merlin (alchemy), and minerals and MC on a ship with torpedo launchers and the friendly code `mkt` (any case). |
| S6 | Hint | A ship has no destination and the mission Explore. Not repeated for ships S5 lists, and not for a Merlin with the friendly code `alm`, `ald` or `alt` (any case). |
| S8 | Error | A ship with the friendly code `mkt`, `lfm` (lower case) or `HYP` (upper case), in exactly this spelling, is at a planet with a starbase that is not yours. |
| P1 | Error | Colonist happiness falls this turn and ends below the threshold (default 40). |
| P2 | Error | Native happiness falls this turn and ends below the threshold (default 40). |
| P3 | Hint | Natives pay 0% tax although their happiness is at the threshold (default 100) or above. Amorphous natives and planets with native auto-tax are skipped. |
| P5 | Error | A planet has the friendly code `bum` or `dmp` (any case) and had the same code in the previous turn. |
| B1 | Error | A ship has the friendly code `cln` (any case) at an own starbase, and the planet lacks the duranium, tritanium or molybdenum to clone it. |

Happiness changes use the client's own formulas (`colonistTaxChange`,
`nativeTaxChange`), the clone costs the client's `cloneCheck`, the fuel the
client's `getFuelUsage` for every leg of the route.

### How P5 knows the previous turn

The game only knows the current friendly code. The script therefore stores,
per game and turn, which of your planets have `bum` or `dmp`: once when it
first sees a turn and again whenever the map is redrawn. Only the last 3 turns
are kept. P5 can only warn if the script ran in the previous turn, or when you
first opened the current turn. If you installed the script during a turn in
which you had already set the code, P5 may warn one turn early.

## When planets.nu changes

The script uses internal parts of the planets.nu client, not a public API. All
of them are in one place in the script (the *game adapter*). When a game opens,
the script checks that they are all there. If the client has changed, the panel
says what is missing and the checker turns itself off instead of giving wrong
results. A check that fails while running is reported in the panel and in the
browser console; the other checks still run.

## Versions

The changes in each version are in [CHANGELOG.md](CHANGELOG.md). To see which
version you have installed, look at `@version` in the script in the
Tampermonkey dashboard. Every version is tagged in Git as `vX.Y.Z`.

To release a new version:

1. Raise `@version` in the script's header.
2. Add the version with its date and changes at the top of `CHANGELOG.md`, and
   its compare link at the bottom.
3. Commit, then tag the commit: `git tag -a vX.Y.Z -m "<the version's notes>"`.
4. Push the commit and the tag: `git push && git push origin vX.Y.Z`.

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
