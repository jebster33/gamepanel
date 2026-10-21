'use strict';

/**
 * Shows which ARK settings differ from the game's defaults. The defaults are the
 * values ARK uses when a key is missing, for the settings people change most. Anything
 * not in the table is listed as "not in the default table" so nothing is hidden.
 */

const G = require('./ark-gameini');

const ones = (names) => Object.fromEntries(names.map((n) => [n, 1]));

const DEFAULTS = {
  'GameUserSettings.ini': {
    ServerSettings: {
      ...ones(['XPMultiplier', 'TamingSpeedMultiplier', 'HarvestAmountMultiplier', 'HarvestHealthMultiplier', 'ResourcesRespawnPeriodMultiplier', 'PlayerCharacterWaterDrainMultiplier', 'PlayerCharacterFoodDrainMultiplier', 'PlayerCharacterStaminaDrainMultiplier', 'PlayerCharacterHealthRecoveryMultiplier', 'DinoCharacterFoodDrainMultiplier', 'DinoCharacterStaminaDrainMultiplier', 'DinoCharacterHealthRecoveryMultiplier', 'DinoDamageMultiplier', 'PlayerDamageMultiplier', 'StructureDamageMultiplier', 'PlayerResistanceMultiplier', 'DinoResistanceMultiplier', 'StructureResistanceMultiplier', 'DayCycleSpeedScale', 'DayTimeSpeedScale', 'NightTimeSpeedScale', 'PvEStructureDecayPeriodMultiplier', 'PvPStructureDecayPeriodMultiplier', 'DinoCountMultiplier', 'RaidDinoCharacterFoodDrainMultiplier', 'PerPlatformMaxStructuresMultiplier', 'ItemStackSizeMultiplier', 'FuelConsumptionIntervalMultiplier', 'CropGrowthSpeedMultiplier']),
      DifficultyOffset: 1,
      OverrideOfficialDifficulty: 0,
      MaxTamedDinos: 5000,
      MaxPlatformSaddleStructureLimit: 75,
      TheMaxStructuresInRange: 10500,
      AutoSavePeriodMinutes: 15,
      ServerPVE: false,
      ServerHardcore: false,
      ShowMapPlayerLocation: false,
      AllowThirdPersonPlayer: false,
      ServerCrosshair: true,
      EnablePvPGamma: false,
      DisableStructureDecayPvE: false,
      AllowCaveBuildingPvE: false,
      AllowFlyerCarryPVE: false,
      AlwaysNotifyPlayerLeft: false,
      AlwaysNotifyPlayerJoined: false,
      DisableDinoDecayPvE: false,
      PreventDownloadSurvivors: false,
      PreventDownloadItems: false,
      PreventDownloadDinos: false,
      PreventUploadSurvivors: false,
      PreventUploadItems: false,
      PreventUploadDinos: false,
      NoTributeDownloads: false,
      AllowHitMarkers: true,
      ShowFloatingDamageText: false,
      DisablePvEGamma: false,
      AllowRaidDinoFeeding: false,
      RCONServerGameLogBuffer: 600,
      KickIdlePlayersPeriod: 3600,
      ProximityChat: false,
      GlobalVoiceChat: false,
      AllowCrateSpawnsOnTopOfStructures: false,
      ForceAllStructureLocking: false,
    },
  },
  'Game.ini': {
    '/script/shootergame.shootergamemode': {
      ...ones(['MatingIntervalMultiplier', 'EggHatchSpeedMultiplier', 'BabyMatureSpeedMultiplier', 'BabyCuddleIntervalMultiplier', 'BabyImprintAmountMultiplier', 'BabyFoodConsumptionSpeedMultiplier', 'LayEggIntervalMultiplier', 'GlobalSpoilingTimeMultiplier', 'GlobalItemDecompositionTimeMultiplier', 'GlobalCorpseDecompositionTimeMultiplier', 'CropDecaySpeedMultiplier', 'CropGrowthSpeedMultiplier', 'PoopIntervalMultiplier', 'HairGrowthSpeedMultiplier', 'ResourceNoReplenishRadiusPlayers', 'ResourceNoReplenishRadiusStructures', 'PassiveTameIntervalMultiplier', 'TamedDinoDamageMultiplier', 'TamedDinoResistanceMultiplier', 'WildDinoCharacterFoodDrainMultiplier', 'WildDinoTorporDrainMultiplier', 'TamedDinoTorporDrainMultiplier', 'DinoHarvestingDamageMultiplier', 'PlayerHarvestingDamageMultiplier', 'CustomRecipeEffectivenessMultiplier', 'CustomRecipeSkillMultiplier', 'SupplyCrateLootQualityMultiplier', 'FishingLootQualityMultiplier', 'KillXPMultiplier', 'HarvestXPMultiplier', 'CraftXPMultiplier', 'GenericXPMultiplier', 'SpecialXPMultiplier']),
      bUseSingleplayerSettings: false,
      bDisableStructurePlacementCollision: false,
      bAllowUnlimitedRespecs: false,
      bAllowCustomRecipes: true,
      bDisableFriendlyFire: false,
      bPvEDisableFriendlyFire: false,
      bIncreasePvPRespawnInterval: true,
      bAutoPvETimer: false,
      bAllowFlyerSpeedLeveling: false,
      bPassiveDefensesDamageRiderlessDinos: false,
      bDisableDinoRiding: false,
      bDisableDinoTaming: false,
      bAutoUnlockAllEngrams: false,
      MaxNumberOfPlayersInTribe: 0,
      MaxAlliancesPerTribe: 10,
      MaxTribesPerAlliance: 10,
      TribeNameChangeCooldown: 15,
      MaxTribeLogs: 400,
      OverridePlayerLevelEngramPoints: null,
    },
  },
};

