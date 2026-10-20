'use strict';

/**
 * Rust team-size presets and the name tag that goes with them. The launch line
 * gets {{TEAM_LIMIT}} (relationshipmanager.maxteamsize) and {{HOSTNAME_FULL}}
 * (the server name, with a tag like "[2x | Duo]" in front when asked for).
 * Event timers are separate: the panel sends them to the GamePanelEvents plugin
 * and to Rust's own bradley.* console variables once the server is up.
 */

const TEAMS = { solo: ['Solo', 1], duo: ['Duo', 2], trio: ['Trio', 3], quad: ['Quad', 4] };

const teamLimit = (vars) => (TEAMS[vars.TEAM_SIZE] ? TEAMS[vars.TEAM_SIZE][1] : vars.MAX_TEAM ?? 8);

/** The name shown in the server list. Quotes are dropped: the name sits inside quotes on the command line. */
function hostname(vars) {
  const base = String(vars.SERVER_HOSTNAME ?? '');
  const team = TEAMS[vars.TEAM_SIZE];
  if (!team || vars.TEAM_TAG !== 'true') return base;
  const rate = Number(vars.GATHER_RATE);
  const tag = rate > 1 ? `[${rate}x | ${team[0]}]` : `[${team[0]}]`;
  return `${tag} ${base}`.replace(/"/g, '');
}

module.exports = { TEAMS, teamLimit, hostname };
