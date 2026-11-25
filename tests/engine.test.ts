import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { GameEngine } from "../game/GameEngine";
import { segmentCircleHit, segmentObstacleHit, resolveCircleObstacle } from "../game/collision";
import { createDefaultProfile } from "../game/profile";
import { createRunStats } from "../game/stats";
import { WEAPONS } from "../game/config";
import type { PickupId, ProfileV1, SynergyCardId, WeaponId, WeaponInstance } from "../game/types";

interface TestEnemy {
  mesh: THREE.Group;
  health: number;
  definition: { radius: number };
}
interface TestProjectile {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  direction: THREE.Vector3;
  damage: number;
  knockback: number;
  life: number;
  enemy: boolean;
  maxPierces?: number;
  bouncesRemaining?: number;
  hitEnemies?: Set<TestEnemy>;
}
interface TestObstacle { x: number; z: number; hx: number; hz: number; health?: number }
interface EngineMethods {
  startDash(): void;
  updatePlayer(dt: number): void;
  updateProjectiles(dt: number): void;
  updatePickups(dt: number): void;
  updateHazards(dt: number): void;
  updateBarrels(dt: number): void;
  explodeBarrel(barrel: { mesh: THREE.Group; active: boolean; chainTimer?: number }): void;
  damagePlayer(amount: number): void;
  reload(): void;
  triggerOverdrive(): void;
  completeWave(): void;
  startWave(wave: number): void;
  setProfile(profile: ProfileV1): void;
  renderFrame(): void;
}

// Exercise the actual engine methods with rendering/audio at their boundaries
// replaced. No WebGL context is needed to test movement, combat or progression.
function engineHarness() {
  const profile = createDefaultProfile();
  const engine = Object.assign(Object.create(GameEngine.prototype) as EngineMethods, {
    profile, paused: false, destroyed: false, frame: 0, inputMode: "keyboard",
    keys: new Set<string>(), virtualMove: new THREE.Vector2(),
    playerMesh: new THREE.Group(), playerRig: null, playerVelocity: new THREE.Vector3(),
    playerHealth: 100, maxHealth: 100, moveSpeed: 6.2, pickupRadius: 2.2,
    aim: new THREE.Vector3(1, 0, 0), dashDirection: new THREE.Vector3(),
    dashRemaining: 0, dashTotal: 0.22, dashCooldown: 0, dashCooldownTotal: 2.8,
    activeSynergies: new Map<SynergyCardId, number>(), cameraShake: 0, firing: false,
    scene: new THREE.Scene(), obstacles: [] as TestObstacle[],
    projectiles: [] as TestProjectile[], enemies: [] as TestEnemy[],
    barrels: [] as { mesh: THREE.Group; active: boolean }[],
    pickups: [] as { mesh: THREE.Group; type: PickupId; value: number; age: number }[],
    effects: [] as { mesh: THREE.Object3D; life: number; maxLife: number }[],
    projectileStart: new THREE.Vector3(), projectileEnd: new THREE.Vector3(),
    projectileNormal: new THREE.Vector3(), projectileUp: new THREE.Vector3(0, 1, 0),
    weaponStates: new Map<WeaponId, WeaponInstance>([["pistol", {
      id: "pistol", rank: 1, magazine: WEAPONS.pistol.magazine,
      reserve: WEAPONS.pistol.reserve, cooldown: 0, reloading: 0,
    }]]), loadout: ["pistol"] as WeaponId[], activeWeaponIndex: 0,
    stats: createRunStats(), wave: 1, waveActive: true, endless: false,
    waveCleared: false, extractionTimer: 0, extractionZoneMesh: new THREE.Group(),
    currentArena: null, spawnQueue: [], spawnTimer: 0,
    callbacks: { onCoins: vi.fn(), onVictory: vi.fn(), onWaveComplete: vi.fn(), onWaveChange: vi.fn() },
    audio: { playDash: vi.fn(), tone: vi.fn(), playReload: vi.fn(), playPickup: vi.fn(), configure: vi.fn() },
    visuals: { createRadialSpeedLinesMesh: () => new THREE.Group(), createDashGhost: () => new THREE.Group(),
      disposeObject: vi.fn(), setPlayerWeapon: vi.fn() },
    spawnFloatingText: vi.fn(), emitHud: vi.fn(), pause: vi.fn(),
    clearHazards: vi.fn(), buildArena: vi.fn(),
    damageEnemy: vi.fn((enemy: TestEnemy, damage: number) => { enemy.health -= damage; }),
    damagePlayer: vi.fn(), damageObstacle: vi.fn(), explodeBarrel: vi.fn(),
    accumulator: 0, frameTimeAverage: 1 / 60, performanceSampleTime: 0,
    qaMode: true, qaFramesRendered: 2,
    timer: { update: vi.fn(), getDelta: (): number => 0.1 },
    step: vi.fn<(dt: number) => void>(), scheduleFrame: vi.fn(), post: { render: vi.fn() },
  });
  engine.pause.mockImplementation(() => { engine.paused = true; });
  return engine;
}

