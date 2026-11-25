"use client";
/* eslint-disable @next/next/no-img-element -- Pre-rendered local WebP game assets; no image service needed. */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { GameEngine as GameEngineType } from "@/game/GameEngine";
import {
  getPerkUpgradeCost,
  getRandomPerkDraft,
  getWeaponStats,
  getWeaponUpgradeCost,
  PERKS,
  PERK_IDS,
  SYNERGY_CARDS,
  WEAPONS,
  WEAPON_IDS,
} from "@/game/config";
import {
  ACTIVE_RELOAD_WINDOW_END,
  ACTIVE_RELOAD_WINDOW_START,
  getFusionCompletedByCard,
  OVERDRIVE_MAX_CHARGE,
  SYNERGY_FUSIONS,
} from "@/game/combat-systems";
import { PYLON_COST, TECH_ENERGY_MAX, TURRET_COST } from "@/game/tactical-overhaul";
import { purchaseWeapon, upgradePerk, upgradeWeapon } from "@/game/economy";
import { normalizeJoystick, resolveInputMode, triggerHaptic } from "@/game/mobile";
import { createDefaultProfile, getLocalStorage, loadProfile, saveProfile } from "@/game/profile";
import { formatMissionTime, getAccuracy, type RunStats } from "@/game/stats";
import type { ControlMode, GameScreen, GraphicsMode, HudState, InputMode, PerkId, ProfileV1, SynergyCardDefinition, SynergyCardId, WeaponId } from "@/game/types";
import { GameIcon } from "./GameIcon";
import { LobbyHero } from "./LobbyHero";

const initialHud: HudState = {
  health: 100,
  maxHealth: 100,
  wave: 1,
  enemies: 0,
  weapon: "pistol",
  weaponName: WEAPONS.pistol.name,
  magazine: WEAPONS.pistol.magazine,
  reserve: WEAPONS.pistol.reserve,
  reloading: 0,
  dash: 1,
  comboCount: 0,
  comboTimer: 0,
  activeSynergies: {},
};

type EngineStatus = "idle" | "loading" | "ready" | "error";

interface AdaptiveCapabilities {
  touchPrimary: boolean;
  compact: boolean;
  portrait: boolean;
}

const initialCapabilities: AdaptiveCapabilities = {
  touchPrimary: false,
  compact: false,
  portrait: false,
};

/** Redeploys granted at the start of a run, and the ceiling you can bank to. */
const STARTING_REDEPLOYS = 2;
const MAX_REDEPLOYS = 3;

