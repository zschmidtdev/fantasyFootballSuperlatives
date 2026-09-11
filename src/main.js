/**
 * espnFantasyLineupDiff.js
 *
 * For an ESPN Fantasy Football league:
 *   - Actual vs. projected starting-lineup points, for a week or the season.
 *   - Actual starting lineup vs. the best-possible ("optimal") lineup from
 *     the full roster, i.e. points left on the bench.
 *
 * This file is both a library (require it to use the exported functions in
 * your own code) AND a command-line tool (run it directly with `node`).
 *
 * ---------------------------------------------------------------------------
 * CLI USAGE
 * ---------------------------------------------------------------------------
 * You must always pass a comparison mode: --projected (-p) for actual vs.
 * ESPN's pre-game projections, or --optimal (-o) for actual starting lineup
 * vs. the best-possible legal lineup from the full roster (points left on
 * the bench).
 *
 * Single week:
 *   node espnFantasyLineupDiff.js --week 3 --projected
 *   node espnFantasyLineupDiff.js --week 3 --optimal
 *
 * Whole season (sums the chosen comparison across every played week):
 *   node espnFantasyLineupDiff.js --all --projected
 *   node espnFantasyLineupDiff.js --all --optimal
 *
 * The league ID is hardcoded to 628846 (see LEAGUE_ID near the top of this
 * file) — no need to pass it as a flag or env var. Season still needs to be
 * supplied since it changes every year.
 *
 * Season and, for private leagues, auth can come from env vars so you don't
 * have to retype them:
 *   ESPN_SEASON_ID=2026
 *   ESPN_S2=...        (private leagues only)
 *   ESPN_SWID=...       (private leagues only, include the curly braces)
 *
 * Flags:
 *   --week, -w <n>       NFL week number (single-week mode)
 *   --all, -a            Run across the whole season instead of one week
 *   --start-week <n>     First week to include (implies range mode; default 1)
 *   --end-week <n>       Last week to include (implies range mode; default 18)
 *   --season, -s <yr>    NFL season year, e.g. 2026 (or set ESPN_SEASON_ID)
 *   --json               Print raw JSON instead of a table
 *   --players            Single-week mode: print each starter's actual/projected/diff
 *   --weekly             --all mode: also print each team's week-by-week breakdown
 *   --verbose            --all mode: log which weeks got skipped and why
 *   -o, --optimal        REQUIRED (pick one): actual starting lineup vs. best-possible
 *                         lineup from the full roster
 *   -p, --projected       REQUIRED (pick one): actual points vs. ESPN's pre-game projections
 *
 * Examples:
 *   node espnFantasyLineupDiff.js -w 3 -p
 *   node espnFantasyLineupDiff.js -w 3 -p --json > week3.json
 *   node espnFantasyLineupDiff.js -w 3 -p --players
 *   node espnFantasyLineupDiff.js -w 3 -o
 *   node espnFantasyLineupDiff.js --all -p
 *   node espnFantasyLineupDiff.js --all -p --weekly --verbose
 *   node espnFantasyLineupDiff.js --all -p --start-week 1 --end-week 10
 *   node espnFantasyLineupDiff.js --all -o --weekly
 *   node espnFantasyLineupDiff.js -o --start-week 4 --end-week 8   (range without --all)
 *
 * Tip: put your env vars in a .env file and load them with
 *   node --env-file=.env espnFantasyLineupDiff.js -w 3
 * (Node 20.6+). On older Node, use the `dotenv` package instead.
 *
 * ---------------------------------------------------------------------------
 * USE AS A LIBRARY
 * ---------------------------------------------------------------------------
 *   const {
 *     getWeeklyLineupDiffs,
 *     getSeasonLineupDiffs,
 *     getOptimalLineupDiffs,
 *     getSeasonOptimalLineupDiffs,
 *   } = require('./espnFantasyLineupDiff');
 *
 * Requires Node 18+ (for global fetch). If you're on an older Node, install
 * node-fetch and swap in `const fetch = require('node-fetch');`.
 *
 * ---------------------------------------------------------------------------
 * AUTH (private leagues)
 * ---------------------------------------------------------------------------
 * Public leagues need no auth. Private leagues need two cookies from a
 * logged-in browser session at fantasy.espn.com:
 *   - espn_s2
 *   - SWID   (including the curly braces, e.g. "{ABC123...}")
 *
 * Get them via your browser's DevTools -> Application/Storage -> Cookies
 * while on your league page.
 *
 * ---------------------------------------------------------------------------
 * IMPORTANT CAVEAT ABOUT "PROJECTIONS RIGHT BEFORE KICKOFF"
 * ---------------------------------------------------------------------------
 * ESPN's API only exposes the CURRENT value stored for a stat entry — there
 * is no historical/versioned endpoint that lets you ask "what was the
 * projection at timestamp X". In practice, ESPN freezes a player's
 * projection once their game starts (it does not recalculate projections
 * mid-game the way it updates actuals), so for any week that has already
 * been played, the projection value returned today is generally the same
 * value that was showing immediately before kickoff. But this is a behavior
 * of ESPN's system, not a documented guarantee — if you need a truly
 * point-in-time snapshot, you'd need to poll and store projections yourself
 * before each week's games start.
 */