function enemy(x: number, z = 0, radius = 0.2): TestEnemy {
  const mesh = new THREE.Group(); mesh.position.set(x, 0, z);
  return { mesh, health: 100, definition: { radius } };
}
function bullet(overrides: Partial<TestProjectile> = {}): TestProjectile {
  return { mesh: new THREE.Mesh(), velocity: new THREE.Vector3(45, 0, 0),
    direction: new THREE.Vector3(1, 0, 0), damage: 20, knockback: 4, life: 1,
    enemy: false, ...overrides };
}
function pickup(type: PickupId, value = 25) {
  return { type, value, mesh: new THREE.Group(), age: 0 };
}

describe("engine movement", () => {
  it("dashes toward aim from a standstill and continues after movement is released", () => {
    const engine = engineHarness();
    engine.startDash();
    for (let i = 0; i < 12; i++) engine.updatePlayer(1 / 60);
    expect(engine.playerMesh.position.x).toBeGreaterThan(3);
    expect(engine.dashCooldown).toBeGreaterThan(0);
  });

  it("preserves partial stick speed while clamping diagonal keyboard movement", () => {
    const move = (stick: number, diagonal = false) => {
      const engine = engineHarness();
      engine.virtualMove.x = stick;
      if (diagonal) { engine.virtualMove.x = 0; engine.keys.add("KeyD"); engine.keys.add("KeyS"); }
      for (let i = 0; i < 10; i++) engine.updatePlayer(1 / 60);
      return engine.playerMesh.position.length();
    };
    expect(move(0.25) / move(1)).toBeCloseTo(0.25);
    expect(move(0, true)).toBeCloseTo(move(1));
  });

  it("keeps the shortened dash cooldown's displayed total in sync", () => {
    const engine = engineHarness(); engine.activeSynergies.set("phantom_reflex", 2);
    engine.startDash();
    expect(engine.dashCooldownTotal).toBeCloseTo(2.8 * 0.64);
    expect(engine.dashCooldown).toBe(engine.dashCooldownTotal);
  });
});

describe("swept projectile collision", () => {
  it("hits a grazing enemy between frame endpoints", () => {
    const engine = engineHarness(); const target = enemy(0.375, 0.39);
    engine.enemies = [target]; engine.projectiles = [bullet()];
    engine.updateProjectiles(1 / 60);
    expect(target.health).toBe(80);
    expect(engine.projectiles).toHaveLength(0);
  });

  it("hits the nearest enemy regardless of spawn order", () => {
    const engine = engineHarness(); const near = enemy(0.8); const far = enemy(1.5);
    engine.enemies = [near, far]; engine.projectiles = [bullet()];
    engine.updateProjectiles(0.05);
    expect(near.health).toBe(80); expect(far.health).toBe(100);
  });

  it("stops on thin cover before an enemy", () => {
    const engine = engineHarness(); const target = enemy(0.7, 0, 0.1);
    engine.obstacles = [{ x: 0.25, z: 0, hx: 0.02, hz: 1, health: 50 }];
    engine.enemies = [target]; engine.projectiles = [bullet()];
    engine.updateProjectiles(1 / 60);
    expect(engine.damageObstacle).toHaveBeenCalledOnce(); expect(target.health).toBe(100);
  });

  it("hits an enemy in front of cover instead of absorbing the shot in the wall", () => {
    const engine = engineHarness(); const target = enemy(0.45, 0, 0.1);
    engine.obstacles = [{ x: 0.7, z: 0, hx: 0.04, hz: 1, health: 50 }];
    engine.enemies = [target]; engine.projectiles = [bullet()];
    engine.updateProjectiles(1 / 60);
    expect(target.health).toBe(80); expect(engine.damageObstacle).not.toHaveBeenCalled();
  });

  it("pierces targets once each, in travel order", () => {
    const engine = engineHarness(); const near = enemy(0.8); const far = enemy(1.5);
    engine.enemies = [far, near]; engine.projectiles = [bullet({ maxPierces: 1 })];
    engine.updateProjectiles(0.05);
    expect(engine.damageEnemy.mock.calls.map(([target]) => target)).toEqual([near, far]);
    expect(engine.projectiles).toHaveLength(0);
  });

  it("retains speed and a unit direction when ricocheting", () => {
    const engine = engineHarness(); const shot = bullet({ bouncesRemaining: 1 });
    engine.obstacles = [{ x: 0.7, z: 0, hx: 0.1, hz: 1 }];
    engine.enemies = [enemy(-2, 2)]; engine.projectiles = [shot];
    engine.updateProjectiles(1 / 60);
    expect(shot.direction.length()).toBeCloseTo(1);
    expect(shot.velocity.length()).toBeCloseTo(45);
    expect(shot.velocity.x).toBeLessThan(0);
    expect(shot.mesh.position.x).toBeLessThan(0.6);
  });

  it("checks the remaining travel before a projectile expires", () => {
    const engine = engineHarness(); const target = enemy(0.1, 0, 0.01);
    engine.enemies = [target]; engine.projectiles = [bullet({ life: 0.005 })];
    engine.updateProjectiles(1 / 60);
    expect(target.health).toBe(80);
  });
});

