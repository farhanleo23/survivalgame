import { COMIC } from "./comic";

/**
 * Arena definitions.
 *
 * Every other system in the game already varies wave to wave — the roster, the
 * modifiers, the synergy deck, the enemy stat curve. The one thing that never
 * changed was the room, and a fixed room is what made wave 9 play like wave 2:
 * the same cover in the same places answers every question the same way.
 *
 * An arena is pure data. The engine owns the prop constructors and only
 * dispatches on `kind`, so adding a layout here needs no engine change.
 */

export type ArenaId = "depot" | "garage" | "floodbay" | "rooftop";

/**
 * A placement, not a mesh. Positions are arena-space metres with the origin at
 * the extraction beacon; the playable square runs to ±18.5 (ARENA_LIMIT).
 */
export type ArenaProp =
  | { kind: "block"; x: number; z: number; width: number; depth: number; color: number }
  | { kind: "barricade"; x: number; z: number; width: number; depth: number; rotation: number }
  | { kind: "barrel"; x: number; z: number }
  | { kind: "furnace"; x: number; z: number }
  | { kind: "trafficBarricade"; x: number; z: number; rotation?: number }
  | { kind: "cone"; x: number; z: number }
  | { kind: "pallet"; x: number; z: number }
  | { kind: "slime"; x: number; z: number; radius?: number }
  | { kind: "vat"; x: number; z: number }
  | { kind: "generator"; x: number; z: number }
  | { kind: "floodlight"; x: number; z: number; color: number }
  /** Destructible cover. Shooting it away is a real decision, so it has HP. */
  | { kind: "crate"; x: number; z: number; hp?: number; rotation?: number };

/**
 * Per-arena colour. The comic post-process flattens everything to a handful of
 * bands, so an arena only reads as a different place if the *floor* changes —
 * repainting props alone is invisible at this camera height.
 */
export interface ArenaTheme {
  /** The two checker tones of the floor slab texture. */
  floorLight: string;
  floorDark: string;
  /** Inked seam between slabs. */
  seam: string;
  /** Speckle over the slab. */
  speckle: string;
  /** Backdrop wash behind the perimeter. */
  sky: number;
  /** Perimeter wall and its trim. */
  wall: number;
  trim: number;
  /** Distant silhouette buildings. */
  skyline: number;
  /** Paint used for the centre pad and lane guides. */
  paint: number;
}

/**
 * The arena's standing rule.
 *
 * `none` is the baseline the others are read against. The rest deliberately
 * damage the player as well as the infected — an arena that only ever hurts
 * the enemy is scenery, not a hazard, and the player learns nothing by
 * standing still in it.
 */
export type ArenaHazardId = "none" | "debris" | "surge";

export interface ArenaHazard {
  id: ArenaHazardId;
  /** Seconds between events. */
  interval: number;
  /** Seconds of telegraph before the event lands. */
  telegraph: number;
  /** Damage per event, or per second for continuous hazards. */
  damage: number;
  radius: number;
}

export interface ArenaDefinition {
  id: ArenaId;
  name: string;
  /** One line, shown under the wave announcement on arrival. */
  blurb: string;
  theme: ArenaTheme;
  props: ArenaProp[];
  hazard: ArenaHazard;
}

const NO_HAZARD: ArenaHazard = { id: "none", interval: 0, telegraph: 0, damage: 0, radius: 0 };