const norm = (v) => String(v).trim();
const same = (a, b) => {
  if (typeof b === 'boolean') return norm(a).toLowerCase() === String(b).toLowerCase();
  if (typeof b === 'number') return Number(a) === b || (Number.isNaN(Number(a)) && norm(a) === String(b));
  return norm(a) === String(b);
};

/** Simple key=value reader, section aware. Repeated keys (engrams, overrides) keep every value. */
function parse(text) {
  const rows = [];
  let section = '';
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';')) continue;
    const head = line.match(/^\[(.+)\]$/);
    if (head) {
      section = head[1];
      continue;
    }
    const eq = line.indexOf('=');
    if (eq > 0) rows.push({ section, key: line.slice(0, eq).trim(), value: line.slice(eq + 1).trim() });
  }
  return rows;
}

/** Compare a parsed file with the table. Pure, so it can be tested. */
function diff(file, text) {
  const table = DEFAULTS[file];
  if (!table) return null;
  const ci = Object.fromEntries(Object.entries(table).map(([s, v]) => [s.toLowerCase(), v]));
  const changed = [];
  const matching = [];
  const unknown = [];
  for (const r of parse(text)) {
    const defaults = ci[r.section.toLowerCase()];
    const base = defaults && Object.keys(defaults).find((k) => k.toLowerCase() === r.key.toLowerCase());
    if (!base) {
      unknown.push(r);
      continue;
    }
    const def = defaults[base];
    if (def === null) unknown.push(r);
    else if (same(r.value, def)) matching.push({ ...r, key: base, default: def });
    else changed.push({ ...r, key: base, default: def });
  }
  return { file, changed, matching: matching.length, unknown };
}

function view(manager, server, file) {
  if (!G.isArk(server)) throw Object.assign(new Error('This is an ARK feature'), { status: 400 });
  const name = DEFAULTS[file] ? file : 'GameUserSettings.ini';
  const text = G.readText(G.iniPath(manager, server, name));
  return { files: Object.keys(DEFAULTS), ...diff(name, text) };
}

module.exports = { diff, parse, view, DEFAULTS };