describe("supplies and wave transitions", () => {
  it("leaves unneeded health and ammo on the ground", () => {
    const engine = engineHarness(); engine.pickups = [pickup("health"), pickup("ammo")];
    engine.updatePickups(1 / 60);
    expect(engine.pickups).toHaveLength(2);
    engine.playerHealth = 90; engine.weaponStates.get("pistol")!.reserve = 0;
    engine.updatePickups(1 / 60);
    expect(engine.pickups).toHaveLength(0); expect(engine.playerHealth).toBe(100);
    expect(engine.spawnFloatingText).toHaveBeenCalledWith(expect.anything(), "+10 HP", "health");
  });

  it("banks a magnet sweep in one profile update", () => {
    const engine = engineHarness(); engine.pickups = [pickup("coin", 5), pickup("coin", 8), pickup("coin", 13)];
    engine.updatePickups(1 / 60);
    expect(engine.callbacks.onCoins).toHaveBeenCalledExactlyOnceWith(26);
  });

  it("cannot revive a dead operator by collecting a health pack", () => {
    const engine = engineHarness(); engine.playerHealth = 0; engine.pickups = [pickup("health")];
    engine.updatePickups(1 / 60);
    expect(engine.playerHealth).toBe(0); expect(engine.pickups).toHaveLength(1);
  });

  it("banks uncollected final-boss salvage before showing victory", () => {
    const engine = engineHarness(); engine.wave = 10; engine.pickups = [pickup("coin", 200)];
    engine.completeWave();
    expect(engine.callbacks.onCoins).toHaveBeenCalledExactlyOnceWith(200);
    expect(engine.callbacks.onVictory).toHaveBeenCalledOnce();
    expect(engine.callbacks.onCoins.mock.invocationCallOrder[0]).toBeLessThan(engine.callbacks.onVictory.mock.invocationCallOrder[0]);
    expect(engine.stats.wavesCleared).toBe(1);
  });

  it("clears old projectiles and supplies when entering a new wave", () => {
    const engine = engineHarness(); engine.projectiles = [bullet({ enemy: true })];
    engine.pickups = [pickup("ammo")]; engine.effects = [{ mesh: new THREE.Group(), life: 1, maxLife: 1 }];
    engine.startWave(2);
    expect(engine.projectiles).toHaveLength(0); expect(engine.pickups).toHaveLength(0);
    expect(engine.effects).toHaveLength(0); expect(engine.clearHazards).toHaveBeenCalledOnce();
  });

  it("does not reconfigure audio or force a HUD update for salvage-only commits", () => {
    const engine = engineHarness(); engine.setProfile({ ...engine.profile, coins: 50 });
    expect(engine.profile.coins).toBe(50);
    expect(engine.audio.configure).not.toHaveBeenCalled(); expect(engine.emitHud).not.toHaveBeenCalled();
  });
});

