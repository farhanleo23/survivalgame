"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { GameEngine as GameEngineType } from "@/game/GameEngine";
import {
  getPerkUpgradeCost,
  getWeaponStats,
  getWeaponUpgradeCost,
  PERKS,
  PERK_IDS,
  WEAPONS,
  WEAPON_IDS,
} from "@/game/config";
import { purchaseWeapon, upgradePerk, upgradeWeapon } from "@/game/economy";
import { createDefaultProfile, loadProfile, saveProfile } from "@/game/profile";
import type { GameScreen, HudState, PerkId, ProfileV1, WeaponId } from "@/game/types";

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
};

type EngineStatus = "idle" | "loading" | "ready" | "error";

export function Deadwave() {
  const [profile, setProfile] = useState<ProfileV1>(() => createDefaultProfile());
  const [screen, setScreen] = useState<GameScreen>("lobby");
  const [hud, setHud] = useState<HudState>(initialHud);
  const [hydrated, setHydrated] = useState(false);
  const [notice, setNotice] = useState("");
  const [runToken, setRunToken] = useState(0);
  const [engineStatus, setEngineStatus] = useState<EngineStatus>("idle");
  const stageRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<GameEngineType | null>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setProfile(loadProfile(window.localStorage));
      setHydrated(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

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
          onWaveChange: (wave) => commitProfile((current) => ({ ...current, highestWave: Math.max(current.highestWave, wave) })),
          onWaveComplete: (completedWave) => {
            if (completedWave < 2) {
              engineRef.current?.startNextWave();
            } else {
              setScreen("armory");
            }
          },
          onDeath: () => setScreen("dead"),
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
        });
        engineRef.current = engine;
        engine.start(1);
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
  }, [screen, runToken, profile, commitProfile]);

  useEffect(() => () => engineRef.current?.destroy(), []);

  const gameVisible = ["playing", "paused", "armory", "dead", "victory"].includes(screen);
  const healthPercent = Math.max(0, Math.min(100, (hud.health / hud.maxHealth) * 100));

  const startNewRun = () => {
    engineRef.current?.destroy();
    engineRef.current = null;
    setHud(initialHud);
    setNotice("");
    setEngineStatus("loading");
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

  const continueWave = () => {
    setNotice("");
    engineRef.current?.startNextWave();
    setScreen("playing");
  };

  const toggleSetting = (key: "music" | "sfx" | "reducedMotion") => {
    commitProfile((current) => ({ ...current, settings: { ...current.settings, [key]: !current.settings[key] } }));
  };

  if (!hydrated) return <main className="boot-screen"><span>ESTABLISHING TACTICAL LINK…</span></main>;

  return (
    <main className={`deadwave ${profile.settings.reducedMotion ? "reduced-motion" : ""}`}>
      {!gameVisible && <LobbyBackground />}

      {screen === "lobby" && (
        <Lobby
          profile={profile}
          onStart={startNewRun}
          onOpenArmory={() => setScreen("loadout")}
          onToggleSetting={toggleSetting}
        />
      )}

      {screen === "loadout" && (
        <Loadout
          profile={profile}
          onToggleWeapon={toggleLoadoutWeapon}
          onBack={() => setScreen("lobby")}
          onDeploy={startNewRun}
        />
      )}

      {gameVisible && (
        <section
          className="game-view"
          data-testid="game-stage"
          onPointerMove={(event) => {
            event.currentTarget.style.setProperty("--aim-x", `${event.clientX}px`);
            event.currentTarget.style.setProperty("--aim-y", `${event.clientY}px`);
          }}
        >
          <div className="canvas-mount" ref={stageRef} />
          <div className="vignette" aria-hidden="true" />
          {engineStatus === "ready" && <div className="combat-reticle" aria-hidden="true"><i /><b /></div>}
          {engineStatus === "ready" && (
            <Hud
              hud={hud}
              coins={profile.coins}
              healthPercent={healthPercent}
              weaponRank={profile.weaponRanks[hud.weapon] ?? 1}
              loadoutCount={Math.max(profile.equippedLoadout.length, profile.ownedWeapons.length)}
            />
          )}
          {screen === "playing" && engineStatus === "ready" && (
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
                <button className="primary-action" onClick={startNewRun}>Retry deployment <span>→</span></button>
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
            <button className="text-action danger-action" onClick={returnToLobby}>Abandon Run</button>
          </div>
        </Modal>
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
        <Modal eyebrow="Vital Signs Lost" title="M.I.A. IN SECTOR 01" wide={false}>
          <p className="modal-copy">The quarantine depot claimed another survivor. Your unlocked weapons, upgrade ranks, and <strong>{profile.coins} salvage</strong> are permanently safe.</p>
          <div className="result-actions">
            <button className="primary-action" onClick={startNewRun}>Deploy Again (Wave 1) <span>→</span></button>
            <button className="text-action" onClick={returnToLobby}>Return to Command</button>
          </div>
        </Modal>
      )}

      {screen === "victory" && (
        <Modal eyebrow="Extraction Successful" title="DEPOT CLEARED — SECTOR SECURED" wide>
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
          <button className="primary-action victory-button" onClick={returnToLobby}>Return to Command <span>→</span></button>
        </Modal>
      )}
    </main>
  );
}

function LobbyBackground() {
  return (
    <div className="lobby-background" aria-hidden="true">
      <div className="noise" />
      <div className="horizon-glow" />
      <div className="warehouse warehouse-one" />
      <div className="warehouse warehouse-two" />
      <div className="fence-line" />
      <div className="searchlight" />
    </div>
  );
}

function Lobby({
  profile,
  onStart,
  onOpenArmory,
  onToggleSetting,
}: {
  profile: ProfileV1;
  onStart: () => void;
  onOpenArmory: () => void;
  onToggleSetting: (key: "music" | "sfx" | "reducedMotion") => void;
}) {
  const showArmoryOption = profile.highestWave >= 2 || profile.ownedWeapons.length > 1;

  return (
    <div className="menu-shell lobby-shell-split">
      <header className="topbar lobby-topbar">
        <div className="brand-mark">DW</div>
        <div>
          <p className="eyebrow">EVACUATION PROTOCOL // SECTOR 01</p>
          <h1>DEADWAVE</h1>
        </div>
        <div className="profile-salvage">
          <span>Banked Salvage</span>
          <strong>◆ {profile.coins}</strong>
        </div>
      </header>

      <div className="lobby-split-grid">
        {/* Left Side: Glimpse of the Game */}
        <section className="glimpse-panel" aria-label="Game Preview">
          <div className="glimpse-header">
            <span className="live-tag">● LIVE DEPOT FEED</span>
            <span className="cam-id">CAM-01 // SECTOR 7A</span>
          </div>

          <div className="glimpse-arena-viewport">
            <div className="arena-grid-lines" />
            <div className="glimpse-radar-sweep" />

            {/* Tactical Arena Elements */}
            <div className="tactical-marker tactical-player">
              <div className="tactical-ring" />
              <span>OPERATOR</span>
            </div>

            <div className="tactical-marker tactical-enemy enemy-runner-1">
              <i />
              <small>RUNNER</small>
            </div>
            <div className="tactical-marker tactical-enemy enemy-shambler-1">
              <i />
              <small>SHAMBLER</small>
            </div>
            <div className="tactical-marker tactical-enemy enemy-spitter-1">
              <i />
              <small>SPITTER</small>
            </div>
            <div className="tactical-marker tactical-hazard vat-left">
              <span>BIO-VAT</span>
            </div>
            <div className="tactical-marker tactical-hazard vat-right">
              <span>BIO-VAT</span>
            </div>
            <div className="tactical-marker tactical-beacon">
              <div className="beacon-pulse" />
              <span>EXTRACTION BEACON</span>
            </div>

            <div className="glimpse-overlay-scanlines" />
          </div>

          <div className="glimpse-footer-intel">
            <div className="intel-item">
              <small>ARENA</small>
              <strong>QUARANTINE DEPOT</strong>
            </div>
            <div className="intel-item">
              <small>THREAT LEVEL</small>
              <strong className="threat-high">10 HOSTILE WAVES</strong>
            </div>
            <div className="intel-item">
              <small>TARGET</small>
              <strong>JUGGERNAUT BOSS</strong>
            </div>
          </div>
        </section>

        {/* Right Side: Start the Game */}
        <section className="launch-panel">
          <div className="launch-content">
            <p className="eyebrow">MISSION READY // SECTOR 01</p>
            <h2>QUARANTINE DEPOT</h2>
            <p className="launch-description">
              Survive 10 escalating waves of infected hostiles in the industrial depot. Defend against Shamblers, Runners, Spitters, Brutes, and the Juggernaut titan.
            </p>

            <div className="launch-stats-row">
              <div className="launch-stat-box">
                <span>BEST WAVE</span>
                <strong>{profile.highestWave}<i>/10</i></strong>
              </div>
              <div className="launch-stat-box">
                <span>ARSENAL</span>
                <strong>{profile.ownedWeapons.length}<i> WEAPONS</i></strong>
              </div>
              <div className="launch-stat-box">
                <span>SALVAGE</span>
                <strong>◆ {profile.coins}</strong>
              </div>
            </div>

            <div className="launch-action-group">
              <button
                className="primary-action start-game-btn"
                data-testid="start-mission"
                onClick={onStart}
              >
                START GAME <span>→</span>
              </button>

              {showArmoryOption && (
                <button
                  className="secondary-action loadout-btn"
                  onClick={onOpenArmory}
                >
                  FIELD ARMORY & GUN SELECTION ({profile.ownedWeapons.length} Owned)
                </button>
              )}
            </div>

            <div className="launch-controls-guide">
              <span className="guide-title">COMBAT CONTROLS</span>
              <div className="guide-keys">
                <span><b>WASD</b> Move</span>
                <span><b>MOUSE</b> Aim</span>
                <span><b>CLICK</b> Fire</span>
                <span><b>SPACE</b> Dash</span>
                <span><b>Q / 1-4</b> Swap Gun</span>
                <span><b>R</b> Reload</span>
              </div>
            </div>

            <div className="quick-settings-bar">
              <span>SETTINGS:</span>
              <button
                className={profile.settings.music ? "active" : ""}
                onClick={() => onToggleSetting("music")}
                aria-pressed={profile.settings.music}
              >
                ♫ Music: {profile.settings.music ? "ON" : "OFF"}
              </button>
              <button
                className={profile.settings.sfx ? "active" : ""}
                onClick={() => onToggleSetting("sfx")}
                aria-pressed={profile.settings.sfx}
              >
                SFX: {profile.settings.sfx ? "ON" : "OFF"}
              </button>
              <button
                className={profile.settings.reducedMotion ? "active" : ""}
                onClick={() => onToggleSetting("reducedMotion")}
                aria-pressed={profile.settings.reducedMotion}
              >
                Motion: {profile.settings.reducedMotion ? "REDUCED" : "FULL"}
              </button>
            </div>
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
          <h2>CONFIGURE LOADOUT</h2>
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
  coins,
  healthPercent,
  weaponRank,
  loadoutCount,
}: {
  hud: HudState;
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
            <span className="heart-icon">❤️</span>
            <strong className="operator-name">KAI: HP {Math.round(healthPercent)}%</strong>
          </div>
          <div className="vital-bar health-bar">
            <div className="vital-fill health-fill-bar" style={{ width: `${healthPercent}%` }} />
          </div>
          <div className="vital-bar energy-bar">
            <span className="energy-icon">⚡</span>
            <div className="vital-fill energy-fill-bar" style={{ width: `${hud.dash * 100}%` }} />
          </div>
        </div>

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
          <strong>{coins.toLocaleString()}</strong>
        </div>
        <div className="hud-wave-status">
          <span>WAVE {hud.wave}/10</span>
          <small>{formattedTime}</small>
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
        <div className={`comic-weapon-card ${isReloading ? "reloading" : ""}`}>
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
      {hud.announcement && <div className="wave-announcement">{hud.announcement}</div>}

      {/* Extraction / Inter-Wave Beacon Hold Banner */}
      {hud.extractionZoneActive && (
        <div className={`extraction-hud-card ${hud.extractionProgress && hud.extractionProgress > 0 ? "is-charging" : ""}`}>
          <div className="extraction-hud-header">
            <span className="beacon-icon">{hud.extractionProgress && hud.extractionProgress > 0 ? "⚡" : "📍"}</span>
            <div>
              <strong>EXTRACTION BEACON ACTIVE</strong>
              <p>Stand in the central perimeter beacon to advance to the next round</p>
            </div>
          </div>
          <div className="extraction-progress-track">
            <div className="extraction-progress-fill" style={{ width: `${(hud.extractionProgress ?? 0) * 100}%` }} />
          </div>
        </div>
      )}

      {/* Boss Health Bar for Wave 10 */}
      {hud.bossHealth !== undefined && hud.bossMaxHealth !== undefined && (
        <div className="boss-hud">
          <div className="boss-title">
            <span>⚠️ JUGGERNAUT DREADNOUGHT</span>
            <strong>{Math.ceil(hud.bossHealth)} / {hud.bossMaxHealth}</strong>
          </div>
          <div className="boss-track">
            <i style={{ width: `${Math.max(0, (hud.bossHealth / hud.bossMaxHealth) * 100)}%` }} />
          </div>
        </div>
      )}

      <div className="crosshair" aria-hidden="true"><span /><span /></div>
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
        <button className="refill-action" onClick={onRefill}>
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
                        {rank >= 5 ? "MAX RANK" : <>Upgrade <b>◆ {cost}</b></>}
                      </button>
                    ) : (
                      <button
                        className="buy-btn"
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
                      {rank >= 3 ? "MAX RANK" : <>Upgrade <b>◆ {cost}</b></>}
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
          Deploy to Wave {wave + 1} <span>→</span>
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
