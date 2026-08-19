import type { PickupId, WeaponId } from "./types";

interface AudioSettings {
  sfx: boolean;
  music: boolean;
}

export class GameAudio {
  private context?: AudioContext;
  private master?: GainNode;
  private musicBus?: GainNode;
  private intensity = 0;
  private pulseBeat = 430;
  private sfxBus?: GainNode;
  private musicFilter?: BiquadFilterNode;
  private noiseBuffer?: AudioBuffer;
  private persistentSources: AudioScheduledSourceNode[] = [];
  private pulseTimer?: number;
  private pulseStep = 0;
  private sfx = true;
  private music = true;
  private gameplayPaused = false;
  private unlockListening = false;

  configure(settings: AudioSettings) {
    this.sfx = settings.sfx;
    this.music = settings.music;
    this.applyLevels();
    if (this.music && this.context?.state === "suspended") void this.context.resume();
  }

  start() {
    if (typeof window === "undefined") return;
    if (this.context?.state === "closed") this.resetNodes();
    if (!this.context) this.createGraph();
    this.gameplayPaused = false;
    this.applyLevels();
    void this.context?.resume().catch(() => undefined);
    this.bindUnlockGesture();
  }

  setPaused(paused: boolean) {
    this.gameplayPaused = paused;
    this.applyLevels();
  }

  /**
   * High-impact multi-layered weapon firing audio synthesis
   */
  playShoot(weapon: WeaponId) {
    if (!this.sfx || !this.context || !this.sfxBus || this.context.state !== "running") return;
    const now = this.context.currentTime;

    if (weapon === "pistol") {
      // Crisp 9mm snap + tight sub bass punch
      this.triggerNoiseTransient(now, 0.04, 1800, 3.0, 0.28);
      this.triggerBassPunch(now, 160, 42, 0.08, 0.35, "sine");
      this.triggerTone(now, 720, 240, 0.045, 0.14, "triangle");
    } else if (weapon === "smg") {
      // Rapid metallic bolt cycle + punchy pop
      this.triggerNoiseTransient(now, 0.03, 2400, 2.5, 0.22);
      this.triggerBassPunch(now, 190, 55, 0.06, 0.28, "triangle");
      this.triggerTone(now, 1100, 480, 0.03, 0.12, "sawtooth");
    } else if (weapon === "shotgun") {
      // Massive explosive cannon blast + deep sub-bass earthquake + mechanical crack
      this.triggerNoiseTransient(now, 0.14, 950, 1.2, 0.55);
      this.triggerBassPunch(now, 130, 28, 0.24, 0.65, "sine");
      this.triggerTone(now, 380, 70, 0.16, 0.3, "sawtooth");
      // Double action pump follow-up
      setTimeout(() => {
        if (this.context && this.context.state === "running") {
          const pumpNow = this.context.currentTime;
          this.triggerNoiseTransient(pumpNow, 0.05, 3200, 4.0, 0.15);
          this.triggerTone(pumpNow + 0.06, 450, 780, 0.04, 0.12, "triangle");
        }
      }, 160);
    } else if (weapon === "rifle") {
      // Heavy kinetic battle rifle crack + descending energy beam resonance
      this.triggerNoiseTransient(now, 0.08, 1400, 2.0, 0.42);
      this.triggerBassPunch(now, 220, 38, 0.16, 0.5, "sawtooth");
      this.triggerTone(now, 880, 140, 0.12, 0.24, "triangle");
    }
  }

  /**
   * Flesh impact thud with sharp bone crack on crits
   */
  playHit(isCrit = false) {
    if (!this.sfx || !this.context || !this.sfxBus || this.context.state !== "running") return;
    const now = this.context.currentTime;

    // Meaty body thud
    this.triggerBassPunch(now, 130 + Math.random() * 40, 35, 0.06, 0.22, "triangle");
    this.triggerNoiseTransient(now, 0.03, 800, 1.5, 0.15);

    if (isCrit) {
      // Crisp metallic headshot / critical chime
      this.triggerTone(now, 1760, 2200, 0.09, 0.32, "sine");
      this.triggerTone(now + 0.015, 2640, 3300, 0.11, 0.28, "triangle");
    }
  }