describe("slow-frame simulation", () => {
  it("advances a 100ms frame in fixed steps instead of dropping half the time", () => {
    const engine = engineHarness(); engine.renderFrame();
    expect(engine.step).toHaveBeenCalledTimes(6);
    expect(engine.step.mock.calls.every(([dt]) => dt === 1 / 60)).toBe(true);
  });

  it("bounds catch-up work after a long stall", () => {
    const engine = engineHarness(); engine.timer.getDelta = () => 5;
    engine.renderFrame();
    expect(engine.step.mock.calls.length).toBeLessThanOrEqual(8);
  });
});

describe("collision math", () => {
  it("handles stationary, tangent and missed segments", () => {
    expect(segmentCircleHit({ x: 0, z: 0 }, { x: 0, z: 0 }, { x: 0, z: 0 }, 1)).toBe(0);
    expect(segmentCircleHit({ x: -2, z: 1 }, { x: 2, z: 1 }, { x: 0, z: 0 }, 1)).toBe(0.5);
    expect(segmentCircleHit({ x: -2, z: 2 }, { x: 2, z: 2 }, { x: 0, z: 0 }, 1)).toBeNull();
    expect(segmentObstacleHit({ x: 2, z: -2 }, { x: 2, z: 2 }, { x: 0, z: 0, hx: 1, hz: 1 })).toBeNull();
  });

  it("pushes an embedded actor out of boxes and cylindrical vats", () => {
    const position = { x: 0, z: 0 };
    resolveCircleObstacle(position, 0.5, { x: 0, z: 0, hx: 1, hz: 2 });
    expect(position).toEqual({ x: 1.5, z: 0 });
    position.x = 0;
    resolveCircleObstacle(position, 0.5, { x: 0, z: 0, hx: 1, hz: 1, radius: 1 });
    expect(position).toEqual({ x: 1.5, z: 0 });
  });

  it("slides along cover without losing tangential velocity", () => {
    const position = { x: 1.2, z: 0 }; const velocity = { x: -2, z: 3 };
    resolveCircleObstacle(position, 0.5, { x: 0, z: 0, hx: 1, hz: 1 }, velocity);
    expect(position.x).toBeCloseTo(1.5); expect(velocity).toEqual({ x: 0, z: 3 });
  });
});