const BASE_URL = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons';

// Hardcoded to your league — no need to pass leagueId as a param or env var.
const LEAGUE_ID = 628846;

// Roster slot IDs that are NOT part of the starting lineup.
const BENCH_SLOT_ID = 20;
const IR_SLOT_ID = 21;
const NON_STARTING_SLOTS = new Set([BENCH_SLOT_ID, IR_SLOT_ID]);

// Stat source IDs used by ESPN's player stat entries.
const STAT_SOURCE_ACTUAL = 0;
const STAT_SOURCE_PROJECTED = 1;

/**
 * Fetch actual vs. projected starting-lineup points for every team in a
 * league, for a single NFL week.
 *
 * @param {number} week - NFL week number (this maps to ESPN's scoringPeriodId).
 * @param {Object} config
 * @param {number|string} [config.leagueId] - Overrides the hardcoded LEAGUE_ID.
 * @param {number|string} config.seasonId - The NFL season year, e.g. 2026.
 * @param {string} [config.espnS2] - espn_s2 cookie value (private leagues only).
 * @param {string} [config.swid] - SWID cookie value (private leagues only).
 * @returns {Promise<Array<{
 *   teamId: number,
 *   teamName: string,
 *   actualPoints: number,
 *   projectedPoints: number,
 *   difference: number,
 *   starters: Array<Object>
 * }>>}
 */
async function getWeeklyLineupDiffs(week, config) {
  const { seasonId, espnS2, swid } = config;
  const leagueId = config.leagueId || LEAGUE_ID;

  if (!seasonId) {
    throw new Error('seasonId is required');
  }
  if (!week || week < 1) {
    throw new Error('week must be a positive integer (NFL week number)');
  }

  const url =
    `${BASE_URL}/${seasonId}/segments/0/leagues/${leagueId}` +
    `?view=mRoster&view=mMatchup&view=mMatchupScore&view=mTeam` +
    `&scoringPeriodId=${week}`;

  const headers = { Accept: 'application/json' };
  if (espnS2 && swid) {
    // Private league auth via cookies.
    headers.Cookie = `espn_s2=${espnS2}; SWID=${swid};`;
  }

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(
      `ESPN API request failed: ${res.status} ${res.statusText}. ` +
      `If this is a private league, double-check espn_s2/SWID.`
    );
  }
  const data = await res.json();

  const teamNameById = buildTeamNameMap(data.teams || []);

  // In this view, rosters for the requested week live under each team's
  // `roster.entries` when scoringPeriodId is passed on the request.
  const results = (data.teams || []).map((team) => {
    const entries = (team.roster && team.roster.entries) || [];

    const starters = entries.filter(
      (e) => !NON_STARTING_SLOTS.has(e.lineupSlotId)
    );

    let actualPoints = 0;
    let projectedPoints = 0;

    const starterDetails = starters.map((entry) => {
      const player = entry.playerPoolEntry && entry.playerPoolEntry.player;
      const stats = (player && player.stats) || [];

      const actualStat = stats.find(
        (s) =>
          s.scoringPeriodId === week &&
          s.statSourceId === STAT_SOURCE_ACTUAL &&
          s.statSplitTypeId === 1
      );
      const projectedStat = stats.find(
        (s) =>
          s.scoringPeriodId === week &&
          s.statSourceId === STAT_SOURCE_PROJECTED &&
          s.statSplitTypeId === 1
      );

      const actual = actualStat ? actualStat.appliedTotal || 0 : 0;
      const projected = projectedStat ? projectedStat.appliedTotal || 0 : 0;

      actualPoints += actual;
      projectedPoints += projected;

      return {
        playerId: player ? player.id : entry.playerId,
        name: player ? player.fullName : 'Unknown player',
        lineupSlotId: entry.lineupSlotId,
        actual: round2(actual),
        projected: round2(projected),
        difference: round2(actual - projected),
      };
    });

    return {
      teamId: team.id,
      teamName: teamNameById.get(team.id) || `Team ${team.id}`,
      actualPoints: round2(actualPoints),
      projectedPoints: round2(projectedPoints),
      difference: round2(actualPoints - projectedPoints),
      starters: starterDetails,
    };
  });

  // Sort best-outperformers-of-projection first.
  results.sort((a, b) => b.difference - a.difference);

  return results;
}

