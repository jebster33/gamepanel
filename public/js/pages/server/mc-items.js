import { esc } from '../../core/util.js';

/* ------------------------------------------------ Minecraft item tiles */

/*
 * Items are drawn here, in HTML and CSS: a coloured tile (by material), the
 * item's initials, a count, a durability bar and a purple shimmer when it is
 * enchanted. Nothing is loaded from another site, so the viewer's address is
 * never shown to an image host and the CSP stays 'self'. The list below is
 * what the "add item" search offers; any other id can still be typed in.
 */

const LIST = `
air stone granite diorite andesite deepslate cobblestone cobbled_deepslate dirt grass_block podzol mycelium coarse_dirt rooted_dirt mud clay sand red_sand gravel
oak_log spruce_log birch_log jungle_log acacia_log dark_oak_log mangrove_log cherry_log crimson_stem warped_stem
oak_planks spruce_planks birch_planks jungle_planks acacia_planks dark_oak_planks mangrove_planks cherry_planks bamboo_planks crimson_planks warped_planks
oak_sapling spruce_sapling birch_sapling jungle_sapling acacia_sapling dark_oak_sapling cherry_sapling mangrove_propagule
oak_leaves spruce_leaves birch_leaves jungle_leaves acacia_leaves dark_oak_leaves azalea_leaves cherry_leaves
glass white_stained_glass tinted_glass sandstone red_sandstone obsidian crying_obsidian bedrock netherrack basalt blackstone end_stone soul_sand soul_soil magma_block glowstone
sea_lantern prismarine bricks stone_bricks mossy_stone_bricks nether_bricks quartz_block smooth_stone purpur_block terracotta white_terracotta
white_wool orange_wool magenta_wool light_blue_wool yellow_wool lime_wool pink_wool gray_wool light_gray_wool cyan_wool purple_wool blue_wool brown_wool green_wool red_wool black_wool
white_concrete orange_concrete red_concrete blue_concrete green_concrete black_concrete
coal_ore iron_ore copper_ore gold_ore redstone_ore lapis_ore diamond_ore emerald_ore nether_gold_ore nether_quartz_ore ancient_debris
deepslate_coal_ore deepslate_iron_ore deepslate_copper_ore deepslate_gold_ore deepslate_redstone_ore deepslate_lapis_ore deepslate_diamond_ore deepslate_emerald_ore
coal_block iron_block copper_block gold_block redstone_block lapis_block diamond_block emerald_block netherite_block raw_iron_block raw_copper_block raw_gold_block
coal charcoal raw_iron raw_copper raw_gold iron_ingot copper_ingot gold_ingot netherite_ingot netherite_scrap diamond emerald lapis_lazuli quartz amethyst_shard redstone glowstone_dust
iron_nugget gold_nugget stick string feather flint bone bone_meal leather rabbit_hide paper book writable_book enchanted_book slime_ball clay_ball brick nether_brick
gunpowder blaze_rod blaze_powder ghast_tear ender_pearl ender_eye eye_of_ender nether_star shulker_shell phantom_membrane prismarine_shard prismarine_crystals nautilus_shell heart_of_the_sea
echo_shard disc_fragment_5 totem_of_undying elytra trident heavy_core breeze_rod wind_charge mace
wooden_sword stone_sword iron_sword golden_sword diamond_sword netherite_sword
wooden_pickaxe stone_pickaxe iron_pickaxe golden_pickaxe diamond_pickaxe netherite_pickaxe
wooden_axe stone_axe iron_axe golden_axe diamond_axe netherite_axe
wooden_shovel stone_shovel iron_shovel golden_shovel diamond_shovel netherite_shovel
wooden_hoe stone_hoe iron_hoe golden_hoe diamond_hoe netherite_hoe
bow crossbow arrow spectral_arrow tipped_arrow shield fishing_rod carrot_on_a_stick warped_fungus_on_a_stick flint_and_steel shears brush spyglass compass recovery_compass clock lead name_tag saddle bundle
leather_helmet leather_chestplate leather_leggings leather_boots chainmail_helmet chainmail_chestplate chainmail_leggings chainmail_boots
iron_helmet iron_chestplate iron_leggings iron_boots golden_helmet golden_chestplate golden_leggings golden_boots
diamond_helmet diamond_chestplate diamond_leggings diamond_boots netherite_helmet netherite_chestplate netherite_leggings netherite_boots turtle_helmet turtle_scute carved_pumpkin
bucket water_bucket lava_bucket milk_bucket powder_snow_bucket pufferfish_bucket salmon_bucket cod_bucket tropical_fish_bucket axolotl_bucket tadpole_bucket glass_bottle potion splash_potion lingering_potion experience_bottle honey_bottle
apple golden_apple enchanted_golden_apple bread cooked_beef beef cooked_porkchop porkchop cooked_chicken chicken cooked_mutton mutton cooked_rabbit rabbit cooked_cod cod cooked_salmon salmon tropical_fish pufferfish
carrot golden_carrot potato baked_potato poisonous_potato beetroot beetroot_soup mushroom_stew rabbit_stew suspicious_stew melon_slice glistering_melon_slice sweet_berries glow_berries dried_kelp cookie cake pumpkin_pie honey_block honeycomb chorus_fruit rotten_flesh spider_eye fermented_spider_eye
wheat wheat_seeds beetroot_seeds melon_seeds pumpkin_seeds torchflower_seeds pitcher_pod cocoa_beans sugar sugar_cane bamboo cactus kelp hay_block melon pumpkin
crafting_table furnace blast_furnace smoker campfire soul_campfire anvil chipped_anvil damaged_anvil grindstone smithing_table stonecutter loom cartography_table fletching_table enchanting_table brewing_stand cauldron composter lectern barrel chest trapped_chest ender_chest shulker_box white_shulker_box beacon conduit bell lodestone respawn_anchor bed white_bed red_bed
torch soul_torch lantern soul_lantern end_rod lightning_rod ladder scaffold chain iron_bars oak_fence oak_gate oak_door iron_door oak_trapdoor iron_trapdoor oak_sign oak_hanging_sign painting item_frame glow_item_frame armor_stand flower_pot
rail powered_rail detector_rail activator_rail minecart chest_minecart furnace_minecart hopper_minecart tnt_minecart oak_boat oak_chest_boat
redstone_torch repeater comparator observer piston sticky_piston dispenser dropper hopper lever stone_button oak_button stone_pressure_plate oak_pressure_plate tripwire_hook daylight_detector target slime_block note_block jukebox tnt redstone_lamp copper_bulb crafter
oak_stairs stone_stairs cobblestone_stairs brick_stairs oak_slab stone_slab cobblestone_slab brick_slab cobblestone_wall
spawner trial_spawner vault ominous_trial_key trial_key dragon_egg dragon_head creeper_head skeleton_skull zombie_head player_head wither_skeleton_skull command_block chain_command_block repeating_command_block structure_block jigsaw barrier light debug_stick knowledge_book
white_dye orange_dye magenta_dye light_blue_dye yellow_dye lime_dye pink_dye gray_dye light_gray_dye cyan_dye purple_dye blue_dye brown_dye green_dye red_dye black_dye ink_sac glow_ink_sac
poppy dandelion blue_orchid allium azure_bluet red_tulip oxeye_daisy cornflower lily_of_the_valley wither_rose sunflower lilac rose_bush peony torchflower pitcher_plant spore_blossom
fern grass tall_grass vine lily_pad moss_block moss_carpet azalea flowering_azalea glow_lichen sculk sculk_sensor sculk_shrieker sculk_catalyst big_dripleaf small_dripleaf hanging_roots mangrove_roots
snowball snow snow_block ice packed_ice blue_ice egg turtle_egg sniffer_egg frogspawn
pig_spawn_egg cow_spawn_egg sheep_spawn_egg chicken_spawn_egg villager_spawn_egg zombie_spawn_egg creeper_spawn_egg skeleton_spawn_egg
music_disc_13 music_disc_cat music_disc_blocks music_disc_chirp music_disc_far music_disc_mall music_disc_mellohi music_disc_stal music_disc_strad music_disc_ward music_disc_11 music_disc_wait music_disc_pigstep music_disc_otherside music_disc_5 music_disc_relic music_disc_creator
white_banner creeper_banner_pattern skull_banner_pattern flower_banner_pattern globe_banner_pattern piglin_banner_pattern
netherite_upgrade_smithing_template sentry_armor_trim_smithing_template dune_armor_trim_smithing_template coast_armor_trim_smithing_template wild_armor_trim_smithing_template ward_armor_trim_smithing_template eye_armor_trim_smithing_template vex_armor_trim_smithing_template tide_armor_trim_smithing_template snout_armor_trim_smithing_template rib_armor_trim_smithing_template spire_armor_trim_smithing_template silence_armor_trim_smithing_template raiser_armor_trim_smithing_template host_armor_trim_smithing_template wayfinder_armor_trim_smithing_template shaper_armor_trim_smithing_template
saddle iron_horse_armor golden_horse_armor diamond_horse_armor leather_horse_armor wolf_armor map filled_map firework_rocket firework_star goat_horn
filled_map copper_door copper_grate cut_copper waxed_copper_block exposed_copper weathered_copper oxidized_copper lightning_rod
`;