  /**
   * Player damage thud with low-frequency pain rumble
   */
  playPlayerDamage() {
    if (!this.sfx || !this.context || !this.sfxBus || this.context.state !== "running") return;
    const now = this.context.currentTime;
    this.triggerBassPunch(now, 90, 25, 0.18, 0.45, "sawtooth");
    this.triggerNoiseTransient(now, 0.08, 450, 1.0, 0.35);
  }

  /**
   * Explosive barrel blast with heavy sub-bass earthquake and debris noise
   */
  playExplosion() {
    if (!this.sfx || !this.context || !this.sfxBus || this.context.state !== "running") return;
    const now = this.context.currentTime;
    this.triggerBassPunch(now, 85, 20, 0.45, 0.8, "sawtooth");
    this.triggerNoiseTransient(now, 0.4, 600, 0.8, 0.65);
    this.triggerTone(now, 240, 35, 0.35, 0.4, "triangle");
  }

  /**
   * Jet thruster dash whoosh
   */
  playDash() {
    if (!this.sfx || !this.context || !this.sfxBus || this.context.state !== "running") return;
    const now = this.context.currentTime;
    this.triggerNoiseTransient(now, 0.16, 1200, 1.8, 0.32);
    this.triggerBassPunch(now, 260, 60, 0.14, 0.35, "sine");
  }

  /**
   * Melodic crystalline pickup chimes
   */
  playPickup(type: PickupId) {
    if (!this.sfx || !this.context || !this.sfxBus || this.context.state !== "running") return;
    const now = this.context.currentTime;

    if (type === "coin") {
      this.triggerTone(now, 987.77, 1318.51, 0.08, 0.22, "sine");
      this.triggerTone(now + 0.04, 1318.51, 1975.53, 0.12, 0.26, "sine");
    } else if (type === "ammo") {
      this.triggerTone(now, 587.33, 880.0, 0.07, 0.22, "triangle");
      this.triggerTone(now + 0.05, 880.0, 1174.66, 0.1, 0.25, "triangle");
    } else {
      this.triggerTone(now, 440.0, 659.25, 0.09, 0.24, "sine");
      this.triggerTone(now + 0.06, 659.25, 880.0, 0.14, 0.28, "sine");
    }
  }

  /**
   * Mechanical weapon reload clicks
   */
  playReload() {
    if (!this.sfx || !this.context || !this.sfxBus || this.context.state !== "running") return;
    const now = this.context.currentTime;
    this.triggerNoiseTransient(now, 0.04, 2800, 3.5, 0.18);
    this.triggerTone(now, 320, 480, 0.05, 0.15, "triangle");
  }

  /**
   * High voltage chain lightning electric spark crackle
   */
  playChainLightning() {
    if (!this.sfx || !this.context || !this.sfxBus || this.context.state !== "running") return;
    const now = this.context.currentTime;
    this.triggerNoiseTransient(now, 0.1, 4200, 6.0, 0.35);
    this.triggerTone(now, 1850, 420, 0.08, 0.28, "sawtooth");
    this.triggerTone(now + 0.02, 2400, 310, 0.09, 0.22, "square");
  }

  /**
   * Massive boss ground slam earthquake impact
   */
  playGroundSlam() {
    if (!this.sfx || !this.context || !this.sfxBus || this.context.state !== "running") return;
    const now = this.context.currentTime;
    this.triggerBassPunch(now, 70, 18, 0.6, 0.95, "sawtooth");
    this.triggerNoiseTransient(now, 0.35, 450, 0.9, 0.7);
    this.triggerTone(now, 180, 24, 0.45, 0.5, "triangle");
  }