describe("kinetic combat systems and bug regressions", () => {
  it("completes an active tactical reload inside the sweet spot and overcharges the magazine", () => {
    const engine = engineHarness();
    const pistol = engine.weaponStates.get("pistol")!;
    pistol.magazine = 0;
    pistol.reloading = 0.45;
    pistol.reloadDuration = 1.0; // progress = 0.55 (inside 0.48..0.72)
    engine.reload();
    expect(pistol.reloading).toBe(0);
    expect(pistol.magazine).toBe(WEAPONS.pistol.magazine);
    expect(pistol.overchargedRounds).toBe(WEAPONS.pistol.magazine);
    expect((engine as unknown as { overdriveCharge: number }).overdriveCharge).toBe(15);
  });

  it("penalizes a missed active tactical reload with a jam delay", () => {
    const engine = engineHarness();
    const pistol = engine.weaponStates.get("pistol")!;
    pistol.magazine = 0;
    pistol.reloading = 0.9;
    pistol.reloadDuration = 1.0; // progress = 0.10 (too early)
    engine.reload();
    expect(pistol.reloading).toBeCloseTo(1.15);
    expect(pistol.overchargedRounds ?? 0).toBe(0);
  });

  it("triggers Perfect Dodge once per dash when evading an incoming hit", () => {
    const engine = engineHarness();
    delete (engine as unknown as Record<string, unknown>).damagePlayer;
    engine.startDash();
    const beforeCooldown = engine.dashCooldown;
    engine.damagePlayer(25);
    expect(engine.playerHealth).toBe(100);
    expect(engine.dashCooldown).toBeLessThan(beforeCooldown);
    expect((engine as unknown as { overdriveCharge: number }).overdriveCharge).toBe(22);
    expect((engine as unknown as { perfectDodgeShotBuff: boolean }).perfectDodgeShotBuff).toBe(true);
    // Second hit in the same dash does not double-trigger Perfect Dodge.
    engine.damagePlayer(25);
    expect((engine as unknown as { overdriveCharge: number }).overdriveCharge).toBe(22);
  });

  it("activates Overdrive at 100% charge, refills the active magazine, and pushes back nearby enemies", () => {
    const engine = engineHarness();
    const closeEnemy = enemy(2, 0, 0.5);
    engine.enemies = [closeEnemy];
    engine.weaponStates.get("pistol")!.magazine = 2;
    (engine as unknown as { overdriveCharge: number }).overdriveCharge = 100;
    (engine as unknown as { clearTelegraph: () => void }).clearTelegraph = vi.fn();
    engine.triggerOverdrive();
    expect((engine as unknown as { overdriveRemaining: number }).overdriveRemaining).toBeGreaterThan(0);
    expect((engine as unknown as { overdriveCharge: number }).overdriveCharge).toBe(0);
    expect(engine.weaponStates.get("pistol")!.magazine).toBe(WEAPONS.pistol.magazine);
    expect(closeEnemy.health).toBeLessThan(100);
  });

  it("refills a dry holstered secondary weapon when the active weapon is already full", () => {
    const engine = engineHarness();
    engine.profile = { ...engine.profile, ownedWeapons: ["pistol", "smg"], equippedLoadout: ["pistol", "smg"] };
    engine.loadout = ["pistol", "smg"];
    engine.weaponStates.set("smg", {
      id: "smg", rank: 1, magazine: WEAPONS.smg.magazine, reserve: 0, cooldown: 0, reloading: 0,
    });
    engine.pickups = [pickup("ammo")];
    engine.updatePickups(1 / 60);
    expect(engine.pickups).toHaveLength(0);
    expect(engine.weaponStates.get("smg")!.reserve).toBeGreaterThan(0);
  });

  it("damages the operator inside hostile Toxic Bloom pools while friendly acid trails stay safe", () => {
    const engine = engineHarness();
    (engine as unknown as { hazards: Array<Record<string, unknown>> }).hazards = [
      { mesh: new THREE.Group(), x: 0, z: 0, radius: 2, dps: 40, life: 5, maxLife: 5, tickTimer: 0, hostile: false },
    ];
    engine.updateHazards(1 / 60);
    expect(engine.damagePlayer).not.toHaveBeenCalled();

    (engine as unknown as { hazards: Array<Record<string, unknown>> }).hazards = [
      { mesh: new THREE.Group(), x: 0, z: 0, radius: 2, dps: 26, life: 5, maxLife: 5, tickTimer: 0, hostile: true },
    ];
    engine.updateHazards(1 / 60);
    expect(engine.damagePlayer).toHaveBeenCalledOnce();
  });

  it("amplifies ricochet damage and refreshes piercing when Rail-Bounce fusion is active", () => {
    const engine = engineHarness();
    (engine as unknown as { unlockedFusions: Set<string> }).unlockedFusions = new Set(["rail_bounce"]);
    const shot = bullet({ bouncesRemaining: 1, maxPierces: 1, damage: 20 });
    (shot as unknown as { pierceCount: number }).pierceCount = 1;
    engine.obstacles = [{ x: 0.7, z: 0, hx: 0.1, hz: 1 }];
    engine.enemies = [enemy(-2, 2)];
    engine.projectiles = [shot];
    engine.updateProjectiles(1 / 60);
    expect(shot.damage).toBe(29);
    expect((shot as unknown as { pierceCount: number }).pierceCount).toBe(0);
  });

  it("chain-detonates nearby explosive barrels after a short fuse delay", () => {
    const engine = engineHarness();
    delete (engine as unknown as Record<string, unknown>).explodeBarrel;
    const barrelA = { mesh: new THREE.Group(), active: true };
    const barrelB = { mesh: new THREE.Group(), active: true };
    barrelB.mesh.position.set(3, 0, 0);
    engine.barrels = [barrelA, barrelB];
    (engine as unknown as { audio: Record<string, unknown> }).audio.playExplosion = vi.fn();
    (engine as unknown as { visuals: Record<string, unknown> }).visuals.addBloodDecal = vi.fn();
    (engine as unknown as { barrelBlastGeometry: THREE.BufferGeometry }).barrelBlastGeometry = new THREE.SphereGeometry(1, 4, 4);
    engine.explodeBarrel(barrelA);
    expect(barrelA.active).toBe(false);
    expect((barrelB as { chainTimer?: number }).chainTimer).toBeGreaterThan(0);
    engine.updateBarrels(0.2);
    expect(barrelB.active).toBe(false);
  });

  it("throws a tactical frag grenade that detonates after its fuse and damages nearby enemies", () => {
    const engine = engineHarness();
    const target = enemy(3, 0, 0.5);
    engine.enemies = [target];
    (engine as unknown as { mouseWorldPos: THREE.Vector3 }).mouseWorldPos = new THREE.Vector3(3, 0, 0);
    (engine as unknown as { grenades: unknown[] }).grenades = [];
    (engine as unknown as { grenadeCooldown: number }).grenadeCooldown = 0;
    (engine as unknown as { grenadeCooldownTotal: number }).grenadeCooldownTotal = 8;
    (engine as unknown as { clearTelegraph: () => void }).clearTelegraph = vi.fn();
    (engine as unknown as { audio: Record<string, unknown> }).audio.playExplosion = vi.fn();
    (engine as unknown as { throwGrenade(): void }).throwGrenade();
    expect((engine as unknown as { grenades: unknown[] }).grenades).toHaveLength(1);
    expect((engine as unknown as { grenadeCooldown: number }).grenadeCooldown).toBe(8);
    for (let i = 0; i < 60; i += 1) (engine as unknown as { updateGrenades(dt: number): void }).updateGrenades(1 / 60);
    expect((engine as unknown as { grenades: unknown[] }).grenades).toHaveLength(0);
    expect(target.health).toBeLessThan(100);
  });

  it("teleport-executes a wounded enemy with Cyber-Blade, refills ammo, heals, and resets cooldown", () => {
    const engine = engineHarness();
    const wounded = enemy(5, 0, 0.5) as TestEnemy & { maxHealth: number };
    wounded.health = 30;
    wounded.maxHealth = 100;
    engine.enemies = [wounded];
    engine.playerHealth = 70;
    engine.weaponStates.get("pistol")!.magazine = 2;
    (engine as unknown as { bladeCooldown: number }).bladeCooldown = 0;
    (engine as unknown as { techEnergy: number }).techEnergy = 40;
    (engine as unknown as { clearTelegraph: () => void }).clearTelegraph = vi.fn();
    (engine as unknown as { performBladeSlash(): void }).performBladeSlash();
    expect(engine.playerMesh.position.x).toBeGreaterThan(4);
    expect(wounded.health).toBeLessThanOrEqual(0);
    expect(engine.playerHealth).toBe(80);
    expect(engine.weaponStates.get("pistol")!.magazine).toBe(WEAPONS.pistol.magazine);
    expect((engine as unknown as { bladeCooldown: number }).bladeCooldown).toBeLessThan(0.2);
  });

  it("deflects incoming enemy projectiles back toward hostiles on Cyber-Blade slash", () => {
    const engine = engineHarness();
    const spit = bullet({ enemy: true, damage: 15, velocity: new THREE.Vector3(-9, 0, 0) });
    spit.mesh.position.set(1.5, 1, 0);
    engine.projectiles = [spit];
    (engine as unknown as { bladeCooldown: number }).bladeCooldown = 0;
    (engine as unknown as { performBladeSlash(): void }).performBladeSlash();
    expect(spit.enemy).toBe(false);
    expect(spit.velocity.x).toBeGreaterThan(0);
    expect(spit.damage).toBeGreaterThanOrEqual(60);
  });

  it("links two deployed Tesla Pylons into a damaging electric laser fence", () => {
    const engine = engineHarness();
    (engine as unknown as { techEnergy: number }).techEnergy = 100;
    (engine as unknown as { deployables: unknown[] }).deployables = [];
    (engine as unknown as { laserFences: unknown[] }).laserFences = [];
    (engine as unknown as { visuals: Record<string, unknown> }).visuals.createTeslaPylon = () => new THREE.Group();
    (engine as unknown as { visuals: Record<string, unknown> }).visuals.createLaserFenceBeam = () => new THREE.Group();
    (engine as unknown as { visuals: Record<string, unknown> }).visuals.createShockwaveMesh = () => new THREE.Group();
    (engine as unknown as { damageFeedback: { add: ReturnType<typeof vi.fn> } }).damageFeedback = { add: vi.fn() };
    engine.playerMesh.position.set(0, 0, 0);
    engine.aim.set(1, 0, 0);
    (engine as unknown as { deployPylon(): void }).deployPylon();
    engine.playerMesh.position.set(5, 0, 0);
    (engine as unknown as { deployPylon(): void }).deployPylon();
    expect((engine as unknown as { laserFences: unknown[] }).laserFences).toHaveLength(1);

    const crossing = enemy(4.5, 0, 0.5);
    engine.enemies = [crossing];
    (engine as unknown as { updateDeployables(dt: number): void }).updateDeployables(0.2);
    expect(crossing.health).toBeLessThan(100);
  });
});