export const ITEMS = [...new Set(LIST.split(/\s+/).filter(Boolean))].sort();

export const ENCHANTMENTS = [
  'protection', 'fire_protection', 'feather_falling', 'blast_protection', 'projectile_protection', 'respiration', 'aqua_affinity', 'thorns', 'depth_strider', 'frost_walker', 'soul_speed', 'swift_sneak',
  'sharpness', 'smite', 'bane_of_arthropods', 'knockback', 'fire_aspect', 'looting', 'sweeping_edge', 'efficiency', 'silk_touch', 'unbreaking', 'fortune',
  'power', 'punch', 'flame', 'infinity', 'luck_of_the_sea', 'lure', 'loyalty', 'impaling', 'riptide', 'channeling', 'multishot', 'quick_charge', 'piercing',
  'mending', 'vanishing_curse', 'binding_curse', 'density', 'breach', 'wind_burst',
];

export const nice = (id) =>
  String(id || '')
    .replace(/^minecraft:/, '')
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

const MATERIALS = [
  ['netherite', '#4a4247'], ['diamond', '#3fd3c4'], ['golden', '#f2c744'], ['gold', '#f2c744'], ['iron', '#c9ccd0'], ['chainmail', '#8c9199'], ['copper', '#d17b52'],
  ['stone', '#8a8a8a'], ['cobble', '#7b7b7b'], ['deepslate', '#4d4d52'], ['wooden', '#a47a45'], ['oak', '#b08a4e'], ['spruce', '#6e4f2e'], ['birch', '#d2c58a'], ['jungle', '#a9743f'], ['acacia', '#c26a3a'], ['dark_oak', '#4a3320'], ['cherry', '#e9a9b8'], ['mangrove', '#7d3a3a'], ['bamboo', '#c9b84d'],
  ['leather', '#a15a32'], ['redstone', '#d62f2f'], ['lapis', '#2e4fb5'], ['emerald', '#2dc46b'], ['quartz', '#ece6dc'], ['coal', '#33343a'], ['obsidian', '#2a1c42'], ['netherrack', '#7a2e2e'], ['nether', '#7a2e2e'], ['end_', '#d9d79a'], ['ender', '#1f8f7a'],
  ['gold', '#f2c744'], ['glow', '#f4d56e'], ['water', '#3a6fe0'], ['lava', '#e8660f'], ['potion', '#b04fd1'], ['apple', '#d64040'], ['bread', '#c58b3b'], ['beef', '#a94c3a'], ['porkchop', '#e0929a'], ['chicken', '#e7c9a0'], ['carrot', '#e8832a'], ['potato', '#c9a35c'],
  ['grass', '#5f9e3a'], ['leaves', '#3f7d2e'], ['sapling', '#4f9a3c'], ['dirt', '#7a5636'], ['sand', '#dccb8d'], ['gravel', '#8c8985'], ['clay', '#9aa3b5'], ['wool', '#d8d8d8'], ['glass', '#bfe3ea'], ['snow', '#f3f6f8'], ['ice', '#9cc8f2'],
  ['red', '#c0392b'], ['orange', '#e67e22'], ['yellow', '#f1c40f'], ['lime', '#8bd13f'], ['green', '#2e8b3c'], ['cyan', '#1fa5b5'], ['light_blue', '#5bb5e8'], ['blue', '#3558c8'], ['purple', '#8a4fc0'], ['magenta', '#c24fb8'], ['pink', '#f08fb5'], ['brown', '#7a5230'], ['black', '#2b2b2f'], ['gray', '#6b6e75'], ['white', '#e8e8ea'],
  ['book', '#7b4fa8'], ['enchanted', '#9a6bd6'], ['totem', '#e9c94b'], ['elytra', '#8d93a8'], ['trident', '#2fae9a'], ['arrow', '#b9b2a0'], ['bow', '#a47a45'], ['shield', '#8a6a3a'], ['spawn_egg', '#b8e07a'],
];

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A base colour for an item id: by material word, else a stable colour from the name. */
export function colorOf(id) {
  const key = String(id).replace(/^minecraft:/, '');
  for (const [word, color] of MATERIALS) if (key.includes(word)) return color;
  return `hsl(${hash(key) % 360} 35% 45%)`;
}

