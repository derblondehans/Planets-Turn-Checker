// ==UserScript==
// @name         planets.nu Turn Checker
// @namespace    planets-turn-checker
// @version      0.2.1
// @description  Checks your planets.nu turn for common manual mistakes. Nothing is changed or sent to the game.
// @license      Apache-2.0
// @match        https://planets.nu/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

/*
 * The script only reads the turn and lists findings. It never changes game
 * data and never ends a turn on its own: when the player ends the turn and
 * there are errors, it asks first and then passes the player's click on to
 * the client. Rules are taken from the planets.nu client
 * (nu.js 1.24): vgap.getFuelUsage, vgap.colonistTaxChange,
 * vgap.nativeTaxChange, vgap.cloneCheck and the ship screen's mission checks.
 */
(function () {
    "use strict";

    const PLUGIN_NAME = "TurnChecker";
    const STORAGE_PREFIX = "planets-turn-checker:";
    const RECORD_INTERVAL_MS = 3000; // throttle for recording friendly codes on map redraws
    const KEPT_TURNS = 3; // turns of friendly code history kept per game

    // Ship missions (nu.js, shipScreen.getMissionArray)
    const MISSION = { EXPLORE: 0, MINESWEEP: 1, LAY_MINES: 2, TOW: 6, INTERCEPT: 7, SPECIAL: 8, CLOAK_INTERCEPT: 20, LAY_HIDDEN_MINES: 28 };
    const RACE = { CRYSTAL: 7, COLONIES: 11 };
    const NATIVE_AMORPHOUS = 5;
    const DANGEROUS_PLANET_FC = /^(bum|dmp)$/i;
    const CLONE_FC = /^cln$/i;
    const MAKE_TORPEDOES_FC = /^mkt$/i;
    const HULL_MERLIN = 105; // Merlin Class Alchemy Ship: turns supplies into minerals
    const ALCHEMY_FC = /^(alm|ald|alt)$/i; // Merlin makes only molybdenum / duranium / tritanium
    const FOREIGN_BASE_FC =["mkt", "lfm", "HYP"]; // exact spelling, case-sensitive

    // The checks. "error" findings are likely mistakes, "hint" findings may be intended.
    const CHECKS = [
        { id: "S1", level: "error", title: "Not enough fuel for the course" },
        { id: "S3", level: "error", title: "Mission does not fit the ship" },
        { id: "S5", level: "hint", title: "Ship with cargo idle at own planet" },
        { id: "S6", level: "hint", title: "Idle ship (no destination, no mission)" },
        { id: "S8", level: "error", title: "mkt / lfm / HYP at a foreign starbase" },
        { id: "P1", level: "error", title: "Colonist happiness drops below threshold" },
        { id: "P2", level: "error", title: "Native happiness drops below threshold" },
        { id: "P3", level: "hint", title: "Natives untaxed at high happiness" },
        { id: "P5", level: "error", title: "bum / dmp friendly code for 2+ turns" },
        { id: "B1", level: "error", title: "Clone (cln) without enough minerals" },
    ];

    const DEFAULT_SETTINGS = {
        enabled: Object.fromEntries(CHECKS.map((c) => [c.id, true])),
        colonistHappinessMin: 40, // P1
        nativeHappinessMin: 40, // P2
        nativeUntaxedHappiness: 100, // P3
        warnOnEndTurn: true,
    };

    let settings = loadSettings();
    let compatible = true;
    let panel = null;
    let lastRecord = 0;

    // ---------- game adapter ----------
    // The only place that touches the planets.nu client (vgap). All of it is
    // the client's internal code, not a public API, so a client update may
    // change it. missingFeatures() names what the script needs and no longer
    // finds; the script then turns itself off instead of giving wrong results.

    const isFn = (f) => typeof f === "function";

    const REQUIRED_FEATURES = [
        ["vgap.registerPlugin", () => isFn(vgap.registerPlugin)],
        ["vgap.myships / myplanets", () => Array.isArray(vgap.myships) && Array.isArray(vgap.myplanets)],
        ["vgap.getShip / getPlanet / getStarbase / planetAt", () =>
            isFn(vgap.getShip) && isFn(vgap.getPlanet) && isFn(vgap.getStarbase) && isFn(vgap.planetAt)],
        ["vgap.getPath / getFuelUsage", () => isFn(vgap.getPath) && isFn(vgap.getFuelUsage)],
        ["vgap.cloakFuel", () => isFn(vgap.cloakFuel)],
        ["vgap.colonistTaxChange / nativeTaxChange", () => isFn(vgap.colonistTaxChange) && isFn(vgap.nativeTaxChange)],
        ["vgap.cloneCheck", () => isFn(vgap.cloneCheck)],
        ["vgap.isSamePoint", () => isFn(vgap.isSamePoint)],
        ["vgap.turnReady", () => isFn(vgap.turnReady)],
        ["vgap.map.selectShip / selectPlanet / selectStarbase", () =>
            !!vgap.map && isFn(vgap.map.selectShip) && isFn(vgap.map.selectPlanet) && isFn(vgap.map.selectStarbase)],
    ];

    const game = {
        // The client script has loaded.
        loaded() {
            return typeof vgap !== "undefined" && !!vgap && isFn(vgap.registerPlugin);
        },

        // A game is open and its turn data exists.
        ready() {
            return game.loaded() && !!vgap.map && !!vgap.player && vgap.player.id > 0 && Array.isArray(vgap.myships);
        },

        missingFeatures() {
            return REQUIRED_FEATURES.filter(([, test]) => {
                try {
                    return !test();
                } catch (e) {
                    return true;
                }
            }).map(([name]) => name);
        },

        gameId() {
            return vgap.game && vgap.game.id ? vgap.game.id : null;
        },

        // The current turn, or null while a past turn is shown.
        currentTurn() {
            if (vgap.inHistory) return null;
            const turn = vgap.nowTurn || (vgap.settings && vgap.settings.turn);
            return turn > 0 ? turn : null;
        },

        raceId() {
            return vgap.player.raceid;
        },

        registerPlugin(hooks, name) {
            vgap.registerPlugin(hooks, name);
        },

        // Own ships and planets; sphere wrap-around copies have negative ids.
        ships() {
            return vgap.myships.filter((s) => s.id > 0);
        },
        planets() {
            return vgap.myplanets.filter((p) => p.id > 0);
        },

        ship(id) {
            return vgap.getShip(id);
        },
        ownPlanetAt(x, y) {
            const p = vgap.planetAt(x, y);
            return p && p.ownerid === vgap.player.id ? p : null;
        },
        starbase(planetId) {
            return vgap.getStarbase(planetId);
        },
        // The planet at x, y if it has a starbase that is not the player's.
        foreignBasePlanetAt(x, y) {
            const p = vgap.planetAt(x, y);
            if (!p || p.ownerid === vgap.player.id) return null;
            return p.isbase || vgap.getStarbase(p.id) ? p : null;
        },
        samePoint(x1, y1, x2, y2) {
            return vgap.isSamePoint(x1, y1, x2, y2);
        },

        path(ship) {
            return vgap.getPath(ship);
        },

        // Fuel for the whole route, the way the ship screen computes it
        // (vgapShipScreen.getFuelUsage). Includes cloak / chameleon fuel.
        fuelNeeded(ship) {
            const fuelBefore = ship.neutronium;
            let fuel = 0;
            try {
                for (const hop of vgap.getPath(ship))
                    fuel += vgap.getFuelUsage(hop.x1, hop.y1, hop.x2, hop.y2, ship);
                if (fuel === 0) {
                    fuel += vgap.cloakFuel(ship);
                    if (isFn(vgap.chameleonFuel)) fuel += vgap.chameleonFuel(ship);
                    const chunnel = isFn(vgap.isChunnelling) && vgap.isChunnelling(ship);
                    const lance = isFn(vgap.isTemporalLancing) && vgap.isTemporalLancing(ship);
                    if (chunnel || lance) fuel += 50;
                }
            } finally {
                ship.neutronium = fuelBefore; // the client's calculation changes it temporarily
            }
            return fuel;
        },

        // The ship tows this ship (a mission 6 ship at the same point).
        isTowed(ship) {
            return game.ships().some((s) => s.mission === MISSION.TOW && s.mission1target === ship.id && s.x === ship.x && s.y === ship.y);
        },

        colonistHappinessChange(planet) {
            return vgap.colonistTaxChange(planet);
        },
        nativeHappinessChange(planet) {
            return vgap.nativeTaxChange(planet);
        },

        cloneCheck(ship) {
            return vgap.cloneCheck(ship);
        },

        selectShip(id) {
            vgap.map.selectShip(id);
        },
        selectPlanet(id) {
            vgap.map.selectPlanet(id);
        },
        selectStarbase(planetId) {
            vgap.map.selectStarbase(planetId);
        },

        // Every way to end a turn in the client (dashboard, task list,
        // "Tap again to confirm") calls vgap.turnReady(true). The guard
        // receives the call's arguments and a function that passes the call
        // on to the client. Un-marking (turnReady(false)) is passed on at once.
        guardTurnReady(guard) {
            const original = vgap.turnReady;
            if (original.turnCheckerWrapped) return;
            const wrapped = function (...args) {
                const proceed = () => original.apply(this, args);
                if (args[0] !== true) return proceed();
                return guard(proceed);
            };
            wrapped.turnCheckerWrapped = true;
            vgap.turnReady = wrapped;
        },
    };

    // ---------- storage ----------

    function readJson(key, fallback) {
        try {
            const raw = localStorage.getItem(STORAGE_PREFIX + key);
            return raw ? JSON.parse(raw) : fallback;
        } catch (e) {
            return fallback;
        }
    }

    function writeJson(key, value) {
        try {
            localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
        } catch (e) {
            // storage full or blocked: the script still works for this session
        }
    }

    function loadSettings() {
        const stored = readJson("settings", {});
        const merged = { ...DEFAULT_SETTINGS, enabled: { ...DEFAULT_SETTINGS.enabled } };
        if (stored && typeof stored === "object") {
            for (const key of ["colonistHappinessMin", "nativeHappinessMin", "nativeUntaxedHappiness"])
                if (Number.isFinite(stored[key])) merged[key] = stored[key];
            if (typeof stored.warnOnEndTurn === "boolean") merged.warnOnEndTurn = stored.warnOnEndTurn;
            if (stored.enabled && typeof stored.enabled === "object")
                for (const c of CHECKS)
                    if (typeof stored.enabled[c.id] === "boolean") merged.enabled[c.id] = stored.enabled[c.id];
        }
        return merged;
    }

    // ---------- friendly code history (P5) ----------
    // The client only knows the current friendly code. To tell how long a
    // planet has had bum / dmp, the script records per game and turn:
    //   first: the codes when the turn was first seen (= the codes sent last turn)
    //   last:  the codes when last seen during that turn
    // Only own planets with bum / dmp are stored.

    function historyKey() {
        return "fc:" + (game.gameId() || "unknown");
    }

    function dangerousCodes() {
        const codes = {};
        for (const p of game.planets())
            if (DANGEROUS_PLANET_FC.test(p.friendlycode || "")) codes[p.id] = p.friendlycode.toLowerCase();
        return codes;
    }

    function recordCodes() {
        if (!compatible || !game.ready()) return;
        const turn = game.currentTurn();
        if (!turn) return;
        const history = readJson(historyKey(), {});
        const codes = dangerousCodes();
        const entry = history[turn] || { first: codes };
        entry.last = codes;
        history[turn] = entry;
        for (const t of Object.keys(history))
            if (Number(t) <= turn - KEPT_TURNS) delete history[t];
        writeJson(historyKey(), history);
        lastRecord = Date.now();
    }

    function recordCodesThrottled() {
        if (Date.now() - lastRecord >= RECORD_INTERVAL_MS) recordCodes();
    }

    // The planet's code in the previous turn, or null if unknown.
    function previousCode(planetId) {
        const turn = game.currentTurn();
        if (!turn) return null;
        const history = readJson(historyKey(), {});
        const before = history[turn - 1];
        if (before && before.last) return before.last[planetId] || null;
        const now = history[turn];
        if (now && now.first) return now.first[planetId] || null;
        return null;
    }

    // ---------- checks ----------

    const shipName = (s) => "Ship " + s.id + " " + (s.name || "");
    const planetName = (p) => "Planet " + p.id + " " + (p.name || "");

    function finding(checkId, target, text) {
        const check = CHECKS.find((c) => c.id === checkId);
        return { check: checkId, level: check.level, title: check.title, target, text };
    }

    function isMoving(ship) {
        return ship.warp > 0 && game.path(ship).length > 0;
    }

    function cargoOf(ship) {
        const parts = [];
        if (ship.clans > 0) parts.push(ship.clans + " clans");
        if (ship.duranium > 0) parts.push(ship.duranium + " Dur");
        if (ship.tritanium > 0) parts.push(ship.tritanium + " Tri");
        if (ship.molybdenum > 0) parts.push(ship.molybdenum + " Mol");
        if (ship.supplies > 0) parts.push(ship.supplies + " supplies");
        if (ship.megacredits > 0) parts.push(ship.megacredits + " MC");
        return parts;
    }

    // mkt (any case) on a ship with torpedo launchers.
    function buildsTorpedoes(ship) {
        return MAKE_TORPEDOES_FC.test(ship.friendlycode || "") && ship.torps > 0;
    }

    const shipChecks = {
        // S1: the fuel on board is less than the route needs. Arriving with 0 fuel is fine.
        S1(ship) {
            const needed = game.fuelNeeded(ship);
            if (needed > ship.neutronium)
                return "needs " + needed + " fuel for its route, has " + ship.neutronium + ".";
            return null;
        },

        // S3: missions that cannot work with the ship's equipment or target.
        S3(ship) {
            const race = game.raceId();
            const m = ship.mission;
            if ((m === MISSION.LAY_MINES || m === MISSION.LAY_HIDDEN_MINES || (m === MISSION.SPECIAL && race === RACE.CRYSTAL)) &&
                !(ship.torps > 0 && ship.ammo > 0))
                return "lays mines but has no torpedoes.";
            if (m === MISSION.MINESWEEP) {
                const fighterSweep = race === RACE.COLONIES && ship.bays > 0 && ship.ammo > 0;
                if (!(ship.beams > 0) && !fighterSweep) return "sweeps mines but has no beams" + (race === RACE.COLONIES ? " or fighters." : ".");
            }
            if (m === MISSION.TOW) {
                const target = ship.mission1target ? game.ship(ship.mission1target) : null;
                if (!target) return "tows, but no target is set.";
                if (!game.samePoint(ship.x, ship.y, target.x, target.y)) return "tows ship " + target.id + ", which is not at its position.";
            }
            if (m === MISSION.INTERCEPT || m === MISSION.CLOAK_INTERCEPT) {
                const target = ship.mission1target ? game.ship(ship.mission1target) : null;
                if (!target) return "intercepts, but the target is not set or not visible.";
            }
            return null;
        },

        // S5: cargo on board, standing at an own planet, not moving.
        // Cargo the ship works with on board is not counted: supplies on a
        // Merlin (alchemy), and minerals and MC on a torpedo ship with mkt.
        S5(ship) {
            if (isMoving(ship) || game.isTowed(ship)) return null;
            const planet = game.ownPlanetAt(ship.x, ship.y);
            if (!planet) return null;
            const counted = { ...ship };
            if (ship.hullid === HULL_MERLIN) counted.supplies = 0;
            if (buildsTorpedoes(ship))
                counted.duranium = counted.tritanium = counted.molybdenum = counted.megacredits = 0;
            const cargo = cargoOf(counted);
            if (cargo.length === 0) return null;
            return "stays at " + planetName(planet) + " with " + cargo.join(", ") + ". Unloading forgotten?";
        },

        // S6: no destination and mission Explore (the default). Not repeated
        // for ships S5 reports, and not for a Merlin set to make one mineral
        // (alm / ald / alt, any case).
        S6(ship) {
            if (game.path(ship).length > 0 || ship.mission !== MISSION.EXPLORE || game.isTowed(ship)) return null;
            if (ship.hullid === HULL_MERLIN && ALCHEMY_FC.test(ship.friendlycode || "")) return null;
            if (settings.enabled.S5 && shipChecks.S5(ship)) return null;
            return "has no destination and no mission.";
        },

        // S8: mkt / lfm / HYP (exact spelling) while at a foreign starbase.
        S8(ship) {
            if (!FOREIGN_BASE_FC.includes(ship.friendlycode)) return null;
            const planet = game.foreignBasePlanetAt(ship.x, ship.y);
            if (!planet) return null;
            return "has friendly code " + ship.friendlycode + " at the foreign starbase of " + planetName(planet) + ".";
        },
    };

    const planetChecks = {
        // P1: colonist happiness after this turn's tax change ends below the threshold.
        P1(planet) {
            if (!(planet.clans > 0)) return null;
            const change = game.colonistHappinessChange(planet);
            const after = planet.colonisthappypoints + change;
            if (change < 0 && after < settings.colonistHappinessMin)
                return "colonist happiness " + planet.colonisthappypoints + " → " + after + " (tax " + planet.colonisttaxrate + "%).";
            return null;
        },

        // P2: native happiness after this turn's tax change ends below the threshold.
        P2(planet) {
            if (!(planet.nativeclans > 0)) return null;
            const change = game.nativeHappinessChange(planet);
            const after = planet.nativehappypoints + change;
            if (change < 0 && after < settings.nativeHappinessMin)
                return "native happiness " + planet.nativehappypoints + " → " + after + " (tax " + planet.nativetaxrate + "%).";
            return null;
        },

        // P3: natives at 0% tax although their happiness is at the threshold or above.
        P3(planet) {
            if (!(planet.nativeclans > 0) || planet.nativetype === NATIVE_AMORPHOUS || planet.nativeautotax) return null;
            if (planet.nativetaxrate === 0 && planet.nativehappypoints >= settings.nativeUntaxedHappiness)
                return "natives pay no tax at happiness " + planet.nativehappypoints + ".";
            return null;
        },

        // P5: bum / dmp (any case) now, and the same code in the previous turn.
        P5(planet) {
            const code = planet.friendlycode || "";
            if (!DANGEROUS_PLANET_FC.test(code)) return null;
            const before = previousCode(planet.id);
            if (before && before === code.toLowerCase())
                return "friendly code " + code + " is set for at least 2 turns.";
            return null;
        },
    };

    // B1: ships with cln (any case) at an own starbase whose planet lacks the minerals.
    function cloneFinding(ship) {
        if (!CLONE_FC.test(ship.friendlycode || "")) return null;
        const planet = game.ownPlanetAt(ship.x, ship.y);
        if (!planet || !game.starbase(planet.id)) return null;
        const check = game.cloneCheck(ship);
        const missing = [];
        for (const [key, label] of [["duranium", "Dur"], ["tritanium", "Tri"], ["molybdenum", "Mol"]])
            if (check[key] && !check[key].ok) missing.push(label + " " + planet[key] + "/" + check[key].val);
        if (missing.length === 0) return null;
        return finding("B1", { type: "starbase", id: planet.id },
            shipName(ship) + " has cln at " + planetName(planet) + ", minerals too low: " + missing.join(", ") + ".");
    }

    function runChecks() {
        const findings = [];
        const failed = [];
        const guard = (label, fn) => {
            try {
                fn();
            } catch (e) {
                failed.push(label);
                console.warn("[" + PLUGIN_NAME + "] check failed: " + label, e);
            }
        };

        for (const ship of game.ships()) {
            for (const [id, check] of Object.entries(shipChecks)) {
                if (!settings.enabled[id]) continue;
                guard(id + " " + shipName(ship), () => {
                    const text = check(ship);
                    if (text) findings.push(finding(id, { type: "ship", id: ship.id }, shipName(ship) + " " + text));
                });
            }
            if (settings.enabled.B1)
                guard("B1 " + shipName(ship), () => {
                    const f = cloneFinding(ship);
                    if (f) findings.push(f);
                });
        }
        for (const planet of game.planets()) {
            for (const [id, check] of Object.entries(planetChecks)) {
                if (!settings.enabled[id]) continue;
                guard(id + " " + planetName(planet), () => {
                    const text = check(planet);
                    if (text) findings.push(finding(id, { type: "planet", id: planet.id }, planetName(planet) + ": " + text));
                });
            }
        }
        return { findings, failed };
    }

    // ---------- panel ----------

    function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    }

    function renderFindings() {
        const list = panel.querySelector("#tc-results");
        if (!compatible) {
            list.innerHTML = "";
            return;
        }
        if (!game.ready()) {
            list.innerHTML = "<div class='tc-empty'>Open a game first.</div>";
            return;
        }
        if (!game.currentTurn()) {
            list.innerHTML = "<div class='tc-empty'>A past turn is shown. Checks run on the current turn only.</div>";
            return;
        }
        recordCodes();
        const { findings, failed } = runChecks();
        const errors = findings.filter((f) => f.level === "error");
        const hints = findings.filter((f) => f.level === "hint");

        const group = (title, items, cls) => {
            if (items.length === 0) return "";
            let html = "<div class='tc-group " + cls + "'><div class='tc-group-title'>" + escapeHtml(title) + " (" + items.length + ")</div>";
            for (const f of items)
                html += "<div class='tc-item' data-type='" + escapeHtml(f.target.type) + "' data-id='" + escapeHtml(f.target.id) + "'" +
                    " title='" + escapeHtml(f.check + ": " + f.title) + "'><span class='tc-code'>" + escapeHtml(f.check) + "</span> " +
                    escapeHtml(f.text) + "</div>";
            return html + "</div>";
        };

        let html = "";
        if (findings.length === 0) html += "<div class='tc-ok'>No findings.</div>";
        html += group("Errors", errors, "tc-errors") + group("Hints", hints, "tc-hints");
        if (failed.length > 0)
            html += "<div class='tc-failed'>" + failed.length + " checks failed to run (see browser console).</div>";
        list.innerHTML = html;
    }

    function renderSettings() {
        const box = panel.querySelector("#tc-settings");
        let html = "<label class='tc-check'><input type='checkbox' data-setting-flag='warnOnEndTurn'" + (settings.warnOnEndTurn ? " checked" : "") +
            "> Warn on End Turn when there are errors</label>";
        for (const c of CHECKS)
            html += "<label class='tc-check'><input type='checkbox' data-check='" + c.id + "'" + (settings.enabled[c.id] ? " checked" : "") +
                "> <span class='tc-code'>" + c.id + "</span> " + escapeHtml(c.title) + "</label>";
        html +=
            "<label class='tc-num'>P1 colonist happiness below <input type='number' min='0' max='100' data-setting='colonistHappinessMin' value='" + settings.colonistHappinessMin + "'></label>" +
            "<label class='tc-num'>P2 native happiness below <input type='number' min='0' max='100' data-setting='nativeHappinessMin' value='" + settings.nativeHappinessMin + "'></label>" +
            "<label class='tc-num'>P3 native happiness at least <input type='number' min='0' max='100' data-setting='nativeUntaxedHappiness' value='" + settings.nativeUntaxedHappiness + "'></label>" +
            "<button id='tc-defaults'>Reset to defaults</button>";
        box.innerHTML = html;
    }

    function createPanel() {
        const style = document.createElement("style");
        style.textContent = `
#tc-toggle { position: fixed; left: 110px; bottom: 10px; z-index: 10001; padding: 6px 10px; background: #1d2533; color: #7fd4ff;
  border: 1px solid #7fd4ff; border-radius: 4px; font: 13px sans-serif; cursor: pointer; display: none; }
#tc-panel { position: fixed; left: 110px; bottom: 46px; z-index: 10001; width: 380px; max-height: 70vh; overflow-y: auto;
  background: rgba(20, 26, 38, 0.96); color: #dde; border: 1px solid #7fd4ff; border-radius: 4px; padding: 10px;
  font: 12px sans-serif; display: none; }
#tc-panel button { background: #2b3850; color: #dde; border: 1px solid #556; border-radius: 3px; padding: 3px 8px; cursor: pointer; font: 12px sans-serif; }
#tc-panel .tc-bar { display: flex; gap: 6px; margin-bottom: 8px; }
#tc-panel .tc-group { margin-bottom: 8px; }
#tc-panel .tc-group-title { font-weight: bold; margin-bottom: 3px; }
#tc-panel .tc-errors .tc-group-title { color: #ff7b7b; }
#tc-panel .tc-hints .tc-group-title { color: #ffcc66; }
#tc-panel .tc-item { padding: 3px 4px; border-radius: 3px; cursor: pointer; }
#tc-panel .tc-item:hover { background: #2b3850; }
#tc-panel .tc-code { color: #889; font-family: monospace; }
#tc-panel .tc-ok { color: #7fdc8f; margin-bottom: 8px; }
#tc-panel .tc-empty, #tc-panel .tc-failed { color: #aab; }
#tc-panel .tc-failed { color: #ff9b9b; }
#tc-settings { display: none; border-top: 1px solid #445; padding-top: 8px; margin-top: 8px; }
#tc-settings label { display: block; margin-bottom: 4px; }
#tc-settings input[type=number] { width: 50px; background: #111824; color: #dde; border: 1px solid #556; }
#tc-confirm-overlay { position: fixed; inset: 0; z-index: 10010; background: rgba(0, 0, 0, 0.55); display: flex;
  align-items: center; justify-content: center; }
#tc-confirm { width: 420px; max-width: calc(100vw - 32px); max-height: 70vh; overflow-y: auto; background: #141a26; color: #dde;
  border: 1px solid #ff7b7b; border-radius: 4px; padding: 14px; font: 13px sans-serif; }
#tc-confirm h3 { margin: 0 0 8px; color: #ff7b7b; font-size: 15px; }
#tc-confirm ul { margin: 0 0 12px; padding-left: 18px; }
#tc-confirm li { margin-bottom: 3px; }
#tc-confirm .tc-bar { display: flex; gap: 6px; justify-content: flex-end; }
#tc-confirm button { background: #2b3850; color: #dde; border: 1px solid #556; border-radius: 3px; padding: 4px 10px; cursor: pointer; font: 13px sans-serif; }
#tc-confirm button.tc-danger { border-color: #ff7b7b; color: #ffb0b0; }
#tc-compat { display: none; color: #ff7b7b; border: 1px solid #ff7b7b; border-radius: 3px; padding: 4px; margin-bottom: 8px; }
`;
        document.head.appendChild(style);

        const toggle = document.createElement("button");
        toggle.id = "tc-toggle";
        toggle.textContent = "Check turn";
        document.body.appendChild(toggle);

        panel = document.createElement("div");
        panel.id = "tc-panel";
        panel.innerHTML =
            "<div id='tc-compat'></div>" +
            "<div class='tc-bar'><button id='tc-recheck'>Check again</button><button id='tc-settings-toggle'>Settings</button>" +
            "<button id='tc-close'>Close</button></div>" +
            "<div id='tc-results'></div><div id='tc-settings'></div>";
        document.body.appendChild(panel);
        renderSettings();

        toggle.addEventListener("click", () => {
            const open = panel.style.display !== "block";
            panel.style.display = open ? "block" : "none";
            if (open) renderFindings();
        });
        panel.querySelector("#tc-recheck").addEventListener("click", renderFindings);
        panel.querySelector("#tc-close").addEventListener("click", () => (panel.style.display = "none"));
        panel.querySelector("#tc-settings-toggle").addEventListener("click", () => {
            const box = panel.querySelector("#tc-settings");
            box.style.display = box.style.display === "block" ? "none" : "block";
        });

        panel.querySelector("#tc-results").addEventListener("click", (e) => {
            const item = e.target.closest && e.target.closest(".tc-item");
            if (!item || !compatible) return;
            const id = parseInt(item.getAttribute("data-id"), 10);
            const type = item.getAttribute("data-type");
            try {
                if (type === "ship") game.selectShip(id);
                else if (type === "planet") game.selectPlanet(id);
                else if (type === "starbase") game.selectStarbase(id);
            } catch (err) {
                console.warn("[" + PLUGIN_NAME + "] could not select " + type + " " + id, err);
            }
        });

        const settingsBox = panel.querySelector("#tc-settings");
        settingsBox.addEventListener("change", (e) => {
            const check = e.target.getAttribute("data-check");
            const key = e.target.getAttribute("data-setting");
            const flag = e.target.getAttribute("data-setting-flag");
            if (check) settings.enabled[check] = e.target.checked;
            if (flag) settings[flag] = e.target.checked;
            if (key) {
                const value = parseInt(e.target.value, 10);
                if (Number.isFinite(value)) settings[key] = Math.max(0, Math.min(100, value));
                e.target.value = settings[key];
            }
            writeJson("settings", settings);
            renderFindings();
        });
        settingsBox.addEventListener("click", (e) => {
            if (e.target.id !== "tc-defaults") return;
            settings = { ...DEFAULT_SETTINGS, enabled: { ...DEFAULT_SETTINGS.enabled } };
            writeJson("settings", settings);
            renderSettings();
            renderFindings();
        });

        return toggle;
    }

    // ---------- end turn warning ----------

    const MAX_LISTED_ERRORS = 10;

    // Called instead of the client's turnReady(true). Ends the turn at once
    // when there are no errors; otherwise asks first. The script never ends a
    // turn on its own: proceed() only passes on the player's own click.
    function onEndTurn(proceed) {
        let errors = [];
        try {
            if (settings.warnOnEndTurn && compatible && game.ready() && game.currentTurn()) {
                recordCodes();
                errors = runChecks().findings.filter((f) => f.level === "error");
            }
        } catch (e) {
            console.warn("[" + PLUGIN_NAME + "] end turn check failed", e);
            errors = [];
        }
        if (errors.length === 0) return proceed();
        showEndTurnWarning(errors, proceed);
    }

    function showEndTurnWarning(errors, proceed) {
        const old = document.getElementById("tc-confirm-overlay");
        if (old) old.remove();

        const overlay = document.createElement("div");
        overlay.id = "tc-confirm-overlay";
        let items = "";
        for (const f of errors.slice(0, MAX_LISTED_ERRORS))
            items += "<li><span class='tc-code'>" + escapeHtml(f.check) + "</span> " + escapeHtml(f.text) + "</li>";
        if (errors.length > MAX_LISTED_ERRORS) items += "<li>… and " + (errors.length - MAX_LISTED_ERRORS) + " more</li>";
        overlay.innerHTML =
            "<div id='tc-confirm'><h3>Turn checker: " + errors.length + " error" + (errors.length === 1 ? "" : "s") + "</h3>" +
            "<ul>" + items + "</ul><div class='tc-bar'>" +
            "<button id='tc-confirm-show'>Show findings</button>" +
            "<button id='tc-confirm-cancel'>Cancel</button>" +
            "<button id='tc-confirm-end' class='tc-danger'>End turn anyway</button></div></div>";
        document.body.appendChild(overlay);

        const close = () => overlay.remove();
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) close();
        });
        overlay.querySelector("#tc-confirm-cancel").addEventListener("click", close);
        overlay.querySelector("#tc-confirm-show").addEventListener("click", () => {
            close();
            panel.style.display = "block";
            renderFindings();
        });
        overlay.querySelector("#tc-confirm-end").addEventListener("click", () => {
            close();
            proceed();
        });
    }

    function checkCompatibility() {
        const missing = game.missingFeatures();
        compatible = missing.length === 0;
        const box = panel.querySelector("#tc-compat");
        if (compatible) {
            box.style.display = "none";
            return;
        }
        box.style.display = "block";
        box.innerHTML = "The planets.nu client has changed. The turn checker is off because it no longer finds: " +
            missing.map(escapeHtml).join(", ") + ".";
    }

    // ---------- start ----------

    function init() {
        if (!game.loaded()) {
            setTimeout(init, 500);
            return;
        }
        const toggle = createPanel();

        const onGameShown = () => {
            if (!game.ready()) return;
            toggle.style.display = "block";
            checkCompatibility();
            if (compatible) game.guardTurnReady(onEndTurn);
            recordCodes();
        };

        game.registerPlugin({
            processload: onGameShown,
            loadmap: onGameShown,
            showmap: onGameShown,
            draw: recordCodesThrottled,
            loadplanet: recordCodesThrottled,
            showdashboard: () => {
                toggle.style.display = "none";
                panel.style.display = "none";
            },
        }, PLUGIN_NAME);

        // The script may start after a game is already open.
        onGameShown();
    }

    init();
})();
