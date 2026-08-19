"use client";

import { useCallback, useEffect, useId, useRef, useState, type PointerEvent } from "react";
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
import { purchaseWeapon, upgradePerk, upgradeWeapon } from "@/game/economy";
import { normalizeJoystick, resolveInputMode, triggerHaptic } from "@/game/mobile";
import { createDefaultProfile, loadProfile, saveProfile } from "@/game/profile";
import type { ControlMode, GameScreen, GraphicsMode, HudState, InputMode, PerkId, ProfileV1, SynergyCardDefinition, SynergyCardId, WeaponId } from "@/game/types";
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
    const frame = window.requestAnimationFrame(() => {
      setProfile(loadProfile(window.localStorage));
      setHydrated(true);
    });
    return () => window.cancelAnimationFrame(frame);
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
    setProfile((current) => {
      const next = updater(current);
      saveProfile(typeof window === "undefined" ? undefined : window.localStorage, next);
      engineRef.current?.setProfile(next);
      return next;
    });
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
            // Bank the checkpoint so it survives a refresh, not just this session.
            commitProfile((current) => ({
              ...current,
              checkpointWave: Math.max(current.checkpointWave ?? 1, wave),
            }));
            setScreen("dead");
          },
          onVictory: () => {
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
        // rebuilt, so the deck has to be re-applied for a checkpoint retry.
        for (const [id, stacks] of Object.entries(carriedSynergies)) {
          for (let i = 0; i < (stacks ?? 0); i += 1) engine.addSynergy(id as SynergyCardId);
        }
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
  }, [screen, runToken, profile, commitProfile, runStartWave, carriedSynergies, inputMode, capabilities.touchPrimary]);

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
  ) => {
    engineRef.current?.destroy();
    engineRef.current = null;
    setHud(initialHud);
    setNotice("");
    setEngineStatus("loading");
    setRunStartWave(wave);
    setCarriedSynergies(deck);
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
          onOpenArmory={() => setScreen("loadout")}
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

      {gameVisible && (
        <section
          className="game-view"
          data-testid="game-stage"
          data-wave={hud.wave}
          onPointerMove={(event) => {
            event.currentTarget.style.setProperty("--aim-x", `${event.clientX}px`);
            event.currentTarget.style.setProperty("--aim-y", `${event.clientY}px`);
          }}
        >
          <div className="canvas-mount" ref={stageRef} />
          <div className="vignette" aria-hidden="true" />
          {engineStatus === "ready" && inputMode === "keyboard" && <div className="combat-reticle" aria-hidden="true"><i /><b /></div>}
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
              <span><b>MOUSE</b> Aim</span>
              <span><b>L-CLICK</b> Fire</span>
              <span><b>R</b> Reload</span>
              <span><b>SPACE / SHIFT</b> Dash</span>
              <span><b>Q</b> Swap</span>
              <span><b>ESC</b> Pause</span>
            </div>
          )}
          {screen === "playing" && engineStatus === "ready" && inputMode === "touch" && !orientationBlocked && (
            <MobileControls
              onMove={(x, z) => engineRef.current?.setVirtualMove(x, z)}
              onFire={(active) => engineRef.current?.setVirtualFire(active)}
              onAction={(action) => engineRef.current?.triggerVirtualAction(action)}
              reloading={hud.reloading > 0}
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
          <div className="result-actions">
            {redeploys > 0 ? (
              <button
                className="primary-action"
                data-testid="redeploy"
                onClick={() => startNewRun(deathWave, carriedSynergies, redeploys - 1)}
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
  const showArmoryOption = profile.highestWave >= 2 || profile.ownedWeapons.length > 1;
  // A banked checkpoint outlives the browser session, so offer it up front.
  const canResume = profile.checkpointWave > 1;

  return (
    <div className="menu-shell comic-lobby">
      <header className="masthead">
        <div className="masthead-brand">
          <span className="brand-mark">DW</span>
          <h1 className="comic-title">
            <span className="comic-title-ink">DEADWAVE</span>
          </h1>
        </div>
        <div className="masthead-meta">
          <span className="issue-tag">ISSUE #01</span>
          <div className="salvage-chip">
            <small>Banked salvage</small>
            <strong>◆ {profile.coins.toLocaleString()}</strong>
          </div>
        </div>
      </header>

      <div className="hazard-rule" aria-hidden="true" />

      <div className="comic-grid">
        {!handheld && (
          <section className="comic-panel cover-panel" aria-label="Operator">
            <LobbyHero reducedMotion={profile.settings.reducedMotion} />
            <p className="panel-caption caption-top">SECTOR 01 — THE DEPOT HAS GONE QUIET.</p>
            <p className="panel-sfx" aria-hidden="true">KRAAKOOM!</p>
          </section>
        )}

        <section className="comic-panel briefing-panel">
          <p className="panel-caption">MISSION BRIEFING</p>
          <h2 className="briefing-title">QUARANTINE DEPOT</h2>
          <p className="briefing-copy">
            Ten waves of infected between you and extraction. Shamblers, Runners, Spitters, Brutes —
            and something the size of a truck waiting at the end.
          </p>

          <div className="stat-strip">
            <div className="stat-chip">
              <small>Best wave</small>
              <strong>{profile.highestWave}<i>/10</i></strong>
            </div>
            <div className="stat-chip">
              <small>Arsenal</small>
              <strong>{profile.ownedWeapons.length}<i> guns</i></strong>
            </div>
            <div className="stat-chip">
              <small>Salvage</small>
              <strong>{profile.coins.toLocaleString()}</strong>
            </div>
          </div>

          <div className="cta-block">
            <button className="comic-cta" data-testid="start-mission" onClick={onStart}>
              {canResume ? "NEW RUN" : "START GAME"}
              <span aria-hidden="true">▶</span>
            </button>
            {canResume && (
              <button className="comic-resume" data-testid="resume-run" onClick={onResume}>
                Redeploy to wave {profile.checkpointWave}
                <span aria-hidden="true">▶</span>
              </button>
            )}
            {showArmoryOption && (
              <button className="comic-secondary" onClick={onOpenArmory}>
                Field armory · {profile.ownedWeapons.length} owned
              </button>
            )}
          </div>

          <div className="controls-block">
            <span className="block-label">Controls</span>
            {inputMode === "touch" ? (
              <div className="touch-control-summary" data-testid="touch-control-summary">
                <span>◉ Analog movement</span><span>◎ Automatic aim</span><span>● Hold to fire</span>
              </div>
            ) : (
              <div className="keycap-row">
                <span className="keycap">WASD</span><em>move</em>
                <span className="keycap">MOUSE</span><em>aim</em>
                <span className="keycap">CLICK</span><em>fire</em>
                <span className="keycap">SPACE</span><em>dash</em>
                <span className="keycap">R</span><em>reload</em>
                <span className="keycap">Q</span><em>swap</em>
              </div>
            )}
          </div>

          <div className="settings-block">
            <span className="block-label">Settings</span>
            <div className="toggle-row">
              <button
                className={`toggle-chip ${profile.settings.music ? "on" : ""}`}
                onClick={() => onToggleSetting("music")}
                aria-pressed={profile.settings.music}
              >
                ♫ Music
              </button>
              <button
                className={`toggle-chip ${profile.settings.sfx ? "on" : ""}`}
                onClick={() => onToggleSetting("sfx")}
                aria-pressed={profile.settings.sfx}
              >
                ◈ SFX
              </button>
              <button
                className={`toggle-chip ${profile.settings.reducedMotion ? "on" : ""}`}
                onClick={() => onToggleSetting("reducedMotion")}
                aria-pressed={profile.settings.reducedMotion}
              >
                ◐ Reduced motion
              </button>
            </div>
            <ControlModeSelector value={profile.settings.controlMode} onChange={onControlModeChange} compact />
            <GraphicsModeSelector value={profile.settings.graphicsMode} onChange={onGraphicsModeChange} compact />
          </div>
        </section>
      </div>
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
              aria-label={`${equipped ? "Equipped" : owned ? "Owned" : "Locked"} ${weapon.name}`}
              onClick={() => onToggleWeapon(id)}
              disabled={!owned}
            >
              <div className="weapon-card-header">
                <span className="weapon-rank">★ {rank}/5</span>
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

  // Format mission elapsed time mm:ss
  const totalSeconds = Math.floor(hud.missionTime ?? 0);
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  const formattedTime = `${minutes}:${seconds}`;

  return (
    <div className={`comic-hud ${isLowHealth ? "low-health-warning" : ""}`} aria-live="polite">
      {/* 1. TOP-LEFT: KAI HP, Dash Stamina & Angled Isometric Mini-Map */}
      <div className="comic-hud-top-left">
        <div className="operator-vitals-card">
          <div className="operator-title-row">
            <span className="heart-icon" aria-hidden="true">+</span>
            <strong className="operator-name">KAI // HP {Math.round(healthPercent)}%</strong>
          </div>
          <div className="vital-bar health-bar">
            <div className="vital-fill health-fill-bar" style={{ width: `${healthPercent}%` }} />
          </div>
          <div className="vital-bar energy-bar">
            <span className="energy-icon">⚡</span>
            <div className="vital-fill energy-fill-bar" style={{ width: `${hud.dash * 100}%` }} />
          </div>
        </div>

        {/* Active Roguelite Synergies Tray */}
        {hud.activeSynergies && Object.keys(hud.activeSynergies).length > 0 && (
          <div className="hud-synergy-tray" aria-label="Active Battlefield Synergies">
            {Object.entries(hud.activeSynergies).map(([id, stack]) => {
              const card = SYNERGY_CARDS[id as SynergyCardId];
              if (!card || stack <= 0) return null;
              return (
                <div
                  key={id}
                  className={`hud-synergy-badge rarity-${card.rarity}`}
                  title={`${card.name} (Rank ${stack}/${card.maxStacks}): ${card.description}`}
                >
                  <span className="hud-synergy-icon">{card.icon}</span>
                  <span className="hud-synergy-rank">x{stack}</span>
                </div>
              );
            })}
          </div>
        )}

        {/* Isometric Angled Radar Mini-Map */}
        <div className="isometric-minimap" aria-hidden="true">
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
            <span aria-hidden="true">{hud.modifier.icon}</span>
            {hud.modifier.name}
          </div>
        )}
        <div className="hud-redeploys" title="Redeploys remaining">
          {Array.from({ length: MAX_REDEPLOYS }, (_, index) => (
            <i key={index} className={index < redeploys ? "available" : "spent"} />
          ))}
        </div>
      </div>

      {/* 3. BOTTOM-LEFT: Stylized Deadwave Logo Mark */}
      <div className="comic-hud-bottom-left">
        <span className="deadwave-watermark">DEADWAVE</span>
      </div>

      {/* 4. BOTTOM-RIGHT: Active Weapon Card, Ammo & Dash Ability Cooldown Box */}
      <div className="comic-hud-bottom-right">
        {/* Dash / Ability Cooldown Box */}
        <div className={`ability-cooldown-box ${hud.dash >= 1 ? "ready" : "cooling"}`}>
          <div className="ability-icon">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
            </svg>
          </div>
          <span className="ability-label">{hud.dash >= 1 ? "READY" : "COOLDOWN"}</span>
        </div>

        {/* Weapon Silhouette & Ammo Count */}
        <div className={`comic-weapon-card weapon-hud ${isReloading ? "reloading" : ""}`}>
          <div className="weapon-silhouette-container">
            <WeaponGlyph id={hud.weapon} />
          </div>
          <div className="ammo-numbers">
            <strong>{isReloading ? "RELOAD" : hud.magazine}</strong>
            <small>/{hud.reserve}</small>
          </div>
          {loadoutCount > 1 && (
            <span className="weapon-swap-key-tag">Q</span>
          )}
          <span className="weapon-rank-tag-mini">★{weaponRank}</span>
          <span className="active-weapon-name">{hud.weaponName}</span>
        </div>
      </div>

      {/* Combo Streak Tracker */}
      {hud.comboCount !== undefined && hud.comboCount >= 2 && (
        <div className="combo-hud-badge">
          <span className="combo-number">{hud.comboCount}x</span>
          <span className="combo-label">COMBO STREAK</span>
        </div>
      )}

      {/* Wave Announcement Banner */}
      {hud.announcement && (
        <div className={`wave-announcement ${hud.extractionZoneActive ? "extraction-announcement" : ""}`}>
          {hud.announcement}
        </div>
      )}

      {/* Extraction / Inter-Wave Beacon Hold Banner */}
      {hud.extractionZoneActive && (
        <div className={`extraction-hud-card ${hud.extractionProgress && hud.extractionProgress > 0 ? "is-charging" : ""}`}>
          <div className="extraction-hud-header">
            <span className="beacon-icon">{hud.extractionProgress && hud.extractionProgress > 0 ? "⚡" : "📍"}</span>
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
              <span>⚠️ {hud.bossName ?? "TITAN-01 // JUGGERNAUT"}</span>
              <span className={`boss-phase-badge ${hud.bossPhase === 3 ? "berserk" : ""}`}>
                {hud.bossMaxPhases === 2
                  ? hud.bossPhase === 2
                    ? "💥 PHASE 2: ENRAGED SLAM"
                    : "🛡️ PHASE 1: ARMORED"
                  : hud.bossPhase === 3
                    ? "🔥 PHASE 3: BERSERK"
                    : hud.bossPhase === 2
                      ? "⚡ PHASE 2: SHOCKWAVE"
                      : "🛡️ PHASE 1: ARMORED"}
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
            return (
              <button
                key={card.id}
                type="button"
                className={`draft-perk-card rarity-${card.rarity}`}
                onClick={() => onSelect(card.id)}
              >
                <div className="card-top-bar">
                  <span className={`card-rarity-badge rarity-${card.rarity}`}>{card.rarity.toUpperCase()}</span>
                  <span className="card-stack-badge">
                    RANK {nextStack}/{card.maxStacks}
                  </span>
                </div>
                <div className="card-icon-frame">
                  <span className="card-emoji">{card.icon}</span>
                </div>
                <h3 className="card-title">{card.name}</h3>
                <p className="card-description">{card.description}</p>
                <blockquote className="card-flavor">&ldquo;{card.flavorText}&rdquo;</blockquote>
                <div className="card-select-cta">
                  <span>EQUIP MODULE →</span>
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
  onPause,
}: {
  onMove: (x: number, z: number) => void;
  onFire: (active: boolean) => void;
  onAction: (action: "dash" | "reload" | "swap") => void;
  reloading: boolean;
  onPause: () => void;
}) {
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
    action: "dash" | "reload" | "swap",
  ) => {
    event.preventDefault();
    event.stopPropagation();
    triggerHaptic(action === "dash" ? 18 : action === "reload" ? [10, 30, 10] : 12);
    onAction(action);
  };

  return (
    <div className="mobile-combat-controls" aria-label="Touch combat controls" data-testid="mobile-controls">
      <div
        ref={joystickRef}
        className="mobile-joystick"
        role="group"
        aria-label="Analog movement joystick"
        data-testid="mobile-joystick"
        onTouchStart={(event) => {
          event.preventDefault();
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
            event.preventDefault();
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
          className="touch-action touch-reload"
          onTouchStart={(event) => triggerAction(event, "reload")}
          onPointerDown={(event) => {
            if (event.pointerType === "touch") return;
            triggerAction(event, "reload");
          }}
        >
          RLD
        </button>
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
            event.preventDefault();
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

function Armory({
  profile,
  wave,
  notice,
  onBuyWeapon,
  onUpgradeWeapon,
  onUpgradePerk,
  onRefill,
  onContinue,
}: {
  profile: ProfileV1;
  wave: number;
  notice: string;
  onBuyWeapon: (id: WeaponId) => void;
  onUpgradeWeapon: (id: WeaponId) => void;
  onUpgradePerk: (id: PerkId) => void;
  onRefill: () => void;
  onContinue: () => void;
}) {
  return (
    <Modal eyebrow={`WAVE ${wave} SURVIVED`} title="FIELD ARMORY & REQUISITIONS" wide>
      <div className="armory-balance">
        <div>
          <span>AVAILABLE SALVAGE</span>
          <strong>◆ {profile.coins}</strong>
        </div>
        <button className="refill-action" aria-label="Refill all ammo 20" onClick={onRefill}>
          ⚡ Refill All Ammo (20 Salvage)
        </button>
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
                    <div className="stars-indicator">
                      {"★".repeat(rank)}{"☆".repeat(5 - rank)}
                    </div>
                  </div>
                  <div className="armory-item-details">
                    <span className="item-rank-tag">{owned ? `Rank ${rank}/5` : "Unowned"}</span>
                    <h4>{weapon.name}</h4>
                    <p>{weapon.description}</p>
                    <div className="armory-stat-bars">
                      <div className="stat-bar-row">
                        <span>DMG: {Math.round(stats.damage)} {owned && rank < 5 && <small>→ {Math.round(nextStats.damage)}</small>}</span>
                      </div>
                      <div className="stat-bar-row">
                        <span>MAG: {stats.magazine} {owned && rank < 5 && <small>→ {nextStats.magazine}</small>}</span>
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
                  <div className="perk-glyph">{id === "vitality" ? "✚" : id === "mobility" ? "⚡" : "🧲"}</div>
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
        <button className="primary-action" onClick={onContinue}>
          Begin Wave {wave + 1} <span>→</span>
        </button>
      </div>
    </Modal>
  );
}

function Modal({
  eyebrow,
  title,
  wide = false,
  children,
}: {
  eyebrow: string;
  title: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  const titleId = useId();
  return (
    <div className="modal-backdrop">
      <section className={`modal-panel ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
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
  if (id === "rifle") {
    return (
      <svg className={`weapon-svg-silhouette ${compact ? "compact" : ""}`} viewBox="0 0 100 32" fill="currentColor">
        <path d="M4 14h18v-3h12v3h20v-2h22v2h18v4h-6v4h-4v-4h-8v-2H54v8l-6 10h-6l4-10H34v8l-4 6h-6l2-6H16l-4 6H6l4-10H4v-8z" />
      </svg>
    );
  }
  if (id === "shotgun") {
    return (
      <svg className={`weapon-svg-silhouette ${compact ? "compact" : ""}`} viewBox="0 0 100 32" fill="currentColor">
        <path d="M4 16h24v-4h42v4h24v4H70v3h-16v-3H38v6h-8l-4-6H16l-6 8H4v-12z" />
      </svg>
    );
  }
  if (id === "smg") {
    return (
      <svg className={`weapon-svg-silhouette ${compact ? "compact" : ""}`} viewBox="0 0 100 32" fill="currentColor">
        <path d="M12 12h28v-3h18v3h26v6H62v-2H48v12h-8l-2-10H28v8h-6l-2-8h-8v-6z" />
      </svg>
    );
  }
  return (
    <svg className={`weapon-svg-silhouette ${compact ? "compact" : ""}`} viewBox="0 0 100 32" fill="currentColor">
      <path d="M24 10h44v8H54v10h-10l-4-10H24v-8z" />
    </svg>
  );
}