export const ARENAS: Record<ArenaId, ArenaDefinition> = {
  /**
   * The original depot: open middle, architecture pushed to the edges. Kept as
   * the baseline because its spacing is already tuned — it is the layout every
   * other arena is a deliberate deviation from.
   */
  depot: {
    id: "depot",
    name: "Quarantine Depot",
    blurb: "Open ground. Nothing between you and them but barrels.",
    theme: {
      floorLight: "#8f9db8",
      floorDark: "#7d8aa6",
      seam: "#3f4a63",
      speckle: "rgba(40,50,74,0.5)",
      sky: COMIC.sky,
      wall: COMIC.concrete,
      trim: COMIC.hazardYellow,
      skyline: 0x2a3358,
      paint: COMIC.hazardYellow,
    },
    props: [
      { kind: "block", x: -12.8, z: 8.8, width: 3.4, depth: 2.4, color: COMIC.steel },
      { kind: "block", x: 12.8, z: -8.8, width: 3.4, depth: 2.4, color: COMIC.concrete },
      { kind: "block", x: -12.8, z: -9.2, width: 2.8, depth: 2.4, color: COMIC.rust },
      { kind: "block", x: 12.8, z: 9.2, width: 2.8, depth: 2.4, color: COMIC.steel },
      { kind: "barricade", x: -7.5, z: 12.0, width: 3.6, depth: 0.45, rotation: 0.14 },
      { kind: "barricade", x: 7.5, z: -12.0, width: 3.6, depth: 0.45, rotation: -0.18 },
      { kind: "floodlight", x: -15.2, z: -14.5, color: COMIC.hazardStripe },
      { kind: "floodlight", x: 14.6, z: 13.9, color: COMIC.electric },
      { kind: "floodlight", x: -14.7, z: 14.2, color: COMIC.hazardYellow },
      { kind: "furnace", x: -11.5, z: 5.5 },
      { kind: "furnace", x: 12.5, z: -4.5 },
      { kind: "slime", x: -6.5, z: -7.5, radius: 1.8 },
      { kind: "slime", x: 7.5, z: 6.5, radius: 1.6 },
      { kind: "vat", x: -12.5, z: -9.5 },
      { kind: "vat", x: 9.5, z: 9.2 },
      { kind: "trafficBarricade", x: -2.5, z: 2.5, rotation: -0.2 },
      { kind: "trafficBarricade", x: 3.8, z: -3.2, rotation: 0.35 },
      { kind: "cone", x: -4.2, z: 3.2 },
      { kind: "cone", x: -1.2, z: 2.4 },
      { kind: "cone", x: 2.6, z: -3.8 },
      { kind: "pallet", x: 6.5, z: -2.5 },
      { kind: "generator", x: -10.6, z: 7.9 },
      { kind: "generator", x: 10.9, z: -8.5 },
      { kind: "barrel", x: -3.5, z: -2.5 },
      { kind: "barrel", x: 5.5, z: 2.2 },
      { kind: "barrel", x: 11.5, z: -1.5 },
      { kind: "barrel", x: -13.5, z: 1.8 },
      { kind: "crate", x: -8.5, z: -1.0 },
      { kind: "crate", x: 8.8, z: 1.2, rotation: 0.4 },
    ],
    hazard: NO_HAZARD,
  },

  /**
   * A pillar grid. Sightlines are short and every approach is a corner, which
   * inverts the depot: kiting in wide circles stops working and the rifle
   * loses its range advantage, so the shotgun finally earns its slot.
   *
   * Pillars sit on a 7.4m lattice with the centre column removed so the
   * extraction beacon stays clear.
   */
  garage: {
    id: "garage",
    name: "Sublevel Parking",
    blurb: "Short sightlines. They will be around the pillar before you hear them.",
    // Deliberately the most desaturated floor in the game. The first pass used
    // a purple-grey concrete, which put the deck in the same hue band as the
    // brute — and an arena that competes with an enemy tint undoes the whole
    // point of tinting the enemies. Charcoal cedes every hue to the infected.
    theme: {
      floorLight: "#5c626b",
      floorDark: "#4d525a",
      seam: "#23262c",
      speckle: "rgba(24,26,32,0.55)",
      sky: 0x171a21,
      wall: 0x5f656e,
      trim: COMIC.hazardStripe,
      skyline: 0x101218,
      paint: COMIC.hazardStripe,
    },
    props: [
      ...pillarGrid(),
      { kind: "barricade", x: 0, z: -14.5, width: 5.2, depth: 0.5, rotation: 0 },
      { kind: "barricade", x: 0, z: 14.5, width: 5.2, depth: 0.5, rotation: 0 },
      { kind: "trafficBarricade", x: -11.0, z: 0, rotation: Math.PI / 2 },
      { kind: "trafficBarricade", x: 11.0, z: 0, rotation: Math.PI / 2 },
      { kind: "floodlight", x: -15.5, z: -15.5, color: COMIC.hazardYellow },
      { kind: "floodlight", x: 15.5, z: 15.5, color: COMIC.hazardYellow },
      { kind: "floodlight", x: 15.5, z: -15.5, color: COMIC.electric },
      { kind: "generator", x: -15.8, z: 4.2 },
      { kind: "generator", x: 15.8, z: -4.2 },
      { kind: "barrel", x: -4.0, z: -11.2 },
      { kind: "barrel", x: 4.0, z: 11.2 },
      { kind: "barrel", x: 12.0, z: 6.0 },
      { kind: "barrel", x: -12.0, z: -6.0 },
      { kind: "cone", x: -3.0, z: 5.5 },
      { kind: "cone", x: 3.0, z: -5.5 },
      { kind: "crate", x: -5.2, z: 0.6, hp: 140 },
      { kind: "crate", x: 5.2, z: -0.6, hp: 140 },
      { kind: "crate", x: 0.4, z: 8.0, hp: 140, rotation: 0.25 },
      { kind: "crate", x: -0.4, z: -8.0, hp: 140, rotation: -0.25 },
      { kind: "pallet", x: -9.0, z: 11.0 },
      { kind: "pallet", x: 9.0, z: -11.0 },
    ],
    // Ceiling slabs. Telegraphed long enough to walk out of, punishing enough
    // that ignoring the marker is never correct.
    hazard: { id: "debris", interval: 5.4, telegraph: 1.15, damage: 26, radius: 2.6 },
  },

  /**
   * Standing water. Cover is sparse and shoved to the diagonals, so the arena
   * is nearly as open as the depot — the difference is that the floor itself
   * goes live on a timer and the only safe play is to keep moving outward.
   */
  floodbay: {
    id: "floodbay",
    name: "Flooded Loading Bay",
    blurb: "Ankle-deep water and live cable. The floor goes hot on a timer.",
    theme: {
      floorLight: "#3f6f86",
      floorDark: "#345c70",
      seam: "#1b3341",
      speckle: "rgba(20,52,66,0.5)",
      sky: 0x143246,
      wall: 0x4d7286,
      trim: COMIC.electric,
      skyline: 0x0e2432,
      paint: COMIC.electric,
    },
    props: [
      { kind: "block", x: -10.5, z: -10.5, width: 4.2, depth: 4.2, color: COMIC.rust },
      { kind: "block", x: 10.5, z: 10.5, width: 4.2, depth: 4.2, color: COMIC.steel },
      { kind: "block", x: -10.5, z: 10.5, width: 3.0, depth: 5.6, color: COMIC.concrete },
      { kind: "block", x: 10.5, z: -10.5, width: 3.0, depth: 5.6, color: COMIC.rust },
      { kind: "slime", x: -5.0, z: 0, radius: 2.6 },
      { kind: "slime", x: 5.0, z: 0, radius: 2.6 },
      { kind: "slime", x: 0, z: -6.0, radius: 2.2 },
      { kind: "slime", x: 0, z: 6.0, radius: 2.2 },
      { kind: "slime", x: -13.0, z: 3.5, radius: 1.8 },
      { kind: "slime", x: 13.0, z: -3.5, radius: 1.8 },
      { kind: "vat", x: -16.0, z: -2.0 },
      { kind: "vat", x: 16.0, z: 2.0 },
      { kind: "generator", x: 0, z: -15.5 },
      { kind: "generator", x: 0, z: 15.5 },
      { kind: "floodlight", x: -15.0, z: 15.0, color: COMIC.electric },
      { kind: "floodlight", x: 15.0, z: -15.0, color: COMIC.electric },
      { kind: "barrel", x: -7.0, z: 8.5 },
      { kind: "barrel", x: 7.0, z: -8.5 },
      { kind: "barrel", x: -7.0, z: -8.5 },
      { kind: "barrel", x: 7.0, z: 8.5 },
      { kind: "crate", x: -2.2, z: -11.5, hp: 120 },
      { kind: "crate", x: 2.2, z: 11.5, hp: 120 },
      { kind: "pallet", x: 12.5, z: 0 },
      { kind: "pallet", x: -12.5, z: 0 },
    ],
    // An expanding ring from the beacon. Outrunnable in any direction, so the
    // answer is always "move", never "find the safe tile".
    hazard: { id: "surge", interval: 7.2, telegraph: 1.4, damage: 22, radius: 3.4 },
  },

  /**
   * Almost no cover at all. The most dangerous arena by design — it is the
   * wave-10 stage, and with nothing to break line of sight every approach
   * lands at once.
   */
  rooftop: {
    id: "rooftop",
    name: "Evac Rooftop",
    blurb: "No cover anywhere. Every angle is open and nothing stops a charge.",
    theme: {
      floorLight: "#9c8f7e",
      floorDark: "#8a7d6d",
      seam: "#4a4237",
      speckle: "rgba(74,66,55,0.5)",
      sky: 0x7a3b6b,
      wall: 0x8c8072,
      trim: COMIC.hazardYellow,
      skyline: 0x3a2140,
      paint: COMIC.paper,
    },
    props: [
      { kind: "block", x: -13.5, z: 0, width: 2.6, depth: 6.0, color: COMIC.steel },
      { kind: "block", x: 13.5, z: 0, width: 2.6, depth: 6.0, color: COMIC.steel },
      { kind: "block", x: 0, z: -13.5, width: 6.0, depth: 2.6, color: COMIC.concrete },
      { kind: "block", x: 0, z: 13.5, width: 6.0, depth: 2.6, color: COMIC.concrete },
      { kind: "generator", x: -8.0, z: -8.0 },
      { kind: "generator", x: 8.0, z: 8.0 },
      { kind: "generator", x: -8.0, z: 8.0 },
      { kind: "generator", x: 8.0, z: -8.0 },
      { kind: "furnace", x: -16.0, z: -16.0 },
      { kind: "furnace", x: 16.0, z: 16.0 },
      { kind: "floodlight", x: -16.5, z: 10.0, color: COMIC.hazardStripe },
      { kind: "floodlight", x: 16.5, z: -10.0, color: COMIC.hazardStripe },
      { kind: "barrel", x: -4.5, z: -4.5 },
      { kind: "barrel", x: 4.5, z: 4.5 },
      { kind: "cone", x: -6.5, z: 2.0 },
      { kind: "cone", x: 6.5, z: -2.0 },
      { kind: "cone", x: 2.0, z: 6.5 },
      { kind: "cone", x: -2.0, z: -6.5 },
      { kind: "crate", x: -11.0, z: 6.5, hp: 100 },
      { kind: "crate", x: 11.0, z: -6.5, hp: 100 },
    ],
    // No standing hazard.
    //
    // This arena originally carried a constant crosswind that shoved the
    // player a fixed distance every frame. It was removed because it could not
    // be countered — walking into it did not cancel it — so the operator drifted
    // roughly a metre a second with the stick centred, which reads as broken
    // controls rather than as weather. The rooftop's identity is its lack of
    // cover, and that needs no hazard to land.
    hazard: NO_HAZARD,
  },
};