  /**
   * Stylized perk draft reward selection fanfare
   */
  playPerkSelect() {
    if (!this.sfx || !this.context || !this.sfxBus || this.context.state !== "running") return;
    const now = this.context.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.5]; // C5, E5, G5, C6
    notes.forEach((freq, index) => {
      this.triggerTone(now + index * 0.045, freq, freq * 1.05, 0.16, 0.24, "triangle");
      this.triggerTone(now + index * 0.045, freq * 2, freq * 2.05, 0.12, 0.12, "sine");
    });
  }

  /**
   * Volatile Boomer caustic chemical detonation
   */
  playBoomerDetonation() {
    if (!this.sfx || !this.context || !this.sfxBus || this.context.state !== "running") return;
    const now = this.context.currentTime;
    this.triggerBassPunch(now, 110, 25, 0.42, 0.85, "triangle");
    this.triggerNoiseTransient(now, 0.38, 900, 1.4, 0.75);
    this.triggerTone(now, 340, 60, 0.28, 0.45, "sawtooth");
  }

  /**
   * Boss phase transition alarm stinger
   */
  playBossPhaseShift() {
    if (!this.sfx || !this.context || !this.sfxBus || this.context.state !== "running") return;
    const now = this.context.currentTime;
    this.triggerTone(now, 440, 220, 0.25, 0.4, "sawtooth");
    this.triggerTone(now + 0.15, 660, 330, 0.35, 0.45, "sawtooth");
    this.triggerBassPunch(now, 140, 30, 0.5, 0.7, "sawtooth");
  }

  /**
   * Crystalline frost freeze crackle sound
   */
  playFreeze() {
    if (!this.sfx || !this.context || !this.sfxBus || this.context.state !== "running") return;
    const now = this.context.currentTime;
    this.triggerNoiseTransient(now, 0.14, 3800, 4.5, 0.35);
    this.triggerTone(now, 1800, 2900, 0.15, 0.25, "sine");
    this.triggerTone(now + 0.04, 3200, 4400, 0.14, 0.2, "triangle");
  }

  /**
   * Energy shield shatter crackle
   */
  playShieldBreak() {
    if (!this.sfx || !this.context || !this.sfxBus || this.context.state !== "running") return;
    const now = this.context.currentTime;
    this.triggerNoiseTransient(now, 0.12, 3800, 5.0, 0.4);
    this.triggerTone(now, 1400, 300, 0.14, 0.3, "square");
  }

  /**
   * Legacy tone method for fallback
   */
  tone(frequency: number, duration = 0.05, volume = 0.08, type: OscillatorType = "square") {
    if (!this.sfx || !this.context || !this.sfxBus || this.context.state !== "running") return;
    this.triggerTone(this.context.currentTime, frequency, frequency * 0.7, duration, volume, type);
  }

  stop() {
    if (typeof window !== "undefined" && this.pulseTimer !== undefined) window.clearInterval(this.pulseTimer);
    this.pulseTimer = undefined;
    this.unbindUnlockGesture();
    for (const source of this.persistentSources) {
      try {
        source.stop();
      } catch {
        // Source may already have ended.
      }
      source.disconnect();
    }
    this.persistentSources = [];
    const closing = this.context;
    this.resetNodes();
    if (closing && closing.state !== "closed") void closing.close().catch(() => undefined);
  }

  private triggerNoiseTransient(
    time: number,
    duration: number,
    filterFreq: number,
    filterQ: number,
    volume: number,
  ) {
    if (!this.context || !this.sfxBus) return;
    if (!this.noiseBuffer) this.createNoiseBuffer();
    if (!this.noiseBuffer) return;

    const source = this.context.createBufferSource();
    source.buffer = this.noiseBuffer;
    const filter = this.context.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(filterFreq, time);
    filter.frequency.exponentialRampToValueAtTime(Math.max(40, filterFreq * 0.4), time + duration);
    filter.Q.value = filterQ;

    const gain = this.context.createGain();
    gain.gain.setValueAtTime(volume, time);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);

    source.connect(filter).connect(gain).connect(this.sfxBus);
    source.start(time);
    source.stop(time + duration + 0.02);
  }

  private triggerBassPunch(
    time: number,
    startFreq: number,
    endFreq: number,
    duration: number,
    volume: number,
    type: OscillatorType,
  ) {
    if (!this.context || !this.sfxBus) return;
    const osc = this.context.createOscillator();
    const gain = this.context.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(startFreq, time);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), time + duration);

    gain.gain.setValueAtTime(volume, time);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);

    osc.connect(gain).connect(this.sfxBus);
    osc.start(time);
    osc.stop(time + duration + 0.02);
  }

  private triggerTone(
    time: number,
    startFreq: number,
    endFreq: number,
    duration: number,
    volume: number,
    type: OscillatorType,
  ) {
    if (!this.context || !this.sfxBus) return;
    const osc = this.context.createOscillator();
    const gain = this.context.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(startFreq, time);
    if (startFreq !== endFreq) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), time + duration);
    }
    gain.gain.setValueAtTime(volume, time);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);

    osc.connect(gain).connect(this.sfxBus);
    osc.start(time);
    osc.stop(time + duration + 0.02);
  }

  private createNoiseBuffer() {
    if (!this.context) return;
    const size = this.context.sampleRate * 2;
    const buffer = this.context.createBuffer(1, size, this.context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < size; i += 1) {
      data[i] = Math.random() * 2 - 1;
    }
    this.noiseBuffer = buffer;
  }

  private createGraph() {
    try {
      const AudioCtx =
        typeof window !== "undefined"
          ? window.AudioContext ||
            (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
          : null;
      if (!AudioCtx) return;
      try {
        this.context = new AudioCtx({ latencyHint: "interactive" });
      } catch {
        this.context = new AudioCtx();
      }
    } catch {
      return;
    }

    if (!this.context) return;
    this.master = this.context.createGain();
    this.musicBus = this.context.createGain();
    this.sfxBus = this.context.createGain();
    this.musicFilter = this.context.createBiquadFilter();

    this.master.gain.value = 0.38;
    this.musicBus.gain.value = 0;
    this.sfxBus.gain.value = this.sfx ? 0.95 : 0;
    this.musicFilter.type = "lowpass";
    // Opened up from 480Hz. The old bed was a survival-horror pad — three
    // sub-bass drones under a slow descending minor line — which read as dread
    // rather than as the pulpy action the visuals now promise.
    this.musicFilter.frequency.value = 1150;
    this.musicFilter.Q.value = 0.6;
    this.musicBus.connect(this.musicFilter).connect(this.master);
    this.sfxBus.connect(this.master);
    this.master.connect(this.context.destination);

    this.createNoiseBuffer();
    // Lighter bed: one low anchor plus a fifth, rather than a wall of sub.
    this.addDrone("sine", 65.41, 0.026);
    this.addDrone("triangle", 98.0, 0.016);
    this.addAirLayer();

    const lfo = this.context.createOscillator();
    const lfoGain = this.context.createGain();
    lfo.type = "sine";
    lfo.frequency.value = 0.11;
    lfoGain.gain.value = 220;
    lfo.connect(lfoGain).connect(this.musicFilter.frequency);
    lfo.start();
    this.persistentSources.push(lfo);

    this.schedulePulse();
  }

  private addDrone(type: OscillatorType, frequency: number, level: number) {
    if (!this.context || !this.musicBus) return;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = type;
    oscillator.frequency.value = frequency;
    oscillator.detune.value = Math.random() * 5 - 2.5;
    gain.gain.value = level;
    oscillator.connect(gain).connect(this.musicBus);
    oscillator.start();
    this.persistentSources.push(oscillator);
  }

  private addAirLayer() {
    if (!this.context || !this.musicBus) return;
    const buffer = this.context.createBuffer(1, this.context.sampleRate * 2, this.context.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let index = 0; index < samples.length; index += 1) samples[index] = Math.random() * 2 - 1;
    const source = this.context.createBufferSource();
    const filter = this.context.createBiquadFilter();
    const gain = this.context.createGain();
    source.buffer = buffer;
    source.loop = true;
    filter.type = "bandpass";
    filter.frequency.value = 185;
    filter.Q.value = 0.55;
    gain.gain.value = 0.012;
    source.connect(filter).connect(gain).connect(this.musicBus);
    source.start();
    this.persistentSources.push(source);
  }

  /**
   * Wave pressure, 0 to 1. Drives tempo and brightness so the score tightens
   * as a run goes deep instead of looping at one mood forever.
   */
  setIntensity(value: number) {
    this.intensity = Math.max(0, Math.min(1, value));
    if (this.musicFilter && this.context) {
      this.musicFilter.frequency.setTargetAtTime(
        950 + this.intensity * 900,
        this.context.currentTime,
        1.5,
      );
    }
  }

  private schedulePulse() {
    if (this.pulseTimer) window.clearInterval(this.pulseTimer);
    // 430ms at rest down to ~250ms at full pressure: a driving pulse rather
    // than the old 1450ms funeral march.
    const beat = 430 - this.intensity * 180;
    this.pulseTimer = window.setInterval(() => this.playMusicPulse(), beat);
    this.pulseBeat = beat;
  }

  private playMusicPulse() {
    if (!this.music || this.gameplayPaused || !this.context || !this.musicBus || this.context.state !== "running") return;

    // Retime if the pressure has moved enough to matter.
    const wanted = 430 - this.intensity * 180;
    if (Math.abs(wanted - this.pulseBeat) > 35) this.schedulePulse();

    const now = this.context.currentTime;
    // Root-fifth-octave riff in a major-leaning mode: forward motion, not dread.
    const riff = [98.0, 98.0, 146.83, 98.0, 130.81, 98.0, 164.81, 146.83];
    const step = this.pulseStep % riff.length;

    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = "sawtooth";
    oscillator.frequency.setValueAtTime(riff[step], now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.02 + this.intensity * 0.012, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.34);
    oscillator.connect(gain).connect(this.musicBus);
    oscillator.start(now);
    oscillator.stop(now + 0.38);

    // Kick on the downbeat gives the loop a spine you can feel.
    if (step % 2 === 0) {
      const kick = this.context.createOscillator();
      const kickGain = this.context.createGain();
      kick.type = "sine";
      kick.frequency.setValueAtTime(120, now);
      kick.frequency.exponentialRampToValueAtTime(42, now + 0.09);
      kickGain.gain.setValueAtTime(0.0001, now);
      kickGain.gain.exponentialRampToValueAtTime(0.05, now + 0.01);
      kickGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
      kick.connect(kickGain).connect(this.musicBus);
      kick.start(now);
      kick.stop(now + 0.2);
    }

    this.pulseStep += 1;
  }

  private applyLevels() {
    if (!this.context) return;
    const now = this.context.currentTime;
    if (this.musicBus) {
      const target = this.music ? (this.gameplayPaused ? 0.12 : 0.72) : 0;
      this.musicBus.gain.cancelScheduledValues(now);
      this.musicBus.gain.setTargetAtTime(target, now, 0.08);
    }
    if (this.sfxBus) {
      this.sfxBus.gain.cancelScheduledValues(now);
      this.sfxBus.gain.setTargetAtTime(this.sfx ? 0.95 : 0, now, 0.025);
    }
  }

  private unlock = () => {
    if (this.context?.state === "suspended") void this.context.resume().catch(() => undefined);
  };

  private bindUnlockGesture() {
    if (this.unlockListening || typeof window === "undefined") return;
    this.unlockListening = true;
    window.addEventListener("pointerdown", this.unlock, { passive: true });
    window.addEventListener("touchstart", this.unlock, { passive: true });
    window.addEventListener("touchend", this.unlock, { passive: true });
    window.addEventListener("keydown", this.unlock);
  }

  private unbindUnlockGesture() {
    if (!this.unlockListening || typeof window === "undefined") return;
    this.unlockListening = false;
    window.removeEventListener("pointerdown", this.unlock);
    window.removeEventListener("touchstart", this.unlock);
    window.removeEventListener("touchend", this.unlock);
    window.removeEventListener("keydown", this.unlock);
  }

  private resetNodes() {
    this.context = undefined;
    this.master = undefined;
    this.musicBus = undefined;
    this.sfxBus = undefined;
    this.musicFilter = undefined;
    this.noiseBuffer = undefined;
    this.persistentSources = [];
    this.pulseStep = 0;
  }
}