export function Deadwave() {
  const [profile, setProfile] = useState<ProfileV1>(() => createDefaultProfile());
  const profileRef = useRef(profile);
  const [screen, setScreen] = useState<GameScreen>("lobby");
  const [hud, setHud] = useState<HudState>(initialHud);
  const [hydrated, setHydrated] = useState(false);
  const [notice, setNotice] = useState("");
  const [runToken, setRunToken] = useState(0);
  const [draftCards, setDraftCards] = useState<SynergyCardDefinition[]>([]);
  const [engineStatus, setEngineStatus] = useState<EngineStatus>("idle");
  const [capabilities, setCapabilities] = useState<AdaptiveCapabilities>(initialCapabilities);
  /** Wave the next run begins on, and the deck it carries in. */
  const [runStartWave, setRunStartWave] = useState(1);
  const [carriedSynergies, setCarriedSynergies] = useState<Partial<Record<SynergyCardId, number>>>({});
  /** Tallies from the life that just ended, and the ones a redeploy resumes. */
  const [runStats, setRunStats] = useState<RunStats | null>(null);
  const [carriedStats, setCarriedStats] = useState<RunStats | null>(null);
  const [deathWave, setDeathWave] = useState(1);
  /**
   * In-run redeploys. Spending one resumes the wave with your synergy deck
   * intact; running out ends the run and the deck with it. Salvage, weapons
   * and perks are meta-progression and are never lost either way.
   */
  const [redeploys, setRedeploys] = useState(STARTING_REDEPLOYS);
  const stageRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<GameEngineType | null>(null);
  const orientationPauseRef = useRef(false);

  useEffect(() => {
    // A timeout rather than a frame: requestAnimationFrame does not run in a
    // hidden tab, so a game opened in the background — or backgrounded while
    // loading, which is most of a phone's life — sat on the boot screen until
    // it was brought forward again.
    const handle = window.setTimeout(() => {
      // The whole game sits behind this flag, so nothing a stored profile can
      // do is allowed to strand the player on the boot screen.
      try {
        const saved = loadProfile(getLocalStorage());
        profileRef.current = saved;
        setProfile(saved);
      } finally {
        setHydrated(true);
      }
    }, 0);
    return () => window.clearTimeout(handle);
  }, []);

  useEffect(() => {
    const coarsePointer = window.matchMedia("(pointer: coarse)");
    const noHover = window.matchMedia("(hover: none)");
    const portrait = window.matchMedia("(orientation: portrait)");
    const compact = window.matchMedia("(max-width: 900px), (max-height: 560px)");
    const syncCapabilities = () => {
      setCapabilities({
        touchPrimary: coarsePointer.matches && noHover.matches,
        compact: compact.matches,
        portrait: portrait.matches,
      });
    };

    const addMediaListener = (mql: MediaQueryList, listener: () => void) => {
      if (typeof mql.addEventListener === "function") {
        mql.addEventListener("change", listener);
      } else if (typeof (mql as unknown as { addListener: (cb: () => void) => void }).addListener === "function") {
        (mql as unknown as { addListener: (cb: () => void) => void }).addListener(listener);
      }
    };
    const removeMediaListener = (mql: MediaQueryList, listener: () => void) => {
      if (typeof mql.removeEventListener === "function") {
        mql.removeEventListener("change", listener);
      } else if (typeof (mql as unknown as { removeListener: (cb: () => void) => void }).removeListener === "function") {
        (mql as unknown as { removeListener: (cb: () => void) => void }).removeListener(listener);
      }
    };

    syncCapabilities();
    addMediaListener(coarsePointer, syncCapabilities);
    addMediaListener(noHover, syncCapabilities);
    addMediaListener(portrait, syncCapabilities);
    addMediaListener(compact, syncCapabilities);
    window.visualViewport?.addEventListener("resize", syncCapabilities);
    window.addEventListener("resize", syncCapabilities);
    window.addEventListener("orientationchange", syncCapabilities);
    return () => {
      removeMediaListener(coarsePointer, syncCapabilities);
      removeMediaListener(noHover, syncCapabilities);
      removeMediaListener(portrait, syncCapabilities);
      removeMediaListener(compact, syncCapabilities);
      window.visualViewport?.removeEventListener("resize", syncCapabilities);
      window.removeEventListener("resize", syncCapabilities);
      window.removeEventListener("orientationchange", syncCapabilities);
    };
  }, []);

  const inputMode = resolveInputMode(profile.settings.controlMode, capabilities.touchPrimary);
  const orientationBlocked = inputMode === "touch" && capabilities.portrait && screen === "playing";

  const commitProfile = useCallback((updater: (current: ProfileV1) => ProfileV1) => {
    // Keep commits synchronous for consecutive pickups/purchases, but perform
    // storage and engine callbacks outside React's replayable state updater.
    const next = updater(profileRef.current);
    profileRef.current = next;
    saveProfile(getLocalStorage(), next);
    engineRef.current?.setProfile(next);
    setProfile(next);
  }, []);

  useEffect(() => {
    if (screen !== "playing" || !stageRef.current || engineRef.current) return;
    let cancelled = false;
    const mount = stageRef.current;
    void (async () => {
      let engine: GameEngineType | null = null;
      try {
        const { GameEngine } = await import("@/game/GameEngine");
        if (cancelled || !mount || engineRef.current) return;
        engine = new GameEngine(mount, profile, {
          onHud: setHud,
          onCoins: (amount) => commitProfile((current) => ({ ...current, coins: current.coins + amount })),
          onWaveChange: (wave) =>
            commitProfile((current) => ({
              ...current,
              highestWave: Math.max(current.highestWave, Math.min(10, wave)),
              bestEndlessWave: Math.max(current.bestEndlessWave, wave > 10 ? wave : 0),
            })),
          onWaveComplete: (wave) => {
            // Boss waves (5, 10, and every fifth endless surge) bank a redeploy.
            if (wave % 5 === 0) setRedeploys((left) => Math.min(MAX_REDEPLOYS, left + 1));
            const nextCards = getRandomPerkDraft(engineRef.current?.getSynergies() ?? {}, 3);
            if (nextCards.length > 0) {
              setDraftCards(nextCards);
              setScreen("draft");
            } else {
              setScreen("armory");
            }
          },
          onDeath: () => {
            const wave = engineRef.current?.getWave() ?? 1;
            const deck = engineRef.current?.getSynergies() ?? {};
            setDeathWave(wave);
            setCarriedSynergies(deck);
            setRunStats(engineRef.current?.getRunStats() ?? null);
            // Bank the checkpoint so it survives a refresh, not just this session.
            commitProfile((current) => ({
              ...current,
              checkpointWave: Math.max(current.checkpointWave ?? 1, wave),
            }));
            setScreen("dead");
          },
          onVictory: () => {
            setRunStats(engineRef.current?.getRunStats() ?? null);
            commitProfile((current) => ({
              ...current,
              highestWave: 10,
              completedLevels: current.completedLevels.includes(1) ? current.completedLevels : [...current.completedLevels, 1],
            }));
            setScreen("victory");
          },
          onPauseToggle: () => {
            setScreen((current) => {
              if (current === "playing") {
                engineRef.current?.pause();
                return "paused";
              }
              if (current === "paused") {
                engineRef.current?.resume();
                return "playing";
              }
              return current;
            });
          },
        }, { inputMode, mobileRendering: capabilities.touchPrimary, graphicsMode: profile.settings.graphicsMode });
        engineRef.current = engine;
        engine.start(runStartWave);
        // start() only clears synergies on wave 1, but the engine itself was
        // rebuilt, so the deck and the tallies have to be re-applied for a
        // redeploy to feel like the same run.
        if (Object.keys(carriedSynergies).length > 0) engine.restoreSynergies(carriedSynergies);
        if (carriedStats) engine.restoreRunStats(carriedStats);
        if (!cancelled) setEngineStatus("ready");
      } catch {
        engine?.destroy();
        if (engineRef.current === engine) engineRef.current = null;
        if (!cancelled) setEngineStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [screen, runToken, profile, commitProfile, runStartWave, carriedSynergies, carriedStats, inputMode, capabilities.touchPrimary]);

  useEffect(() => () => engineRef.current?.destroy(), []);

  useEffect(() => {
    engineRef.current?.setInputMode(inputMode);
  }, [inputMode]);

  useEffect(() => {
    engineRef.current?.setGraphicsMode(profile.settings.graphicsMode);
  }, [profile.settings.graphicsMode]);

  useEffect(() => {
    const engine = engineRef.current;
    if (orientationBlocked) {
      if (engine && !orientationPauseRef.current) {
        engine.pause();
        orientationPauseRef.current = true;
      }
      return;
    }
    if (orientationPauseRef.current) {
      if (engine && screen === "playing") engine.resume();
      orientationPauseRef.current = false;
    }
  }, [orientationBlocked, screen, engineStatus]);

  const gameVisible = ["playing", "paused", "armory", "draft", "dead", "victory"].includes(screen);
  const healthPercent = Math.max(0, Math.min(100, (hud.health / hud.maxHealth) * 100));

  const startNewRun = (
    wave = 1,
    deck: Partial<Record<SynergyCardId, number>> = {},
    budget = STARTING_REDEPLOYS,
    stats: RunStats | null = null,
  ) => {
    engineRef.current?.destroy();
    engineRef.current = null;
    setHud(initialHud);
    setNotice("");
    setEngineStatus("loading");
    setRunStartWave(wave);
    setCarriedSynergies(deck);
    setCarriedStats(stats);
    setRedeploys(budget);
    setRunToken((token) => token + 1);
    setScreen("playing");
  };

  const returnToLobby = () => {
    engineRef.current?.destroy();
    engineRef.current = null;
    setEngineStatus("idle");
    setScreen("lobby");
  };

  const toggleLoadoutWeapon = (id: WeaponId) => {
    if (!profile.ownedWeapons.includes(id)) return;
    commitProfile((current) => {
      const equipped = current.equippedLoadout.includes(id)
        ? current.equippedLoadout.filter((weapon) => weapon !== id)
        : current.equippedLoadout.length < 2
          ? [...current.equippedLoadout, id]
          : [current.equippedLoadout[0], id];
      return { ...current, equippedLoadout: equipped.length ? equipped : ["pistol"] };
    });
  };

  const buyWeapon = (id: WeaponId) => {
    const result = purchaseWeapon(profile, id);
    if (!result.ok) {
      setNotice(result.reason === "insufficient" ? "Not enough salvage." : "Weapon already owned.");
      return;
    }
    setNotice(`${WEAPONS[id].name} added to your loadout.`);
    commitProfile(() => result.profile);
    engineRef.current?.equipLoadout(result.profile.equippedLoadout);
  };

  const buyWeaponUpgrade = (id: WeaponId) => {
    const result = upgradeWeapon(profile, id);
    if (!result.ok) {
      setNotice(
        result.reason === "insufficient"
          ? "Not enough salvage."
          : result.reason === "unowned"
            ? "Acquire the weapon before upgrading it."
            : "Weapon is already rank V.",
      );
      return;
    }
    setNotice(`${WEAPONS[id].name} upgraded to rank ${result.profile.weaponRanks[id]}.`);
    commitProfile(() => result.profile);
  };

  const buyPerkUpgrade = (id: PerkId) => {
    const result = upgradePerk(profile, id);
    if (!result.ok) {
      setNotice(result.reason === "insufficient" ? "Not enough salvage." : "Perk is already at maximum rank.");
      return;
    }
    setNotice(`${PERKS[id].name} upgraded.`);
    commitProfile(() => result.profile);
  };

  const refillAmmo = () => {
    if (profile.coins < 20) {
      setNotice("You need 20 salvage for a full ammunition refill.");
      return;
    }
    if (!engineRef.current?.refillAmmo()) {
      setNotice("Equipped weapon ammunition is already full.");
      return;
    }
    commitProfile((current) => ({ ...current, coins: current.coins - 20 }));
    setNotice("All equipped weapons refilled.");
  };

  const selectPerkCard = (cardId: SynergyCardId) => {
    engineRef.current?.addSynergy(cardId);
    setDraftCards([]);
    setScreen("armory");
  };

  const continueWave = () => {
    setNotice("");
    engineRef.current?.startNextWave();
    setScreen("playing");
  };

  const toggleSetting = (key: "music" | "sfx" | "reducedMotion") => {
    commitProfile((current) => ({ ...current, settings: { ...current.settings, [key]: !current.settings[key] } }));
  };

  const setControlMode = (controlMode: ControlMode) => {
    commitProfile((current) => ({ ...current, settings: { ...current.settings, controlMode } }));
  };

  const setGraphicsMode = (graphicsMode: GraphicsMode) => {
    commitProfile((current) => ({ ...current, settings: { ...current.settings, graphicsMode } }));
  };

  if (!hydrated) return <main className="boot-screen"><span>ESTABLISHING TACTICAL LINK…</span></main>;

  return (
    <main
      className={`deadwave ${profile.settings.reducedMotion ? "reduced-motion" : ""}`}
      data-input-mode={inputMode}
      data-handheld={capabilities.touchPrimary ? "true" : "false"}
      data-compact={capabilities.compact ? "true" : "false"}
      data-orientation-blocked={orientationBlocked ? "true" : "false"}
      data-graphics-mode={profile.settings.graphicsMode}
    >
      {!gameVisible && <LobbyBackground />}

      {screen === "lobby" && (
        <Lobby
          profile={profile}
          onStart={() => setScreen("loadout")}
          onOpenArmory={() => { setNotice(""); setScreen("shop"); }}
          onResume={() => startNewRun(profile.checkpointWave, {})}
          onToggleSetting={toggleSetting}
          inputMode={inputMode}
          onControlModeChange={setControlMode}
          onGraphicsModeChange={setGraphicsMode}
          handheld={capabilities.touchPrimary}
        />
      )}

      {screen === "loadout" && (
        <Loadout
          profile={profile}
          onToggleWeapon={toggleLoadoutWeapon}
          onBack={() => setScreen("lobby")}
          onDeploy={() => startNewRun(1, {})}
        />
      )}

      {screen === "shop" && (
        <Armory
          mode="lobby"
          profile={profile}
          notice={notice}
          onBuyWeapon={buyWeapon}
          onUpgradeWeapon={buyWeaponUpgrade}
          onUpgradePerk={buyPerkUpgrade}
          onContinue={() => setScreen("lobby")}
        />
      )}

      {gameVisible && (
        <section
          className={`game-view ${hud.overdriveActive ? "is-overdrive" : ""}`}
          data-testid="game-stage"
          data-wave={hud.wave}
          onPointerMove={(event) => {
            event.currentTarget.style.setProperty("--aim-x", `${event.clientX}px`);
            event.currentTarget.style.setProperty("--aim-y", `${event.clientY}px`);
          }}
        >
          <div className="canvas-mount" ref={stageRef} />
          <div className="vignette" aria-hidden="true" />
          {engineStatus === "ready" && inputMode === "keyboard" && (
            <div className={`combat-reticle ${hud.overdriveActive ? "is-overdrive" : ""} ${(hud.overchargedRounds ?? 0) > 0 ? "is-overcharged" : ""}`} aria-hidden="true">
              <i /><b />
              {hud.reloading > 0 && (
                <div className="reticle-reload-track">
                  {hud.activeReloadAvailable && (
                    <span
                      className="reticle-sweet-spot"
                      style={{
                        left: `${ACTIVE_RELOAD_WINDOW_START * 100}%`,
                        width: `${(ACTIVE_RELOAD_WINDOW_END - ACTIVE_RELOAD_WINDOW_START) * 100}%`,
                      }}
                    />
                  )}
                  <span className="reticle-reload-cursor" style={{ left: `${(hud.reloadProgress ?? 0) * 100}%` }} />
                </div>
              )}
            </div>
          )}
          {engineStatus === "ready" && (
            <Hud
              hud={hud}
              redeploys={redeploys}
              coins={profile.coins}
              healthPercent={healthPercent}
              weaponRank={profile.weaponRanks[hud.weapon] ?? 1}
              loadoutCount={Math.max(profile.equippedLoadout.length, profile.ownedWeapons.length)}
            />
          )}
          {screen === "playing" && engineStatus === "ready" && inputMode === "keyboard" && (
            <div className="game-controls">
              <span><b>WASD</b> Move</span>
              <span><b>L-CLICK</b> Fire</span>
              <span><b>R-CLICK / V</b> Blade Execute</span>
              <span><b>T</b> Turret</span>
              <span><b>C</b> Laser Pylon</span>
              <span><b>G</b> Frag</span>
              <span><b>F</b> Overdrive</span>
              <span><b>SPACE</b> Dash</span>
              <span><b>R</b> Reload</span>
            </div>
          )}
          {screen === "playing" && engineStatus === "ready" && inputMode === "touch" && !orientationBlocked && (
            <MobileControls
              onMove={(x, z) => engineRef.current?.setVirtualMove(x, z)}
              onFire={(active) => engineRef.current?.setVirtualFire(active)}
              onAction={(action) => engineRef.current?.triggerVirtualAction(action)}
              reloading={hud.reloading > 0}
              activeReloadAvailable={Boolean(hud.activeReloadAvailable)}
              grenadeReady={(hud.grenade ?? 1) >= 1}
              bladeReady={(hud.blade ?? 1) >= 1}
              executeReady={Boolean(hud.executeTargetReady)}
              turretReady={(hud.techEnergy ?? 0) >= TURRET_COST}
              pylonReady={(hud.techEnergy ?? 0) >= PYLON_COST}
              overdriveReady={(hud.overdriveCharge ?? 0) >= OVERDRIVE_MAX_CHARGE}
              overdriveActive={Boolean(hud.overdriveActive)}
              onPause={() => {
                engineRef.current?.pause();
                setScreen("paused");
              }}
            />
          )}
          {orientationBlocked && (
            <div className="orientation-blocker" role="dialog" aria-modal="true" aria-label="Rotate device">
              <span className="orientation-phone" aria-hidden="true">▯</span>
              <p className="eyebrow">COMBAT DISPLAY LOCKED</p>
              <h2>ROTATE TO LANDSCAPE</h2>
              <p>Turn your device sideways to continue the operation.</p>
            </div>
          )}
          {screen === "playing" && engineStatus === "loading" && (
            <div className="engine-status" role="status" aria-live="polite">
              <p className="eyebrow">DEPLOYING OPERATOR</p>
              <h2>ESTABLISHING COMBAT LINK…</h2>
              <span>Initializing quarantine depot, cel-shaded renderer, and physics world.</span>
            </div>
          )}
          {screen === "playing" && engineStatus === "error" && (
            <div className="engine-status engine-error" role="alert">
              <p className="eyebrow">COMBAT LINK FAILED</p>
              <h2>The depot arena could not be initialized.</h2>
              <span>WebGL or a required game shader may be unavailable. Retry deployment or return to lobby.</span>
              <div className="engine-error-actions">
                <button className="primary-action" onClick={() => startNewRun(runStartWave, carriedSynergies)}>Retry deployment <span>→</span></button>
                <button className="text-action" onClick={returnToLobby}>Return to lobby</button>
              </div>
            </div>
          )}
        </section>
      )}

      {screen === "paused" && (
        <Modal eyebrow="Tactical Link Suspended" title="OPERATION PAUSED" wide={false}>
          <div className="pause-actions">
            <button className="primary-action" onClick={() => { engineRef.current?.resume(); setScreen("playing"); }}>Resume Operation <span>→</span></button>
            <SettingToggle label="Music" active={profile.settings.music} onClick={() => toggleSetting("music")} />
            <SettingToggle label="Sound Effects" active={profile.settings.sfx} onClick={() => toggleSetting("sfx")} />
            <SettingToggle label="Reduced Motion" active={profile.settings.reducedMotion} onClick={() => toggleSetting("reducedMotion")} />
            <ControlModeSelector value={profile.settings.controlMode} onChange={setControlMode} />
            <GraphicsModeSelector value={profile.settings.graphicsMode} onChange={setGraphicsMode} />
            <button className="text-action danger-action" onClick={returnToLobby}>Abandon Run</button>
          </div>
        </Modal>
      )}

      {screen === "draft" && (
        <DraftModal
          cards={draftCards}
          activeSynergies={hud.activeSynergies ?? {}}
          onSelect={selectPerkCard}
        />
      )}

      {screen === "armory" && (
        <Armory
          mode="wave"
          profile={profile}
          wave={hud.wave}
          notice={notice}
          onBuyWeapon={buyWeapon}
          onUpgradeWeapon={buyWeaponUpgrade}
          onUpgradePerk={buyPerkUpgrade}
          onRefill={refillAmmo}
          onContinue={continueWave}
        />
      )}

      {screen === "dead" && (
        <Modal
          eyebrow={redeploys > 0 ? "Vital Signs Lost" : "Run Terminated"}
          title={redeploys > 0 ? "M.I.A. IN SECTOR 01" : "NO REDEPLOYS LEFT"}
          wide={false}
        >
          <p className="modal-copy">
            {redeploys > 0 ? (
              <>
                Redeploy to wave {deathWave} with your synergy deck intact. Your
                weapons, ranks and <strong>{profile.coins} salvage</strong> are safe
                either way.
              </>
            ) : (
              <>
                The run is over and the synergy deck with it. Your weapons, ranks and{" "}
                <strong>{profile.coins} salvage</strong> carry over, and wave{" "}
                {profile.checkpointWave} stays unlocked — you just start the next run
                building a new deck.
              </>
            )}
          </p>
          <RunSummary stats={runStats} />
          <div className="result-actions">
            {redeploys > 0 ? (
              <button
                className="primary-action"
                data-testid="redeploy"
                onClick={() => startNewRun(deathWave, carriedSynergies, redeploys - 1, runStats)}
              >
                Redeploy to wave {deathWave} · {redeploys} left <span>→</span>
              </button>
            ) : (
              <button className="primary-action" onClick={returnToLobby}>
                Return to Command <span>→</span>
              </button>
            )}
            {redeploys > 0 && (
              <button className="text-action" onClick={returnToLobby}>
                End the run and return to Command
              </button>
            )}
          </div>
        </Modal>
      )}

      {screen === "victory" && (
        <Modal eyebrow="Extraction Successful // Depot Cleared" title="LEVEL 01 SURVIVED" wide>
          <div className="victory-grid">
            <div>
              <p className="modal-copy">The Juggernaut boss has fallen. All ten waves survived and maximum salvage extracted to headquarters.</p>
              <div className="victory-stat"><span>Final Wave</span><strong>10 / 10</strong></div>
              <div className="victory-stat"><span>Banked Salvage</span><strong>◆ {profile.coins}</strong></div>
            </div>
            <article className="next-level-card">
              <span className="level-index">02</span>
              <div className="lock-icon">⌁</div>
              <p className="eyebrow">Signal Acquired</p>
              <h3>Downtown Hospital</h3>
              <p>Emergency generators active. Bio-quarantine breached. Something inside is calling for help.</p>
              <span className="status-tag">Next Milestone</span>
            </article>
          </div>
          <RunSummary stats={runStats} />
          <div className="victory-actions">
            <button
              className="primary-action victory-button"
              data-testid="continue-endless"
              onClick={() => {
                engineRef.current?.continueEndless();
                setScreen("playing");
              }}
            >
              Push into the endless surge <span>→</span>
            </button>
            <button className="text-action" onClick={returnToLobby}>Return to Command</button>
          </div>
        </Modal>
      )}
    </main>
  );
}

function LobbyBackground() {
  return (
    <div className="lobby-background" aria-hidden="true">
      <div className="paper-grain" />
      <div className="halftone-wash" />
      <div className="speed-rays" />
    </div>
  );
}

function Lobby({
  profile,
  onStart,
  onOpenArmory,
  onResume,
  onToggleSetting,
  inputMode,
  onControlModeChange,
  onGraphicsModeChange,
  handheld,
}: {
  profile: ProfileV1;
  onStart: () => void;
  onOpenArmory: () => void;
  onResume: () => void;
  onToggleSetting: (key: "music" | "sfx" | "reducedMotion") => void;
  inputMode: InputMode;
  onControlModeChange: (mode: ControlMode) => void;
  onGraphicsModeChange: (mode: GraphicsMode) => void;
  handheld: boolean;
}) {
  const canResume = profile.checkpointWave > 1;
  const [settingsOpen, setSettingsOpen] = useState(false);
  return (
    <div className="menu-shell comic-lobby depot-lobby">
      <header className="depot-masthead">
        <div><span className="depot-wordmark">DEADWAVE<span> / </span></span><p>QUARANTINE RESPONSE UNIT</p></div>
        <button className="settings-control" data-testid="open-settings" aria-label="Settings" onClick={() => setSettingsOpen(true)}><GameIcon name="settings" /><span>Settings</span></button>
      </header>
      <div className="depot-lobby-grid">
        <section className={`operator-stage ${handheld ? "operator-stage-static" : "cover-panel"}`} aria-label="Operator in loading depot">
          {handheld ? <img className="operator-thumbnail" src="/images/operator.webp" alt="Kai, the cyan-armored survivor, in the loading depot" /> : <LobbyHero reducedMotion={profile.settings.reducedMotion} />}
          <div className="stage-caption"><span className="status-dot" /> OPERATOR READY <strong>KAI / RESPONSE 01</strong></div>
          <span className="stage-coordinate">N 43.65 / W 79.38</span>
        </section>
        <section className="depot-briefing">
          <p className="eyebrow">SECTOR 01 / LOADING DEPOT</p>
          <h1>HOLD THE LINE.<br /><span>MAKE IT OUT.</span></h1>
          <p className="depot-description">Ten waves. Four hostile sectors. Recover salvage, build your arsenal, and reach the extraction beacon.</p>
          <div className="depot-run-info"><span>WAVE SURVIVAL</span><span>SOLO OPERATION</span></div>
          <div className="cta-block">
            <button className="comic-cta" data-testid="start-mission" onClick={onStart}>{canResume ? "Start new run" : "Start operation"}<span aria-hidden="true">→</span></button>
            {canResume && <button className="comic-resume" data-testid="resume-run" onClick={onResume}>Resume · wave {profile.checkpointWave}<span aria-hidden="true">→</span></button>}
            <button className="comic-secondary" data-testid="open-armory" onClick={onOpenArmory}>Armory <span>◆ {profile.coins.toLocaleString()}</span></button>
          </div>
          <div className="depot-record"><span>PERSONAL BEST</span><strong>{String(profile.highestWave).padStart(2, "0")}<small> WAVE</small></strong><span>{profile.ownedWeapons.length} / 4 WEAPONS</span></div>
          <div className="controls-block">
            {inputMode === "touch" ? <p className="touch-control-summary" data-testid="touch-control-summary">Move with stick. Slash wounded foes to Teleport-Execute. Drop Turrets & Pylons.</p> : <p className="depot-key-guide"><b>WASD</b> Move <b>L-CLICK</b> Fire <b>R-CLICK</b> Blade Execute<br /><b>T</b> Auto-Turret <b>C</b> Tesla Fence <b>G</b> Frag <b>F</b> Overdrive <b>SPACE</b> Dash</p>}
          </div>
        </section>
      </div>
      <footer className="depot-footer"><span>ABANDONED LOADING DEPOT</span><span>STAY MOBILE. WATCH YOUR AMMO.</span></footer>
      {settingsOpen && <Modal eyebrow="OPERATOR PREFERENCES" title="SETTINGS" onDismiss={() => setSettingsOpen(false)}>
        <div className="settings-block">
          <div className="toggle-row">
            <button className={`toggle-chip ${profile.settings.music ? "on" : ""}`} onClick={() => onToggleSetting("music")} aria-pressed={profile.settings.music}>Music</button>
            <button className={`toggle-chip ${profile.settings.sfx ? "on" : ""}`} onClick={() => onToggleSetting("sfx")} aria-pressed={profile.settings.sfx}>SFX</button>
            <button className={`toggle-chip ${profile.settings.reducedMotion ? "on" : ""}`} onClick={() => onToggleSetting("reducedMotion")} aria-pressed={profile.settings.reducedMotion}>Reduced motion</button>
          </div>
          <ControlModeSelector value={profile.settings.controlMode} onChange={onControlModeChange} compact />
          <GraphicsModeSelector value={profile.settings.graphicsMode} onChange={onGraphicsModeChange} compact />
        </div>
        <button className="primary-action settings-done" onClick={() => setSettingsOpen(false)}>Done</button>
      </Modal>}
    </div>
  );
}

function Loadout({
  profile,
  onToggleWeapon,
  onBack,
  onDeploy,
}: {
  profile: ProfileV1;
  onToggleWeapon: (id: WeaponId) => void;
  onBack: () => void;
  onDeploy: () => void;
}) {
  return (
    <div className="menu-shell loadout-shell">
      <header className="screen-heading">
        <button className="back-button" onClick={onBack}>← Command</button>
        <div>
          <p className="eyebrow">PRE-OPERATION CHECK</p>
          <h2>CHOOSE YOUR LOADOUT</h2>
        </div>
        <div className="loadout-count">{profile.equippedLoadout.length} / 2 Slots Equipped</div>
      </header>

      <section className="loadout-grid">
        {WEAPON_IDS.map((id) => {
          const weapon = WEAPONS[id];
          const owned = profile.ownedWeapons.includes(id);
          const equipped = profile.equippedLoadout.includes(id);
          const rank = profile.weaponRanks[id] ?? 1;
          const stats = getWeaponStats(id, rank);

          return (
            <button
              key={id}
              className={`weapon-card ${equipped ? "equipped" : ""} ${!owned ? "unowned" : ""}`}
              aria-pressed={equipped}
              aria-label={`${equipped ? "Equipped" : owned ? "Owned" : "Locked"} ${weapon.name}`}
              onClick={() => onToggleWeapon(id)}
              disabled={!owned}
            >
              <div className="weapon-card-header">
                <span className="weapon-rank"> {rank}/5</span>
                <span className="equipped-badge">{equipped ? "EQUIPPED" : owned ? "OWNED" : "LOCKED"}</span>
              </div>
              <WeaponGlyph id={id} />
              <div className="weapon-card-body">
                <p className="eyebrow">{owned ? (equipped ? "Active Primary" : "Reserve Weapon") : `Cost: ${weapon.cost} Salvage`}</p>
                <h3>{weapon.name}</h3>
                <p>{weapon.description}</p>
              </div>
              <div className="weapon-mini-stats">
                <span>DMG <b>{Math.round(stats.damage)}</b></span>
                <span>MAG <b>{stats.magazine}</b></span>
                <span>RPM <b>{Math.round(stats.fireRate * 60)}</b></span>
                <span>RLD <b>{stats.reload.toFixed(1)}s</b></span>
              </div>
            </button>
          );
        })}
      </section>

      <footer className="deploy-bar">
        <p>Purchased weapons and upgrades persist permanently across all deployments.</p>
        <button className="primary-action" data-testid="deploy" onClick={onDeploy}>
          Deploy to Wave One <span>→</span>
        </button>
      </footer>
    </div>
  );
}

function Hud({
  hud,
  redeploys,
  coins,
  healthPercent,
  weaponRank,
  loadoutCount,
}: {
  hud: HudState;
  redeploys: number;
  coins: number;
  healthPercent: number;
  weaponRank: number;
  loadoutCount: number;
}) {
  const isLowHealth = healthPercent < 30;
  const isReloading = hud.reloading > 0;
  const formattedTime = formatMissionTime(hud.missionTime ?? 0);

  // No aria-live on the container: it re-renders a dozen times a second and a
  // screen reader would narrate every ammo tick. Only the banner announces.
  return (
    <div className={`comic-hud ${isLowHealth ? "low-health-warning" : ""}`}>
      {/* 1. TOP-LEFT: KAI HP, Dash Stamina & Angled Isometric Mini-Map */}
      <div className="comic-hud-top-left">
        <div className="operator-vitals-card">
          <div className="operator-title-row">
            <GameIcon name="vitality" className="heart-icon" />
            <strong className="operator-name">KAI <span>{Math.round(hud.health)} / {hud.maxHealth}</span></strong>
          </div>
          <div className="vital-bar health-bar">
            <div className="vital-fill health-fill-bar" style={{ width: `${healthPercent}%` }} />
          </div>
          <div className="tech-energy-row" title="Tech Energy: Press T for Auto-Turret (40) or C for Tesla Laser Pylon (45)">
            <span>TECH</span>
            <div className="vital-bar tech-bar">
              <div className="vital-fill tech-fill-bar" style={{ width: `${Math.min(100, ((hud.techEnergy ?? 0) / TECH_ENERGY_MAX) * 100)}%` }} />
            </div>
            <strong>{hud.techEnergy ?? 0}</strong>
          </div>
          <div className="deploy-mini-row">
            <span className={`deploy-chip ${(hud.techEnergy ?? 0) >= TURRET_COST ? "can-build" : ""}`}>
              <GameIcon name="turret" /> <b>T</b> TURRET {hud.turretCount ?? 0}/3
            </span>
            <span className={`deploy-chip ${(hud.techEnergy ?? 0) >= PYLON_COST ? "can-build" : ""}`}>
              <GameIcon name="pylon" /> <b>C</b> FENCE {hud.pylonCount ?? 0}/4
            </span>
          </div>

        </div>

        {/* Active Roguelite Synergies & Evolved Fusions Tray */}
        {((hud.activeSynergies && Object.keys(hud.activeSynergies).length > 0) || (hud.activeFusions && hud.activeFusions.length > 0)) && (
          <div className="hud-synergy-tray" aria-label="Active Battlefield Synergies">
            {hud.activeFusions?.map((fusionId) => {
              const fusion = SYNERGY_FUSIONS[fusionId];
              if (!fusion) return null;
              return (
                <div
                  key={`fusion-${fusionId}`}
                  className="hud-synergy-badge is-fusion"
                  title={`EVOLVED FUSION · ${fusion.name}: ${fusion.description}`}
                >
                  <GameIcon name={fusionId} className="hud-synergy-icon" />
                  <span className="hud-synergy-rank">★</span>
                </div>
              );
            })}
            {Object.entries(hud.activeSynergies ?? {}).map(([id, stack]) => {
              const card = SYNERGY_CARDS[id as SynergyCardId];
              if (!card || stack <= 0) return null;
              return (
                <div
                  key={id}
                  className={`hud-synergy-badge rarity-${card.rarity}`}
                  title={`${card.name} (Rank ${stack}/${card.maxStacks}): ${card.description}`}
                >
                  <GameIcon name={id} className="hud-synergy-icon" />
                  <span className="hud-synergy-rank">x{stack}</span>
                </div>
              );
            })}
          </div>
        )}

        {/* Isometric Angled Radar Mini-Map */}
        <div className="isometric-minimap radar" aria-hidden="true">
          <div className="minimap-grid-lines" />
          {/* Player Arrow */}
          <div
            className="minimap-player-blip"
            style={{
              transform: `translate(-50%, -50%) rotate(${((hud.playerPos?.rotation ?? 0) * 180) / Math.PI + 90}deg)`,
            }}
          />
          {/* Hostile Blips */}
          {hud.minimapEnemies?.slice(0, 20).map((enemy, idx) => {
            const playerX = hud.playerPos?.x ?? 0;
            const playerZ = hud.playerPos?.z ?? 0;
            const relX = ((enemy.x - playerX) / 38) * 100;
            const relZ = ((enemy.z - playerZ) / 38) * 100;
            const clampedX = Math.max(-42, Math.min(42, relX));
            const clampedZ = Math.max(-42, Math.min(42, relZ));

            return (
              <div
                key={idx}
                className={`minimap-enemy-blip enemy-${enemy.type}`}
                style={{
                  left: `calc(50% + ${clampedX}%)`,
                  top: `calc(50% + ${clampedZ}%)`,
                }}
              />
            );
          })}
        </div>
      </div>

      {/* 2. TOP-RIGHT: Salvage Score, Wave Counter & Timer */}
      <div className="comic-hud-top-right">
        <div className="hud-score-display">
          <span>SALVAGE</span>
          <strong>{coins.toLocaleString()}</strong>
        </div>
        <div
          className={`hud-wave-status ${hud.endless ? "is-endless" : ""}`}
          data-testid="hud-wave"
        >
          <em className="wave-mode">{hud.endless ? "Endless" : "Campaign"}</em>
          <span>
            WAVE {String(hud.wave).padStart(2, "0")}
            {hud.endless ? "" : " / 10"}
          </span>
          <small>{formattedTime}</small>
        </div>
        <div className="hud-hostiles" aria-label={`${hud.enemies} hostiles remaining`}>
          <span>HOSTILES</span><strong>{hud.enemies}</strong>
        </div>
        {hud.modifier && (
          <div className="hud-modifier" title={`Wave modifier: ${hud.modifier.name}`}>
            <GameIcon name="shield" />
            {hud.modifier.name}
          </div>
        )}
        <div className="hud-redeploys" title="Redeploys remaining">
          {Array.from({ length: MAX_REDEPLOYS }, (_, index) => (
            <i key={index} className={index < redeploys ? "available" : "spent"} />
          ))}
        </div>
      </div>

      {/* 4. BOTTOM-RIGHT: Overdrive Surge, Dash Ability & Active Weapon Card */}
      <div className="comic-hud-bottom-right">
        {/* Overdrive Surge Meter */}
        <div
          className={`ability-cooldown-box overdrive-box ${
            hud.overdriveActive
              ? "is-active"
              : (hud.overdriveCharge ?? 0) >= OVERDRIVE_MAX_CHARGE
                ? "is-ready"
                : "cooling"
          }`}
          title="Overdrive Surge (F or Right-Click when at 100%): Infinite mag, 100% crit, +45% fire rate"
        >
          <div className="ability-icon">
            <GameIcon name="overdrive" />
          </div>
          <span className="ability-label">
            {hud.overdriveActive
              ? "SURGE!"
              : (hud.overdriveCharge ?? 0) >= OVERDRIVE_MAX_CHARGE
                ? "F · SURGE"
                : `${hud.overdriveCharge ?? 0}%`}
          </span>
          <span className="dash-progress overdrive-progress">
            <i
              style={{
                width: `${
                  hud.overdriveActive
                    ? (hud.overdriveProgress ?? 0) * 100
                    : Math.min(100, ((hud.overdriveCharge ?? 0) / OVERDRIVE_MAX_CHARGE) * 100)
                }%`,
              }}
            />
          </span>
        </div>

        {/* Cyber-Blade Slash / Teleport Execute Box */}
        <div
          className={`ability-cooldown-box blade-box ${
            hud.executeTargetReady ? "is-execute" : (hud.blade ?? 1) >= 1 ? "ready" : "cooling"
          }`}
          title="Cyber-Blade (Right-Click or V): Cleaves packs, deflects projectiles, and Teleport-Executes wounded targets for instant reload + HP + reset!"
        >
          <div className="ability-icon">
            <GameIcon name="blade" />
          </div>
          <span className="ability-label">
            {hud.executeTargetReady ? "EXEC!" : (hud.blade ?? 1) >= 1 ? "RMB · CUT" : "BLADE"}
          </span>
          <span className="dash-progress blade-progress"><i style={{ width: `${(hud.blade ?? 1) * 100}%` }} /></span>
        </div>

        {/* Frag Grenade Cooldown Box */}
        <div
          className={`ability-cooldown-box frag-box ${(hud.grenade ?? 1) >= 1 ? "ready" : "cooling"}`}
          title="Tactical Frag Grenade (G or Middle-Click): 165 AoE blast, chain-detonates barrels. Kills reduce cooldown."
        >
          <div className="ability-icon">
            <GameIcon name="grenade" />
          </div>
          <span className="ability-label">{(hud.grenade ?? 1) >= 1 ? "G · FRAG" : "FRAG"}</span>
          <span className="dash-progress frag-progress"><i style={{ width: `${(hud.grenade ?? 1) * 100}%` }} /></span>
        </div>

        {/* Dash / Ability Cooldown Box */}
        <div className={`ability-cooldown-box ${hud.dash >= 1 ? "ready" : "cooling"}`}>
          <div className="ability-icon">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
            </svg>
          </div>
          <span className="ability-label">{hud.dash >= 1 ? "DASH READY" : "DASH"}</span>
          <span className="dash-progress"><i style={{ width: `${hud.dash * 100}%` }} /></span>
        </div>

        {/* Weapon Silhouette & Ammo Count (or Active Orbital Super-Weapon Override!) */}
        <div
          className={`comic-weapon-card weapon-hud ${isReloading ? "reloading" : ""} ${
            (hud.overchargedRounds ?? 0) > 0 ? "is-overcharged" : ""
          } ${hud.overdriveActive ? "is-overdrive" : ""} ${hud.superWeapon ? "is-superweapon" : ""}`}
        >
          <div className="weapon-silhouette-container">
            <WeaponGlyph id={hud.weapon} />
          </div>
          <div className="ammo-numbers">
            <strong>{hud.overdriveActive ? "∞" : hud.superWeapon ? hud.superWeapon.ammo : hud.magazine}</strong>
            <small>/{hud.superWeapon ? hud.superWeapon.maxAmmo : hud.reserve}</small>
          </div>
          {hud.superWeapon && <span className="overcharge-badge superweapon-badge">ORBITAL</span>}
          {!hud.superWeapon && (hud.overchargedRounds ?? 0) > 0 && !hud.overdriveActive && (
            <span className="overcharge-badge">OVR</span>
          )}
          {loadoutCount > 1 && !hud.superWeapon && (
            <span className="weapon-swap-key-tag">Q</span>
          )}
          {!hud.superWeapon && <span className="weapon-rank-tag-mini">{weaponRank}</span>}
          <span className="active-weapon-name">
            {hud.superWeapon
              ? hud.superWeapon.name
              : isReloading
                ? hud.activeReloadAvailable
                  ? `Tap R · ${hud.reloading.toFixed(1)}s`
                  : `Reloading · ${hud.reloading.toFixed(1)}s`
                : hud.weaponName}
          </span>
          {isReloading && (
            <div className="reload-progress" role="progressbar" aria-label="Reload progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((hud.reloadProgress ?? 0) * 100)}>
              {hud.activeReloadAvailable && (
                <span
                  className="reload-sweet-spot"
                  style={{
                    left: `${ACTIVE_RELOAD_WINDOW_START * 100}%`,
                    width: `${(ACTIVE_RELOAD_WINDOW_END - ACTIVE_RELOAD_WINDOW_START) * 100}%`,
                  }}
                />
              )}
              <i style={{ width: `${(hud.reloadProgress ?? 0) * 100}%` }} />
            </div>
          )}
        </div>
      </div>

      {/* Combo Streak Tracker */}
      {hud.comboCount !== undefined && hud.comboCount >= 2 && (
        <div className="combo-hud-badge">
          <div className="combo-top-row">
            <span className="combo-number">{hud.comboCount}x</span>
            {(hud.comboMultiplier ?? 1) > 1 && (
              <span className="combo-mult-tag">{hud.comboMultiplier?.toFixed(2).replace(/\.00$/, "")}x SALVAGE</span>
            )}
          </div>
          <span className="combo-label">COMBO STREAK</span>
          <span className="combo-decay-bar">
            <i style={{ width: `${Math.min(100, ((hud.comboTimer ?? 0) / 2.8) * 100)}%` }} />
          </span>
        </div>
      )}

      {/* Wave Announcement Banner */}
      {hud.announcement && (
        <div
          className={`wave-announcement ${hud.extractionZoneActive ? "extraction-announcement" : ""}`}
          role="status"
          aria-live="polite"
        >
          {hud.announcement}
        </div>
      )}

      {/* Extraction / Inter-Wave Beacon Hold Banner */}
      {hud.extractionZoneActive && (
        <div className={`extraction-hud-card ${hud.extractionProgress && hud.extractionProgress > 0 ? "is-charging" : ""}`}>
          <div className="extraction-hud-header">
            <GameIcon name="beacon" className="beacon-icon" />
            <div>
              <strong className="extraction-desktop-title">EXTRACTION BEACON ACTIVE</strong>
              <strong className="extraction-mobile-status">
                {hud.extractionProgress && hud.extractionProgress > 0
                  ? `HOLD ${Math.round(hud.extractionProgress * 100)}%`
                  : "REACH CENTER"}
              </strong>
              <p>Stand in the central perimeter beacon to advance to the next round</p>
            </div>
          </div>
          <div className="extraction-progress-track">
            <div className="extraction-progress-fill" style={{ width: `${(hud.extractionProgress ?? 0) * 100}%` }} />
          </div>
        </div>
      )}

      {/* Multi-Phase Boss Health Bar for Wave 5 & Wave 10 */}
      {hud.bossHealth !== undefined && hud.bossMaxHealth !== undefined && hud.bossHealth > 0 && (
        <div className={`boss-hud phase-${hud.bossPhase ?? 1} ${hud.bossPhase === 3 ? "is-enraged" : ""}`}>
          <div className="boss-title">
            <div className="boss-nameplate">
              <span> {hud.bossName ?? "TITAN-01 // JUGGERNAUT"}</span>
              <span className={`boss-phase-badge ${hud.bossPhase === 3 ? "berserk" : ""}`}>
                {hud.bossMaxPhases === 2
                  ? hud.bossPhase === 2
                    ? " PHASE 2: ENRAGED SLAM"
                    : " PHASE 1: ARMORED"
                  : hud.bossPhase === 3
                    ? " PHASE 3: BERSERK"
                    : hud.bossPhase === 2
                      ? " PHASE 2: SHOCKWAVE"
                      : " PHASE 1: ARMORED"}
              </span>
            </div>
            <strong>{Math.ceil(hud.bossHealth)} / {hud.bossMaxHealth}</strong>
          </div>
          <div className="boss-track">
            {hud.bossMaxPhases === 2 ? (
              <div className="boss-phase-divider divider-mid" style={{ left: "50%" }} />
            ) : (
              <>
                <div className="boss-phase-divider divider-1" style={{ left: "33.3%" }} />
                <div className="boss-phase-divider divider-2" style={{ left: "66.6%" }} />
              </>
            )}
            <i style={{ width: `${Math.max(0, (hud.bossHealth / hud.bossMaxHealth) * 100)}%` }} />
          </div>
        </div>
      )}

      <div className="crosshair" aria-hidden="true"><span /><span /></div>
    </div>
  );
}

function DraftModal({
  cards,
  activeSynergies,
  onSelect,
}: {
  cards: SynergyCardDefinition[];
  activeSynergies: Partial<Record<SynergyCardId, number>>;
  onSelect: (id: SynergyCardId) => void;
}) {
  return (
    <div className="draft-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="draft-heading">
      <div className="draft-modal-panel">
        <header className="draft-modal-header">
          <div className="draft-eyebrow">WAVE SURVIVED // COMBAT REQUISITION</div>
          <h2 id="draft-heading">CHOOSE A BATTLEFIELD SYNERGY</h2>
          <p>Select 1 tactical module to augment your weaponry and survivability for this run.</p>
        </header>

        <div className="draft-cards-row">
          {cards.map((card) => {
            const currentStack = activeSynergies[card.id] ?? 0;
            const nextStack = currentStack + 1;
            const fusion = getFusionCompletedByCard(activeSynergies, card.id);
            return (
              <button
                key={card.id}
                type="button"
                className={`draft-perk-card rarity-${card.rarity} ${fusion ? "has-fusion" : ""}`}
                onClick={() => onSelect(card.id)}
              >
                <div className="card-top-bar">
                  <span className={`card-rarity-badge rarity-${card.rarity}`}>{card.rarity.toUpperCase()}</span>
                  <span className="card-stack-badge">
                    RANK {nextStack}/{card.maxStacks}
                  </span>
                </div>
                <div className="card-icon-frame">
                  <GameIcon name={card.id} />
                </div>
                <h3 className="card-title">{card.name}</h3>
                <p className="card-description">{card.description}</p>
                {fusion && (
                  <p className="card-fusion-callout">
                    <span>★ FUSION READY</span>
                    <strong>{fusion.name}</strong>
                  </p>
                )}
                <p className="card-rank-comparison">MODULE RANK <strong>{currentStack} → {nextStack}</strong></p>
                <div className="card-select-cta">
                  <span>{fusion ? `FUSE ${fusion.name.toUpperCase()} →` : "EQUIP MODULE →"}</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function MobileControls({
  onMove,
  onFire,
  onAction,
  reloading,
  activeReloadAvailable,
  grenadeReady,
  bladeReady,
  executeReady,
  turretReady,
  pylonReady,
  overdriveReady,
  overdriveActive,
  onPause,
}: {
  onMove: (x: number, z: number) => void;
  onFire: (active: boolean) => void;
  onAction: (action: "dash" | "reload" | "swap" | "overdrive" | "grenade" | "blade" | "turret" | "pylon") => void;
  reloading: boolean;
  activeReloadAvailable: boolean;
  grenadeReady: boolean;
  bladeReady: boolean;
  executeReady: boolean;
  turretReady: boolean;
  pylonReady: boolean;
  overdriveReady: boolean;
  overdriveActive: boolean;
  onPause: () => void;
}) {
  const controlsRef = useRef<HTMLDivElement>(null);
  const joystickRef = useRef<HTMLDivElement>(null);
  const knobRef = useRef<HTMLSpanElement>(null);
  const fireButtonRef = useRef<HTMLButtonElement>(null);
  const moveContactRef = useRef<{ kind: "pointer" | "touch"; id: number } | null>(null);
  const joystickCenterRef = useRef<{ x: number; y: number; radius: number } | null>(null);
  const firePointerRef = useRef<number | null>(null);
  const fireTouchRef = useRef<number | null>(null);
  const onMoveRef = useRef(onMove);
  const onFireRef = useRef(onFire);
  useEffect(() => {
    onMoveRef.current = onMove;
    onFireRef.current = onFire;
  }, [onFire, onMove]);

  const resetJoystick = useCallback((kind?: "pointer" | "touch", id?: number) => {
    const active = moveContactRef.current;
    if (kind !== undefined && (!active || active.kind !== kind || active.id !== id)) return;
    moveContactRef.current = null;
    joystickCenterRef.current = null;
    if (knobRef.current) knobRef.current.style.transform = "translate3d(0, 0, 0)";
    onMoveRef.current(0, 0);
  }, []);

  const stopFiring = useCallback(() => {
    firePointerRef.current = null;
    fireTouchRef.current = null;
    fireButtonRef.current?.classList.remove("is-held");
    onFireRef.current(false);
  }, []);

  const resetFirePointer = useCallback((pointerId?: number) => {
    if (pointerId !== undefined && firePointerRef.current !== pointerId) return;
    if (firePointerRef.current === null) return;
    firePointerRef.current = null;
    if (fireTouchRef.current === null) stopFiring();
  }, [stopFiring]);

  const resetFireTouch = useCallback((touchId?: number) => {
    if (touchId !== undefined && fireTouchRef.current !== touchId) return;
    if (fireTouchRef.current === null) return;
    fireTouchRef.current = null;
    if (firePointerRef.current === null) stopFiring();
  }, [stopFiring]);

  const beginFiring = useCallback(() => {
    if (firePointerRef.current !== null || fireTouchRef.current !== null) return false;
    fireButtonRef.current?.classList.add("is-held");
    triggerHaptic(10);
    onFireRef.current(true);
    return true;
  }, []);

  const updateJoystickPosition = useCallback((kind: "pointer" | "touch", id: number, clientX: number, clientY: number) => {
    const active = moveContactRef.current;
    if (!active || active.kind !== kind || active.id !== id || !joystickRef.current) return;
    let center = joystickCenterRef.current;
    if (!center) {
      const rect = joystickRef.current.getBoundingClientRect();
      center = {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        radius: Math.max(1, Math.min(rect.width, rect.height) * 0.34),
      };
      joystickCenterRef.current = center;
    }
    const vector = normalizeJoystick(
      clientX - center.x,
      clientY - center.y,
      center.radius,
    );
    if (knobRef.current) {
      knobRef.current.style.transform = `translate3d(${vector.knobX}px, ${vector.knobY}px, 0)`;
    }
    onMoveRef.current(vector.x, vector.z);
  }, []);

  // React's touchstart listener is passive. Claim gestures natively for the
  // whole control pad so sticks and buttons cannot trigger scroll/ghost clicks.
  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    const claimGesture = (event: globalThis.TouchEvent) => {
      if (event.cancelable) event.preventDefault();
    };
    controls.addEventListener("touchstart", claimGesture, { passive: false });
    return () => controls.removeEventListener("touchstart", claimGesture);
  }, []);

  useEffect(() => {
    const handlePointerMove = (event: globalThis.PointerEvent) => {
      updateJoystickPosition("pointer", event.pointerId, event.clientX, event.clientY);
    };
    const handlePointerEnd = (event: globalThis.PointerEvent) => {
      resetJoystick("pointer", event.pointerId);
      resetFirePointer(event.pointerId);
    };
    const handleTouchMove = (event: globalThis.TouchEvent) => {
      const active = moveContactRef.current;
      if (!active || active.kind !== "touch") return;
      const touch = Array.from(event.touches).find((candidate) => candidate.identifier === active.id);
      if (touch) updateJoystickPosition("touch", touch.identifier, touch.clientX, touch.clientY);
    };
    const handleTouchEnd = (event: globalThis.TouchEvent) => {
      for (const touch of Array.from(event.changedTouches)) {
        resetJoystick("touch", touch.identifier);
        resetFireTouch(touch.identifier);
      }
    };
    const handleBlur = () => {
      resetJoystick();
      stopFiring();
    };
    const handleVisibilityChange = () => {
      if (document.hidden) {
        resetJoystick();
        stopFiring();
      }
    };

    // Phones use their native Touch Events stream because iOS can cancel a
    // synthesized pointer while the physical contact is still active. Pointer
    // Events remain available for mouse and pen input.
    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    window.addEventListener("pointerup", handlePointerEnd, { passive: true });
    window.addEventListener("pointercancel", handlePointerEnd, { passive: true });
    window.addEventListener("touchmove", handleTouchMove, { passive: true });
    window.addEventListener("touchend", handleTouchEnd, { passive: true });
    window.addEventListener("touchcancel", handleTouchEnd, { passive: true });
    window.addEventListener("blur", handleBlur);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
      window.removeEventListener("touchmove", handleTouchMove);
      window.removeEventListener("touchend", handleTouchEnd);
      window.removeEventListener("touchcancel", handleTouchEnd);
      window.removeEventListener("blur", handleBlur);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      resetJoystick();
      stopFiring();
    };
  }, [resetFirePointer, resetFireTouch, resetJoystick, stopFiring, updateJoystickPosition]);

  const triggerAction = (
    event: React.SyntheticEvent,
    action: "dash" | "reload" | "swap" | "overdrive" | "grenade" | "blade" | "turret" | "pylon",
  ) => {
    if (event.type !== "touchstart") event.preventDefault();
    event.stopPropagation();
    triggerHaptic(action === "overdrive" ? [20, 20, 35] : action === "blade" ? 24 : action === "grenade" ? 22 : action === "dash" ? 18 : action === "reload" ? [10, 30, 10] : 12);
    onAction(action);
  };

  return (
    <div ref={controlsRef} className="mobile-combat-controls" aria-label="Touch combat controls" data-testid="mobile-controls">
      <div
        ref={joystickRef}
        className="mobile-joystick"
        role="group"
        aria-label="Analog movement joystick"
        data-testid="mobile-joystick"
        onTouchStart={(event) => {
          event.stopPropagation();
          if (moveContactRef.current !== null) return;
          const touch = event.changedTouches[0];
          if (!touch) return;
          if (joystickRef.current) {
            const rect = joystickRef.current.getBoundingClientRect();
            joystickCenterRef.current = {
              x: rect.left + rect.width / 2,
              y: rect.top + rect.height / 2,
              radius: Math.max(1, Math.min(rect.width, rect.height) * 0.34),
            };
          }
          moveContactRef.current = { kind: "touch", id: touch.identifier };
          updateJoystickPosition("touch", touch.identifier, touch.clientX, touch.clientY);
        }}
        onPointerDown={(event) => {
          if (event.pointerType === "touch") return;
          event.preventDefault();
          event.stopPropagation();
          if (moveContactRef.current !== null) return;
          if (joystickRef.current) {
            const rect = joystickRef.current.getBoundingClientRect();
            joystickCenterRef.current = {
              x: rect.left + rect.width / 2,
              y: rect.top + rect.height / 2,
              radius: Math.max(1, Math.min(rect.width, rect.height) * 0.34),
            };
          }
          moveContactRef.current = { kind: "pointer", id: event.pointerId };
          updateJoystickPosition("pointer", event.pointerId, event.clientX, event.clientY);
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {
            // Window-level tracking below does not depend on capture support.
          }
        }}
        onLostPointerCapture={(event) => {
          // A genuine end/cancel has no pressed buttons and must reset. If the
          // browser merely dropped capture mid-contact, global tracking keeps
          // movement alive until the corresponding pointerup/pointercancel.
          if (event.pointerType !== "touch" && event.buttons === 0) {
            resetJoystick("pointer", event.pointerId);
          }
        }}
      >
        <span ref={knobRef} className="joystick-knob" aria-hidden="true"><i /></span>
      </div>
      <div className="mobile-action-pad">
        <button
          type="button"
          className="touch-action touch-pause"
          aria-label="Pause operation"
          onTouchStart={(event) => {
            event.stopPropagation();
            onPause();
          }}
          onPointerDown={(event) => {
            if (event.pointerType === "touch") return;
            event.preventDefault();
            onPause();
          }}
        >
          Ⅱ
        </button>
        <button
          type="button"
          className={`touch-action touch-reload ${activeReloadAvailable ? "is-active-reload" : ""}`}
          onTouchStart={(event) => triggerAction(event, "reload")}
          onPointerDown={(event) => {
            if (event.pointerType === "touch") return;
            triggerAction(event, "reload");
          }}
        >
          {activeReloadAvailable ? "OVR!" : "RLD"}
        </button>
        <button
          type="button"
          className={`touch-action touch-blade ${executeReady ? "is-execute" : bladeReady ? "is-ready" : ""}`}
          aria-label="Cyber-Blade slash or execute"
          onTouchStart={(event) => triggerAction(event, "blade")}
          onPointerDown={(event) => {
            if (event.pointerType === "touch") return;
            triggerAction(event, "blade");
          }}
        >
          {executeReady ? "EXEC" : "CUT"}
        </button>
        <button
          type="button"
          className={`touch-action touch-turret ${turretReady ? "is-ready" : ""}`}
          aria-label="Deploy auto turret"
          onTouchStart={(event) => triggerAction(event, "turret")}
          onPointerDown={(event) => {
            if (event.pointerType === "touch") return;
            triggerAction(event, "turret");
          }}
        >
          TUR
        </button>
        <button
          type="button"
          className={`touch-action touch-pylon ${pylonReady ? "is-ready" : ""}`}
          aria-label="Deploy tesla laser pylon"
          onTouchStart={(event) => triggerAction(event, "pylon")}
          onPointerDown={(event) => {
            if (event.pointerType === "touch") return;
            triggerAction(event, "pylon");
          }}
        >
          FNC
        </button>
        <button
          type="button"
          className={`touch-action touch-frag ${grenadeReady ? "is-ready" : ""}`}
          aria-label="Throw frag grenade"
          onTouchStart={(event) => triggerAction(event, "grenade")}
          onPointerDown={(event) => {
            if (event.pointerType === "touch") return;
            triggerAction(event, "grenade");
          }}
        >
          FRAG
        </button>
        {(overdriveReady || overdriveActive) && (
          <button
            type="button"
            className={`touch-action touch-overdrive ${overdriveActive ? "is-active" : "is-ready"}`}
            aria-label="Activate Overdrive Surge"
            onTouchStart={(event) => triggerAction(event, "overdrive")}
            onPointerDown={(event) => {
              if (event.pointerType === "touch") return;
              triggerAction(event, "overdrive");
            }}
          >
            SURGE
          </button>
        )}
        <button
          type="button"
          className="touch-action touch-swap"
          onTouchStart={(event) => triggerAction(event, "swap")}
          onPointerDown={(event) => {
            if (event.pointerType === "touch") return;
            triggerAction(event, "swap");
          }}
        >
          SWAP
        </button>
        <button
          type="button"
          className="touch-action touch-dash"
          onTouchStart={(event) => triggerAction(event, "dash")}
          onPointerDown={(event) => {
            if (event.pointerType === "touch") return;
            triggerAction(event, "dash");
          }}
        >
          DASH
        </button>
        <button
          ref={fireButtonRef}
          type="button"
          className="touch-fire"
          aria-label="Fire weapon with automatic aim"
          onTouchStart={(event) => {
            event.stopPropagation();
            const touch = event.changedTouches[0];
            if (!touch || !beginFiring()) return;
            fireTouchRef.current = touch.identifier;
          }}
          onPointerDown={(event) => {
            // Touch contacts use the older, more stable Touch Events stream on
            // phones. Pointer Events remain as the mouse/pen fallback.
            if (event.pointerType === "touch") return;
            event.preventDefault();
            event.stopPropagation();
            if (!beginFiring()) return;
            firePointerRef.current = event.pointerId;
            try {
              event.currentTarget.setPointerCapture(event.pointerId);
            } catch {
              // Global pointer tracking does not depend on capture support.
            }
          }}
          onLostPointerCapture={(event) => {
            if (event.pointerType !== "touch" && event.buttons === 0) {
              resetFirePointer(event.pointerId);
            }
          }}
        >
          {reloading ? "RELOAD" : "FIRE"}
        </button>
      </div>
    </div>
  );
}

/**
 * The shop. Between waves it sits over the paused run and can refill ammo;
 * from the lobby it is the same stock without a run behind it, so salvage
 * banked at the end of one run can be spent before the next instead of
 * having to survive wave one first.
 */
function Armory({
  mode,
  profile,
  wave = 1,
  notice,
  onBuyWeapon,
  onUpgradeWeapon,
  onUpgradePerk,
  onRefill,
  onContinue,
}: {
  mode: "wave" | "lobby";
  profile: ProfileV1;
  wave?: number;
  notice: string;
  onBuyWeapon: (id: WeaponId) => void;
  onUpgradeWeapon: (id: WeaponId) => void;
  onUpgradePerk: (id: PerkId) => void;
  onRefill?: () => void;
  onContinue: () => void;
}) {
  const inRun = mode === "wave";
  return (
    <Modal
      eyebrow={inRun ? `WAVE ${wave} SURVIVED` : "COMMAND REQUISITIONS"}
      title={inRun ? "FIELD ARMORY & REQUISITIONS" : "FIELD ARMORY"}
      wide
    >
      <div className="armory-balance">
        <div>
          <span>AVAILABLE SALVAGE</span>
          <strong>◆ {profile.coins}</strong>
        </div>
        {inRun && onRefill && (
          <button className="refill-action" aria-label="Refill all ammo 20" onClick={onRefill}>
             Refill All Ammo (20 Salvage)
          </button>
        )}
      </div>

      {notice && <div className="armory-notice" role="status" aria-live="polite">{notice}</div>}

      <div className="armory-layout">
        {/* Weapon Upgrades Column */}
        <section>
          <h3 className="section-title">WEAPON ARSENAL</h3>
          <div className="armory-list">
            {WEAPON_IDS.map((id) => {
              const weapon = WEAPONS[id];
              const owned = profile.ownedWeapons.includes(id);
              const rank = profile.weaponRanks[id] ?? 1;
              const stats = getWeaponStats(id, rank);
              const nextStats = getWeaponStats(id, Math.min(5, rank + 1));
              const cost = owned ? getWeaponUpgradeCost(id, rank) : weapon.cost;

              return (
                <article className={`armory-item ${owned ? "owned" : ""}`} key={id}>
                  <div className="armory-item-icon">
                    <WeaponGlyph id={id} compact />
                    <div className="stars-indicator" aria-label={`Rank ${rank} of 5`}>
                      {Array.from({ length: 5 }, (_, idx) => (
                        <span key={idx} className={`rank-pip ${idx < rank ? "filled" : ""}`} />
                      ))}
                    </div>
                  </div>
                  <div className="armory-item-details">
                    <span className="item-rank-tag">{owned ? `Rank ${rank}/5` : "Unowned"}</span>
                    <h4>{weapon.name}</h4>
                    <p>{weapon.description}</p>
                    <div className="armory-stat-bars">
                      <div className="stat-bar-row">
                        <span>Damage {Math.round(stats.damage)} {owned && rank < 5 && <small>→ {Math.round(nextStats.damage)}</small>}</span>
                      </div>
                      <div className="stat-bar-row">
                        <span>Magazine {stats.magazine} {owned && rank < 5 && <small>→ {nextStats.magazine}</small>}</span>
                      </div>
                    </div>
                  </div>
                  <div className="armory-item-action">
                    {owned ? (
                      <button
                        className="upgrade-btn"
                        onClick={() => onUpgradeWeapon(id)}
                        disabled={rank >= 5 || profile.coins < cost}
                      >
                        {rank >= 5 ? "MAX RANK" : <>Upgrade <b>{cost} SALVAGE</b></>}
                      </button>
                    ) : (
                      <button
                        className="buy-btn"
                        aria-label={`Acquire ${cost}`}
                        onClick={() => onBuyWeapon(id)}
                        disabled={profile.coins < cost}
                      >
                        Acquire <b>◆ {cost}</b>
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        {/* Operator Perks Column */}
        <section>
          <h3 className="section-title">OPERATOR PERKS</h3>
          <div className="armory-list">
            {PERK_IDS.map((id) => {
              const perk = PERKS[id];
              const rank = profile.perkRanks[id] ?? 0;
              const cost = getPerkUpgradeCost(id, rank);

              return (
                <article className="armory-item perk-item" key={id}>
                  <div className="perk-glyph"><GameIcon name={id} /></div>
                  <div className="armory-item-details">
                    <span className="item-rank-tag">{rank} / 3 Ranks</span>
                    <h4>{perk.name}</h4>
                    <p>{perk.description}</p>
                  </div>
                  <div className="armory-item-action">
                    <button
                      className="upgrade-btn"
                      onClick={() => onUpgradePerk(id)}
                      disabled={rank >= 3 || profile.coins < cost}
                    >
                      {rank >= 3 ? "MAX RANK" : <>Upgrade <b>{cost} SALVAGE</b></>}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      </div>

      <div className="armory-footer">
        <p>All purchased weapons and perk ranks survive refreshes and failed runs.</p>
        <button className="primary-action" data-testid="armory-continue" onClick={onContinue}>
          {inRun ? <>Begin Wave {wave + 1} <span>→</span></> : <>Back to Command <span>→</span></>}
        </button>
      </div>
    </Modal>
  );
}

/** Kills, accuracy, damage and time for the run that just ended. */
function RunSummary({ stats }: { stats: RunStats | null }) {
  if (!stats) return null;
  const rows: Array<[string, string]> = [
    ["Kills", stats.kills.toLocaleString()],
    ["Elites / Titans", `${stats.eliteKills} / ${stats.bossKills}`],
    ["Accuracy", `${Math.round(getAccuracy(stats) * 100)}%`],
    ["Damage dealt", Math.round(stats.damageDealt).toLocaleString()],
    ["Damage taken", Math.round(stats.damageTaken).toLocaleString()],
    ["Peak combo", `${stats.peakCombo}x`],
    ["Waves cleared", stats.wavesCleared.toLocaleString()],
    ["Mission time", formatMissionTime(stats.missionTime)],
  ];
  return (
    <div className="run-stats" data-testid="run-summary" aria-label="Run summary">
      {rows.map(([label, value]) => (
        <div className="victory-stat" key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}

function Modal({
  eyebrow,
  title,
  wide = false,
  onDismiss,
  children,
}: {
  eyebrow: string;
  title: string;
  wide?: boolean;
  onDismiss?: () => void;
  children: React.ReactNode;
}) {
  const titleId = useId();
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const root = panel.current;
    const focusable = () => Array.from(root?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input, [tabindex="0"]') ?? []).filter(el => el.getClientRects().length > 0);
    (focusable()[0] ?? root)?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && onDismiss) { event.preventDefault(); onDismiss(); }
      if (event.key !== "Tab") return;
      const elements = focusable(); const first = elements[0]; const last = elements.at(-1);
      if (!first) { event.preventDefault(); root?.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === root)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    root?.addEventListener("keydown", onKey);
    return () => { root?.removeEventListener("keydown", onKey); if (previous?.isConnected) previous.focus(); };
  }, [onDismiss]);
  return (
    <div className="modal-backdrop">
      <section ref={panel} tabIndex={-1} className={`modal-panel ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header>
          <p className="eyebrow">{eyebrow}</p>
          <h2 id={titleId}>{title}</h2>
        </header>
        {children}
      </section>
    </div>
  );
}

function SettingToggle({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button className="setting-toggle" onClick={onClick} aria-pressed={active}>
      <span>{label}</span>
      <i className={active ? "active" : ""} aria-hidden="true"><b /></i>
    </button>
  );
}

function ControlModeSelector({
  value,
  onChange,
  compact = false,
}: {
  value: ControlMode;
  onChange: (mode: ControlMode) => void;
  compact?: boolean;
}) {
  const modes: Array<{ value: ControlMode; label: string }> = [
    { value: "auto", label: "Automatic" },
    { value: "touch", label: "Touch" },
    { value: "keyboard", label: "Keyboard & Mouse" },
  ];
  return (
    <div className={`control-mode-setting ${compact ? "compact" : ""}`}>
      <span className="control-mode-label">Control mode</span>
      <div className="control-mode-options" role="group" aria-label="Control mode">
        {modes.map((mode) => (
          <button
            key={mode.value}
            type="button"
            className={value === mode.value ? "active" : ""}
            aria-pressed={value === mode.value}
            onClick={() => onChange(mode.value)}
          >
            {mode.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function GraphicsModeSelector({
  value,
  onChange,
  compact = false,
}: {
  value: GraphicsMode;
  onChange: (mode: GraphicsMode) => void;
  compact?: boolean;
}) {
  const modes: Array<{ value: GraphicsMode; label: string }> = [
    { value: "auto", label: "Automatic" },
    { value: "quality", label: "Quality" },
    { value: "performance", label: "Performance" },
  ];
  return (
    <div className={`control-mode-setting ${compact ? "compact" : ""}`}>
      <span className="control-mode-label">Graphics</span>
      <div className="control-mode-options" role="group" aria-label="Graphics quality">
        {modes.map((mode) => (
          <button
            key={mode.value}
            type="button"
            className={value === mode.value ? "active" : ""}
            aria-pressed={value === mode.value}
            onClick={() => onChange(mode.value)}
          >
            {mode.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function WeaponGlyph({ id, compact = false }: { id: WeaponId; compact?: boolean }) {
  return <img className={`weapon-model-image ${compact ? "compact" : ""}`} src={`/images/${id}.webp`} alt="" loading="eager" />;
}