const TOOL_USES = { wooden: 59, stone: 131, iron: 250, golden: 32, diamond: 1561, netherite: 2031 };
const ARMOR_BASE = { helmet: 11, chestplate: 16, leggings: 15, boots: 13 };
const ARMOR_FACTOR = { leather: 5, chainmail: 15, iron: 15, golden: 7, diamond: 33, netherite: 37, turtle: 25 };
const OTHER_USES = { bow: 384, crossbow: 465, trident: 250, fishing_rod: 64, flint_and_steel: 64, shears: 238, elytra: 432, shield: 336, mace: 500, carrot_on_a_stick: 25, warped_fungus_on_a_stick: 100, brush: 64 };

/** How much damage an item takes before it breaks, or 0 when it has no durability bar. */
export function maxDurability(id) {
  const key = String(id).replace(/^minecraft:/, '');
  if (OTHER_USES[key]) return OTHER_USES[key];
  const [mat, kind] = key.split(/_(.+)/);
  if (/^(sword|pickaxe|axe|shovel|hoe)$/.test(kind || '') && TOOL_USES[mat]) return TOOL_USES[mat];
  if (ARMOR_BASE[kind] && ARMOR_FACTOR[mat]) return mat === 'turtle' ? 275 : ARMOR_BASE[kind] * ARMOR_FACTOR[mat];
  return 0;
}

const letters = (id) => {
  const parts = String(id).replace(/^minecraft:/, '').split('_');
  return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : parts[0].slice(0, 2)).toUpperCase();
};

export const itemTitle = (it) =>
  [it.name || nice(it.id), it.name ? `(${nice(it.id)})` : '', it.enchants?.length ? it.enchants.map((e) => `${nice(e.id)} ${e.level}`).join(', ') : '', it.damage ? `Damage ${it.damage}` : '', it.id].filter(Boolean).join('\n');

/** The HTML for one item tile (or an empty slot when `it` is null). */
export function tile(it) {
  if (!it) return '';
  const max = maxDurability(it.id);
  const left = max && it.damage ? Math.max(0, Math.min(1, 1 - it.damage / max)) : null;
  const bar = left === null ? '' : `<span class="mc-dur"><i style="width:${Math.round(left * 100)}%;background:hsl(${Math.round(left * 120)} 80% 45%)"></i></span>`;
  return `<span class="mc-item ${it.enchants?.length ? 'mc-ench' : ''}" style="--mc:${esc(colorOf(it.id))}"><b>${esc(letters(it.id))}</b>${it.count > 1 ? `<em>${Number(it.count)}</em>` : ''}${bar}</span>`;
}