function buildTeamNameMap(teams) {
  const map = new Map();
  for (const t of teams) {
    const name =
      (t.location && t.nickname && `${t.location} ${t.nickname}`.trim()) ||
      t.name ||
      `Team ${t.id}`;
    map.set(t.id, name);
  }
  return map;
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Same as getWeeklyLineupDiffs, but run across a whole range of weeks
 * (defaults to the full 18-week NFL regular season) and summed per team.
 *
 * Weeks that error out (not yet played, or bad request) or that come back
 * with zero actual points across the board (game hasn't happened yet) are
 * skipped automatically, so you can safely run this mid-season without
 * specifying an end week.
 *
 * @param {Object} config - Same shape as getWeeklyLineupDiffs's config.
 * @param {Object} [options]
 * @param {number} [options.startWeek=1] - First week to include.
 * @param {number} [options.endWeek=18] - Last week to include.
 * @param {boolean} [options.verbose=false] - Log which weeks get skipped and why.
 * @param {(week: number, weekResults: Array) => void} [options.onWeekComplete]
 *   Optional callback fired after each week finishes fetching — handy for
 *   progress output ("Fetched week 4/18...").
 * @returns {Promise<Array<{
 *   teamId: number,
 *   teamName: string,
 *   actualPoints: number,
 *   projectedPoints: number,
 *   difference: number,
 *   weeks: Array<{ week: number, actualPoints: number, projectedPoints: number, difference: number }>
 * }>>}
 */
async function getSeasonLineupDiffs(config, options = {}) {
  const startWeek = options.startWeek || 1;
  const endWeek = options.endWeek || 18;
  const verbose = !!options.verbose;

  const perTeamTotals = new Map();

  for (let week = startWeek; week <= endWeek; week++) {
    let weekResults;
    try {
      weekResults = await getWeeklyLineupDiffs(week, config);
    } catch (err) {
      if (verbose) {
        console.warn(`Skipping week ${week}: ${err.message}`);
      }
      continue;
    }

    // A week that hasn't happened yet (or a future bye in the schedule)
    // comes back with everyone at 0 actual points — skip it rather than
    // let it drag the season totals toward "underperformed projection".
    const hasAnyActual = weekResults.some((t) => t.actualPoints > 0);
    if (!hasAnyActual) {
      if (verbose) {
        console.warn(`Skipping week ${week}: no actual points recorded yet.`);
      }
      continue;
    }

    for (const team of weekResults) {
      if (!perTeamTotals.has(team.teamId)) {
        perTeamTotals.set(team.teamId, {
          teamId: team.teamId,
          teamName: team.teamName,
          actualPoints: 0,
          projectedPoints: 0,
          difference: 0,
          weeks: [],
        });
      }
      const totals = perTeamTotals.get(team.teamId);
      totals.actualPoints += team.actualPoints;
      totals.projectedPoints += team.projectedPoints;
      totals.difference += team.difference;
      totals.weeks.push({
        week,
        actualPoints: team.actualPoints,
        projectedPoints: team.projectedPoints,
        difference: team.difference,
      });
    }

    if (typeof options.onWeekComplete === 'function') {
      options.onWeekComplete(week, weekResults);
    }
  }

  const results = Array.from(perTeamTotals.values()).map((t) => ({
    ...t,
    actualPoints: round2(t.actualPoints),
    projectedPoints: round2(t.projectedPoints),
    difference: round2(t.difference),
  }));

  results.sort((a, b) => b.difference - a.difference);

  return results;
}

/**
 * ---------------------------------------------------------------------------
 * OPTIMAL LINEUP (points left on the bench)
 * ---------------------------------------------------------------------------
 * Compares what a team actually started against the highest-scoring legal
 * lineup they could have started that week, given their full roster
 * (starters + bench + IR) and each player's position eligibility.
 *
 * "Legal" means respecting the league's actual roster requirements (e.g. you
 * can't start 3 RBs if your league only has 2 RB slots + 1 FLEX) — this is
 * solved as an exact optimal assignment problem (bitmask DP), not a naive
 * "swap in anyone with more points" heuristic, since FLEX/eligibility
 * overlaps make that non-trivial to get right by hand.
 *
 * difference = actualStartingPoints - optimalPoints
 *   0   -> they started the best possible lineup
 *   < 0 -> they left that many points on the bench
 */

/**
 * Fetch each team's actual starting-lineup points vs. their optimal
 * (best-possible-legal) starting-lineup points for a single NFL week.
 *
 * @param {number} week - NFL week number (maps to ESPN's scoringPeriodId).
 * @param {Object} config - Same shape as getWeeklyLineupDiffs's config.
 * @returns {Promise<Array<{
 *   teamId: number,
 *   teamName: string,
 *   actualStartingPoints: number,
 *   optimalPoints: number,
 *   difference: number,
 *   startingLineup: Array<{ name: string, slotId: number, points: number }>,
 *   optimalLineup: Array<{ name: string, slotId: number, points: number }>
 * }>>}
 */
async function getOptimalLineupDiffs(week, config) {
  const { seasonId, espnS2, swid } = config;
  const leagueId = config.leagueId || LEAGUE_ID;

  if (!seasonId) {
    throw new Error('seasonId is required');
  }
  if (!week || week < 1) {
    throw new Error('week must be a positive integer (NFL week number)');
  }

  const url =
    `${BASE_URL}/${seasonId}/segments/0/leagues/${leagueId}` +
    `?view=mRoster&view=mMatchup&view=mMatchupScore&view=mTeam&view=mSettings` +
    `&scoringPeriodId=${week}`;

  const headers = { Accept: 'application/json' };
  if (espnS2 && swid) {
    headers.Cookie = `espn_s2=${espnS2}; SWID=${swid};`;
  }

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(
      `ESPN API request failed: ${res.status} ${res.statusText}. ` +
      `If this is a private league, double-check espn_s2/SWID.`
    );
  }
  const data = await res.json();

  const teamNameById = buildTeamNameMap(data.teams || []);

  const lineupSlotCounts =
    (data.settings &&
      data.settings.rosterSettings &&
      data.settings.rosterSettings.lineupSlotCounts) ||
    {};
  const startingSlots = buildStartingSlotList(lineupSlotCounts);

  const results = (data.teams || []).map((team) => {
    const entries = (team.roster && team.roster.entries) || [];

    // Full roster (starters + bench + IR) — the optimal lineup can pull
    // from anyone here, not just the players who actually started.
    const players = entries.map((entry) => {
      const player = entry.playerPoolEntry && entry.playerPoolEntry.player;
      const stats = (player && player.stats) || [];
      const actualStat = stats.find(
        (s) =>
          s.scoringPeriodId === week &&
          s.statSourceId === STAT_SOURCE_ACTUAL &&
          s.statSplitTypeId === 1
      );
      const points = actualStat ? actualStat.appliedTotal || 0 : 0;

      return {
        playerId: player ? player.id : entry.playerId,
        name: player ? player.fullName : 'Unknown player',
        points: round2(points),
        eligibleSlots: (player && player.eligibleSlots) || [],
        currentSlotId: entry.lineupSlotId,
      };
    });

    const actualStartingPoints = round2(
      players
        .filter((p) => !NON_STARTING_SLOTS.has(p.currentSlotId))
        .reduce((sum, p) => sum + p.points, 0)
    );
    const startingLineup = players
      .filter((p) => !NON_STARTING_SLOTS.has(p.currentSlotId))
      .map((p) => ({ name: p.name, slotId: p.currentSlotId, points: p.points }));

    const optimal = computeOptimalAssignment(players, startingSlots);
    const optimalLineup = optimal.assignment
      .filter((a) => a.player)
      .map((a) => ({ name: a.player.name, slotId: a.slotId, points: a.player.points }));

    return {
      teamId: team.id,
      teamName: teamNameById.get(team.id) || `Team ${team.id}`,
      actualStartingPoints,
      optimalPoints: round2(optimal.points),
      difference: round2(actualStartingPoints - optimal.points),
      startingLineup,
      optimalLineup,
    };
  });

  // Worst lineup decisions (most points left on the bench) first.
  results.sort((a, b) => a.difference - b.difference);

  return results;
}

/**
 * Same as getOptimalLineupDiffs, but summed across a range of weeks
 * (defaults to the full 18-week regular season). Weeks with no actual
 * points recorded yet (not played) are skipped automatically.
 *
 * @param {Object} config - Same shape as getWeeklyLineupDiffs's config.
 * @param {Object} [options]
 * @param {number} [options.startWeek=1]
 * @param {number} [options.endWeek=18]
 * @param {boolean} [options.verbose=false]
 * @param {(week: number, weekResults: Array) => void} [options.onWeekComplete]
 * @returns {Promise<Array<{
 *   teamId: number,
 *   teamName: string,
 *   actualStartingPoints: number,
 *   optimalPoints: number,
 *   difference: number,
 *   weeks: Array<{ week: number, actualStartingPoints: number, optimalPoints: number, difference: number }>
 * }>>}
 */
async function getSeasonOptimalLineupDiffs(config, options = {}) {
  const startWeek = options.startWeek || 1;
  const endWeek = options.endWeek || 18;
  const verbose = !!options.verbose;

  const perTeamTotals = new Map();

  for (let week = startWeek; week <= endWeek; week++) {
    let weekResults;
    try {
      weekResults = await getOptimalLineupDiffs(week, config);
    } catch (err) {
      if (verbose) console.warn(`Skipping week ${week}: ${err.message}`);
      continue;
    }

    const hasAnyActual = weekResults.some((t) => t.actualStartingPoints > 0);
    if (!hasAnyActual) {
      if (verbose) console.warn(`Skipping week ${week}: no actual points recorded yet.`);
      continue;
    }

    for (const team of weekResults) {
      if (!perTeamTotals.has(team.teamId)) {
        perTeamTotals.set(team.teamId, {
          teamId: team.teamId,
          teamName: team.teamName,
          actualStartingPoints: 0,
          optimalPoints: 0,
          difference: 0,
          weeks: [],
        });
      }
      const totals = perTeamTotals.get(team.teamId);
      totals.actualStartingPoints += team.actualStartingPoints;
      totals.optimalPoints += team.optimalPoints;
      totals.difference += team.difference;
      totals.weeks.push({
        week,
        actualStartingPoints: team.actualStartingPoints,
        optimalPoints: team.optimalPoints,
        difference: team.difference,
      });
    }

    if (typeof options.onWeekComplete === 'function') {
      options.onWeekComplete(week, weekResults);
    }
  }

  const results = Array.from(perTeamTotals.values()).map((t) => ({
    ...t,
    actualStartingPoints: round2(t.actualStartingPoints),
    optimalPoints: round2(t.optimalPoints),
    difference: round2(t.difference),
  }));

  results.sort((a, b) => a.difference - b.difference);

  return results;
}

/**
 * Expand a league's lineupSlotCounts (e.g. { "0": 1, "2": 2, "23": 1, ... })
 * into a flat list of individual starting-slot instances, e.g.
 * [0, 2, 2, 23] for 1 QB, 2 RB, 1 FLEX. Bench (20) and IR (21) are excluded
 * since those aren't "starting" slots.
 */
function buildStartingSlotList(lineupSlotCounts) {
  const slots = [];
  for (const [slotIdStr, count] of Object.entries(lineupSlotCounts)) {
    const slotId = Number(slotIdStr);
    if (NON_STARTING_SLOTS.has(slotId)) continue;
    for (let i = 0; i < count; i++) slots.push(slotId);
  }
  return slots;
}

/**
 * Exact max-points assignment of players to starting slots, respecting each
 * player's position eligibility. Solved via bitmask DP over "which players
 * have been used so far" — small enough to brute-force exactly for a normal
 * roster size (~15-16 players, ~9-10 starting slots), so this always finds
 * the true optimum rather than an approximation.
 *
 * @param {Array<{points:number, eligibleSlots:number[]}>} players
 * @param {number[]} slots - Flat list of starting-slot IDs to fill.
 * @returns {{ points: number, assignment: Array<{slotId:number, player:Object|null}> }}
 */
function computeOptimalAssignment(players, slots) {
  const n = players.length;
  const memo = new Map();

  function rec(slotIdx, usedMask) {
    if (slotIdx === slots.length) return { points: 0, assignment: [] };

    const key = slotIdx * 2 ** 20 + usedMask; // safe unique key for n <= 20-ish rosters
    const cached = memo.get(key);
    if (cached) return cached;

    const slotId = slots[slotIdx];

    // Baseline: leave this slot empty (only relevant if no one is eligible).
    let best = rec(slotIdx + 1, usedMask);
    best = { points: best.points, assignment: [{ slotId, player: null }, ...best.assignment] };

    for (let p = 0; p < n; p++) {
      if (usedMask & (1 << p)) continue;
      const player = players[p];
      if (!player.eligibleSlots.includes(slotId)) continue;

      const rest = rec(slotIdx + 1, usedMask | (1 << p));
      const total = player.points + rest.points;
      if (total > best.points) {
        best = { points: total, assignment: [{ slotId, player }, ...rest.assignment] };
      }
    }

    memo.set(key, best);
    return best;
  }

  return rec(0, 0);
}

module.exports = {
  getWeeklyLineupDiffs,
  getSeasonLineupDiffs,
  getOptimalLineupDiffs,
  getSeasonOptimalLineupDiffs,
};

// =============================================================================
// CLI — only runs when this file is executed directly (`node espnFantasyLineupDiff.js`),
// not when it's require()'d as a library from another file.
// =============================================================================
if (require.main === module) {
  cli();
}

function parseArgs(argv) {
  const args = { json: false, players: false, all: false, weekly: false, verbose: false, optimal: false, projected: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--week':
      case '-w':
        args.week = Number(argv[++i]);
        break;
      case '--all':
      case '-a':
        args.all = true;
        break;
      case '--start-week':
        args.startWeek = Number(argv[++i]);
        break;
      case '--end-week':
        args.endWeek = Number(argv[++i]);
        break;
      case '--season':
      case '-s':
        args.season = argv[++i];
        break;
      case '--json':
        args.json = true;
        break;
      case '--players':
        args.players = true;
        break;
      case '--weekly':
        args.weekly = true;
        break;
      case '--verbose':
        args.verbose = true;
        break;
      case '--optimal':
      case '-o':
        args.optimal = true;
        break;
      case '--projected':
      case '-p':
        args.projected = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        process.exit(1);
    }
  }
  return args;
}

