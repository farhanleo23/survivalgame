"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
};

export function Deadwave() {
  const [profile, setProfile] = useState<ProfileV1>(() => createDefaultProfile());
  const [screen, setScreen] = useState<GameScreen>("lobby");
  const [hud, setHud] = useState<HudState>(initialHud);
  const [hydrated, setHydrated] = useState(false);
  const [notice, setNotice] = useState("");
  const [runToken, setRunToken] = useState(0);
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
    void import("@/game/GameEngine").then(({ GameEngine }) => {
      if (cancelled || !mount || engineRef.current) return;
      const engine = new GameEngine(mount, profile, {
        onHud: setHud,
        onCoins: (amount) => commitProfile((current) => ({ ...current, coins: current.coins + amount })),
        onWaveChange: (wave) => commitProfile((current) => ({ ...current, highestWave: Math.max(current.highestWave, wave) })),
        onWaveComplete: () => setScreen("armory"),
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
    });
    return () => { cancelled = true; };
  }, [screen, runToken, profile, commitProfile]);

  useEffect(() => () => engineRef.current?.destroy(), []);

  const gameVisible = ["playing", "paused", "armory", "dead", "victory"].includes(screen);
  const healthPercent = Math.max(0, Math.min(100, (hud.health / hud.maxHealth) * 100));

  const startNewRun = () => {
    engineRef.current?.destroy();
    engineRef.current = null;
    setHud(initialHud);
    setNotice("");
    setRunToken((token) => token + 1);
    setScreen("playing");
  };

  const returnToLobby = () => {
    engineRef.current?.destroy();
    engineRef.current = null;
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
    engineRef.current?.unlockAndEquip(id);
  };

  const buyWeaponUpgrade = (id: WeaponId) => {
    const result = upgradeWeapon(profile, id);
    if (!result.ok) {
      setNotice(result.reason === "insufficient" ? "Not enough salvage." : "Weapon is already rank V.");
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
    commitProfile((current) => ({ ...current, coins: current.coins - 20 }));
    engineRef.current?.refillAmmo();
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

  if (!hydrated) return <main className="boot-screen"><span>Establishing tactical link…</span></main>;

  return (
    <main className={`deadwave ${profile.settings.reducedMotion ? "reduced-motion" : ""}`}>
      {!gameVisible && <LobbyBackground />}

      {screen === "lobby" && (
        <Lobby
          profile={profile}
          onStart={() => setScreen("loadout")}
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
        <section className="game-view" data-testid="game-stage">
          <div className="canvas-mount" ref={stageRef} />
          <div className="vignette" aria-hidden="true" />
          <Hud hud={hud} coins={profile.coins} healthPercent={healthPercent} />
          {screen === "playing" && (
            <div className="game-controls">WASD move <i /> Mouse aim <i /> Click fire <i /> R reload <i /> Shift dash <i /> Esc pause</div>
          )}
        </section>
      )}

      {screen === "paused" && (
        <Modal eyebrow="Tactical link suspended" title="Paused" wide={false}>
          <div className="pause-actions">
            <button className="primary-action" onClick={() => { engineRef.current?.resume(); setScreen("playing"); }}>Resume operation <span>→</span></button>
            <SettingToggle label="Music" active={profile.settings.music} onClick={() => toggleSetting("music")} />
            <SettingToggle label="Sound effects" active={profile.settings.sfx} onClick={() => toggleSetting("sfx")} />
            <SettingToggle label="Reduced motion" active={profile.settings.reducedMotion} onClick={() => toggleSetting("reducedMotion")} />
            <button className="text-action danger-action" onClick={returnToLobby}>Abandon run</button>
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
        <Modal eyebrow="Vital signs lost" title="The depot claimed another survivor" wide={false}>
          <p className="modal-copy">Your weapons, upgrades, and <strong>{profile.coins} salvage</strong> are secure. Wave progress has been lost.</p>
          <div className="result-actions">
            <button className="primary-action" onClick={startNewRun}>Return to wave one <span>→</span></button>
            <button className="text-action" onClick={returnToLobby}>Return to command</button>
          </div>
        </Modal>
      )}

      {screen === "victory" && (
        <Modal eyebrow="Extraction window secured" title="Level 01 survived" wide>
          <div className="victory-grid">
            <div>
              <p className="modal-copy">The evacuation depot is clear—for now. All recovered salvage and equipment have been secured.</p>
              <div className="victory-stat"><span>Final wave</span><strong>10 / 10</strong></div>
              <div className="victory-stat"><span>Banked salvage</span><strong>{profile.coins}</strong></div>
            </div>
            <article className="next-level-card">
              <span className="level-index">02</span>
              <div className="lock-icon">⌁</div>
              <p className="eyebrow">Signal acquired</p>
              <h3>Downtown Hospital</h3>
              <p>Emergency generators are online. Something inside is still calling for help.</p>
              <span className="status-tag">Next milestone</span>
            </article>
          </div>
          <button className="primary-action victory-button" onClick={returnToLobby}>Return to command <span>→</span></button>
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

function Lobby({ profile, onStart, onToggleSetting }: {
  profile: ProfileV1;
  onStart: () => void;
  onToggleSetting: (key: "music" | "sfx" | "reducedMotion") => void;
}) {
  return (
    <div className="menu-shell">
      <header className="topbar lobby-topbar">
        <div className="brand-mark">DW</div>
        <div><p className="eyebrow">Evacuation protocol // sector 01</p><h1>Deadwave</h1></div>
        <div className="profile-salvage"><span>Banked salvage</span><strong>◆ {profile.coins}</strong></div>
      </header>
      <section className="lobby-hero">
        <div className="mission-card">
          <p className="eyebrow">Level 01 // Active</p>
          <h2>Survive the dead. Secure the depot.</h2>
          <p className="mission-copy">Ten waves stand between you and extraction. Recover salvage, strengthen your arsenal, and do not let the perimeter fold.</p>
          <div className="mission-stats">
            <div><strong>10</strong><span>Waves</span></div>
            <div><strong>{profile.highestWave}</strong><span>Best wave</span></div>
            <div><strong>{profile.ownedWeapons.length}</strong><span>Weapons</span></div>
          </div>
          <button className="primary-action" data-testid="start-mission" onClick={onStart}>Enter the depot <span>→</span></button>
          <p className="control-hint">WASD move · Mouse aim · Click fire · Shift dash</p>
        </div>
        <div className="mission-visual">
          <div className="radar-lines" />
          <div className="radar-sweep" />
          <div className="player-pip" />
          <div className="enemy-pip enemy-a" />
          <div className="enemy-pip enemy-b" />
          <div className="enemy-pip enemy-c" />
          <div className="mission-visual-label"><span>Live tactical feed</span><strong>Depot 7A</strong></div>
        </div>
      </section>
      <section className="bottom-command-bar">
        <article className="level-card active"><span className="level-index">01</span><div><h3>Evacuation Depot</h3><p>Perimeter breach detected</p></div><span className="status-tag">Ready</span></article>
        <article className={`level-card locked ${profile.completedLevels.includes(1) ? "revealed" : ""}`}><span className="level-index">02</span><div><h3>Downtown Hospital</h3><p>{profile.completedLevels.includes(1) ? "Signal acquired — next milestone" : "Complete Level 01 to reveal"}</p></div><span className="status-tag">Locked</span></article>
        <div className="quick-settings" aria-label="Settings">
          <button className={profile.settings.music ? "active" : ""} onClick={() => onToggleSetting("music")} aria-label="Toggle music">♫</button>
          <button className={profile.settings.sfx ? "active" : ""} onClick={() => onToggleSetting("sfx")} aria-label="Toggle sound effects">SFX</button>
          <button className={profile.settings.reducedMotion ? "active" : ""} onClick={() => onToggleSetting("reducedMotion")} aria-label="Toggle reduced motion">RM</button>
        </div>
      </section>
    </div>
  );
}

function Loadout({ profile, onToggleWeapon, onBack, onDeploy }: {
  profile: ProfileV1;
  onToggleWeapon: (id: WeaponId) => void;
  onBack: () => void;
  onDeploy: () => void;
}) {
  return (
    <div className="menu-shell loadout-shell">
      <header className="screen-heading">
        <button className="back-button" onClick={onBack}>← Command</button>
        <div><p className="eyebrow">Pre-operation check</p><h2>Choose your loadout</h2></div>
        <div className="loadout-count">{profile.equippedLoadout.length} / 2 slots</div>
      </header>
      <section className="loadout-grid">
        {WEAPON_IDS.map((id) => {
          const weapon = WEAPONS[id];
          const owned = profile.ownedWeapons.includes(id);
          const equipped = profile.equippedLoadout.includes(id);
          const stats = getWeaponStats(id, profile.weaponRanks[id]);
          return (
            <button key={id} className={`weapon-card ${equipped ? "equipped" : ""} ${!owned ? "unowned" : ""}`} onClick={() => onToggleWeapon(id)} disabled={!owned}>
              <span className="weapon-rank">Rank {roman(profile.weaponRanks[id])}</span>
              <WeaponGlyph id={id} />
              <div><p className="eyebrow">{owned ? equipped ? "Equipped" : "Owned" : `${weapon.cost} salvage`}</p><h3>{weapon.name}</h3><p>{weapon.description}</p></div>
              <div className="weapon-mini-stats"><span>DMG <b>{Math.round(stats.damage)}</b></span><span>MAG <b>{stats.magazine}</b></span><span>RPM <b>{Math.round(stats.fireRate * 60)}</b></span></div>
            </button>
          );
        })}
      </section>
      <footer className="deploy-bar"><p>Your equipment and upgrades persist even if the operation fails.</p><button className="primary-action" data-testid="deploy" onClick={onDeploy}>Deploy to wave one <span>→</span></button></footer>
    </div>
  );
}

function Hud({ hud, coins, healthPercent }: { hud: HudState; coins: number; healthPercent: number }) {
  return (
    <div className="hud" aria-live="polite">
      <div className="hud-top-left">
        <div className="hud-label"><span>Operator integrity</span><strong>{Math.ceil(hud.health)} / {hud.maxHealth}</strong></div>
        <div className="health-track"><div style={{ width: `${healthPercent}%` }} /></div>
      </div>
      <div className="wave-counter" data-testid="hud-wave"><span>Wave</span><strong>{String(hud.wave).padStart(2, "0")}<i>/10</i></strong><small>{hud.enemies} hostiles</small></div>
      <div className="salvage-counter"><span>◆</span><div><small>Banked salvage</small><strong>{coins}</strong></div></div>
      <div className="weapon-hud">
        <WeaponGlyph id={hud.weapon} compact />
        <div><small>{hud.reloading > 0 ? "Reloading…" : hud.weaponName}</small><strong>{hud.magazine}<i>/ {hud.reserve}</i></strong></div>
      </div>
      <div className="dash-hud"><span>Dash</span><div><i style={{ width: `${hud.dash * 100}%` }} /></div></div>
      {hud.bossHealth !== undefined && hud.bossMaxHealth !== undefined && (
        <div className="boss-hud"><span>Juggernaut</span><div><i style={{ width: `${Math.max(0, hud.bossHealth / hud.bossMaxHealth * 100)}%` }} /></div></div>
      )}
      {hud.announcement && <div className="wave-announcement">{hud.announcement}</div>}
      <div className="crosshair" aria-hidden="true"><span /><span /></div>
    </div>
  );
}

function Armory({ profile, wave, notice, onBuyWeapon, onUpgradeWeapon, onUpgradePerk, onRefill, onContinue }: {
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
    <Modal eyebrow={`Wave ${wave} secured`} title="Field armory" wide>
      <div className="armory-balance"><span>Banked salvage</span><strong>◆ {profile.coins}</strong><button onClick={onRefill}>Refill all ammo <b>20</b></button></div>
      {notice && <div className="armory-notice">{notice}</div>}
      <div className="armory-layout">
        <section><h3 className="section-title">Arsenal</h3><div className="armory-list">
          {WEAPON_IDS.map((id) => {
            const weapon = WEAPONS[id];
            const owned = profile.ownedWeapons.includes(id);
            const rank = profile.weaponRanks[id];
            const cost = owned ? getWeaponUpgradeCost(id, rank) : weapon.cost;
            return (
              <article className="armory-item" key={id}>
                <WeaponGlyph id={id} compact />
                <div><span>Rank {roman(rank)}</span><h4>{weapon.name}</h4><p>{weapon.description}</p></div>
                {owned ? <button onClick={() => onUpgradeWeapon(id)} disabled={rank >= 5}>{rank >= 5 ? "Max rank" : <>Upgrade <b>{cost}</b></>}</button> : <button onClick={() => onBuyWeapon(id)}>Acquire <b>{cost}</b></button>}
              </article>
            );
          })}
        </div></section>
        <section><h3 className="section-title">Operator perks</h3><div className="armory-list">
          {PERK_IDS.map((id) => {
            const perk = PERKS[id];
            const rank = profile.perkRanks[id];
            return (
              <article className="armory-item perk-item" key={id}>
                <div className="perk-glyph">{id === "vitality" ? "+" : id === "mobility" ? "»" : "◎"}</div>
                <div><span>{rank} / 3 ranks</span><h4>{perk.name}</h4><p>{perk.description}</p></div>
                <button onClick={() => onUpgradePerk(id)} disabled={rank >= 3}>{rank >= 3 ? "Max rank" : <>Upgrade <b>{getPerkUpgradeCost(id, rank)}</b></>}</button>
              </article>
            );
          })}
        </div></section>
      </div>
      <div className="armory-footer"><p>Purchases save immediately and persist across future runs.</p><button className="primary-action" onClick={onContinue}>Begin wave {wave + 1} <span>→</span></button></div>
    </Modal>
  );
}

function Modal({ eyebrow, title, wide = false, children }: { eyebrow: string; title: string; wide?: boolean; children: React.ReactNode }) {
  return <div className="modal-backdrop"><section className={`modal-panel ${wide ? "wide" : ""}`}><header><p className="eyebrow">{eyebrow}</p><h2>{title}</h2></header>{children}</section></div>;
}

function SettingToggle({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return <button className="setting-toggle" onClick={onClick}><span>{label}</span><i className={active ? "active" : ""}><b /></i></button>;
}

function WeaponGlyph({ id, compact = false }: { id: WeaponId; compact?: boolean }) {
  return <div className={`weapon-glyph ${id} ${compact ? "compact" : ""}`} aria-hidden="true"><i /><b /><span /></div>;
}

function roman(rank: number) {
  return ["I", "II", "III", "IV", "V"][Math.max(0, Math.min(4, rank - 1))];
}