/**
 * A 3x3 lattice of pillars with the middle removed.
 *
 * Authored as code rather than 8 literals because the spacing is the whole
 * design — the gap has to stay wide enough for a brute (0.9 radius) to path
 * between two pillars, or the garage becomes a wall.
 */
function pillarGrid(): ArenaProp[] {
  const props: ArenaProp[] = [];
  for (let ix = -1; ix <= 1; ix += 1) {
    for (let iz = -1; iz <= 1; iz += 1) {
      if (ix === 0 && iz === 0) continue;
      props.push({
        kind: "block",
        x: ix * 7.4,
        z: iz * 7.4,
        width: 2.2,
        depth: 2.2,
        color: ix * iz === 0 ? COMIC.concrete : COMIC.steel,
      });
    }
  }
  return props;
}

export const ARENA_IDS = Object.keys(ARENAS) as ArenaId[];

/**
 * Which arena a wave is fought in.
 *
 * Fixed rather than random so the campaign is learnable: wave 7 is always the
 * rooftop, and a player who died there can plan for it. The two boss waves get
 * the two most extreme layouts — the flooded bay for the wave-5 titan, the
 * exposed rooftop for the wave-10 finale.
 *
 * Endless cycles all four so the deep game keeps rotating.
 */
const CAMPAIGN_ARENAS: ArenaId[] = [
  "depot", // 1
  "depot", // 2
  "garage", // 3
  "garage", // 4
  "floodbay", // 5 — first titan
  "depot", // 6
  "rooftop", // 7
  "garage", // 8
  "floodbay", // 9
  "rooftop", // 10 — finale
];

export function getArenaForWave(wave: number): ArenaDefinition {
  if (wave >= 1 && wave <= CAMPAIGN_ARENAS.length) {
    return ARENAS[CAMPAIGN_ARENAS[wave - 1]];
  }
  const over = Math.max(0, wave - CAMPAIGN_ARENAS.length - 1);
  return ARENAS[ARENA_IDS[over % ARENA_IDS.length]];
}

/** Default HP for a destructible crate when the prop does not override it. */
export const CRATE_BASE_HP = 110;