function printHelp() {
  console.log(`
Usage:
  node espnFantasyLineupDiff.js --week <n> (-o|-p) [options]     Single week
  node espnFantasyLineupDiff.js --all (-o|-p) [options]          Whole season

You must choose exactly one comparison mode:
  -o, --optimal        Actual starting lineup vs. best-possible lineup (bench included)
  -p, --projected       Actual points vs. ESPN's pre-game projections

Options:
  -w, --week <n>       NFL week number (single-week mode)
  -a, --all            Run across the whole season instead of one week
  --start-week <n>     First week to include (implies range mode; default 1)
  --end-week <n>       Last week to include (implies range mode; default 18)
  -s, --season <yr>    NFL season year, e.g. 2026 (or set ESPN_SEASON_ID env var)
  --json               Print raw JSON instead of a table
  --players            Single-week mode: print each starter's actual/projected/diff
  --weekly             --all mode: also print each team's week-by-week breakdown
  --verbose            --all mode: log which weeks got skipped and why
  -h, --help           Show this help message

League ID is hardcoded (see LEAGUE_ID near the top of the file).

Env vars:
  ESPN_SEASON_ID, ESPN_S2, ESPN_SWID
`);
}

async function cli() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  const seasonId = args.season || process.env.ESPN_SEASON_ID;
  const espnS2 = process.env.ESPN_S2;
  const swid = process.env.ESPN_SWID;

  if (!seasonId) {
    console.error(
      'Error: season is required (via --season flag or ESPN_SEASON_ID env var).\n'
    );
    printHelp();
    process.exit(1);
  }

  // Passing --start-week/--end-week on their own implies you want a season
  // range, so you don't also have to remember to pass --all.
  if ((args.startWeek || args.endWeek) && !args.all) {
    args.all = true;
  }

  if (!args.all && !args.week) {
    console.error('Error: pass either --week <n>, --all, or --start-week/--end-week.\n');
    printHelp();
    process.exit(1);
  }

  if (!args.optimal && !args.projected) {
    console.error('Error: pass either --optimal (-o) or --projected (-p) to choose a comparison mode.\n');
    printHelp();
    process.exit(1);
  }
  if (args.optimal && args.projected) {
    console.error('Error: pass only one of --optimal (-o) or --projected (-p), not both.\n');
    printHelp();
    process.exit(1);
  }

  const config = { seasonId, espnS2, swid };

  try {
    if (args.all && args.optimal) {
      const results = await getSeasonOptimalLineupDiffs(config, {
        startWeek: args.startWeek || 1,
        endWeek: args.endWeek || 18,
        verbose: args.verbose,
      });

      if (args.json) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }

      console.log(`\nSeason totals — Actual Starters vs. Optimal Lineup (points left on bench)\n`);
      console.table(
        results.map((r) => ({
          Team: r.teamName,
          Actual: r.actualStartingPoints,
          Optimal: r.optimalPoints,
          'Left on Bench': r.difference,
        }))
      );

      if (args.weekly) {
        for (const team of results) {
          console.log(`\n${team.teamName} — by week`);
          console.table(
            team.weeks.map((w) => ({
              Week: w.week,
              Actual: w.actualStartingPoints,
              Optimal: w.optimalPoints,
              'Left on Bench': w.difference,
            }))
          );
        }
      }
    } else if (args.all) {
      const results = await getSeasonLineupDiffs(config, {
        startWeek: args.startWeek || 1,
        endWeek: args.endWeek || 18,
        verbose: args.verbose,
      });

      if (args.json) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }

      console.log(`\nSeason totals — Actual vs. Projected (starting lineups)\n`);
      console.table(
        results.map((r) => ({
          Team: r.teamName,
          Actual: r.actualPoints,
          Projected: r.projectedPoints,
          Diff: r.difference,
        }))
      );

      if (args.weekly) {
        for (const team of results) {
          console.log(`\n${team.teamName} — by week`);
          console.table(
            team.weeks.map((w) => ({
              Week: w.week,
              Actual: w.actualPoints,
              Projected: w.projectedPoints,
              Diff: w.difference,
            }))
          );
        }
      }
    } else if (args.optimal) {
      const results = await getOptimalLineupDiffs(args.week, config);

      if (args.json) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }

      console.log(`\nWeek ${args.week} — Actual Starters vs. Optimal Lineup (points left on bench)\n`);
      console.table(
        results.map((r) => ({
          Team: r.teamName,
          Actual: r.actualStartingPoints,
          Optimal: r.optimalPoints,
          'Left on Bench': r.difference,
        }))
      );

      if (args.players) {
        for (const team of results) {
          console.log(`\n${team.teamName} — started`);
          console.table(team.startingLineup.map((p) => ({ Player: p.name, Slot: p.slotId, Points: p.points })));
          console.log(`${team.teamName} — optimal`);
          console.table(team.optimalLineup.map((p) => ({ Player: p.name, Slot: p.slotId, Points: p.points })));
        }
      }
    } else {
      const results = await getWeeklyLineupDiffs(args.week, config);

      if (args.json) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }

      console.log(`\nWeek ${args.week} — Actual vs. Projected (starting lineups)\n`);
      console.table(
        results.map((r) => ({
          Team: r.teamName,
          Actual: r.actualPoints,
          Projected: r.projectedPoints,
          Diff: r.difference,
        }))
      );

      if (args.players) {
        for (const team of results) {
          console.log(`\n${team.teamName}`);
          console.table(
            team.starters.map((p) => ({
              Player: p.name,
              Actual: p.actual,
              Projected: p.projected,
              Diff: p.difference,
            }))
          );
        }
      }
    }
  } catch (err) {
    console.error('Failed to fetch lineup diffs:', err.message);
    process.exit(1);
  }
}
