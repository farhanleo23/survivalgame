interface AudioSettings {
  sfx: boolean;
  music: boolean;
}

export class GameAudio {
  private context?: AudioContext;
  private master?: GainNode;
  private musicBus?: GainNode;
  private sfxBus?: GainNode;
  private musicFilter?: BiquadFilterNode;
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

  tone(frequency: number, duration = 0.05, volume = 0.08, type: OscillatorType = "square") {
    if (!this.sfx || !this.context || !this.sfxBus || this.context.state === "closed") return;
    if (this.context.state === "suspended") void this.context.resume().catch(() => undefined);
    const now = this.context.currentTime;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, now);
    gain.gain.setValueAtTime(Math.max(0.0001, volume), now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    oscillator.connect(gain).connect(this.sfxBus);
    oscillator.start(now);
    oscillator.stop(now + duration + 0.02);
  }

  stop() {
    if (typeof window !== "undefined" && this.pulseTimer !== undefined) window.clearInterval(this.pulseTimer);
    this.pulseTimer = undefined;
    this.unbindUnlockGesture();
    for (const source of this.persistentSources) {
      try { source.stop(); } catch { /* Source may already have ended. */ }
      source.disconnect();
    }
    this.persistentSources = [];
    const closing = this.context;
    this.resetNodes();
    if (closing && closing.state !== "closed") void closing.close().catch(() => undefined);
  }

  private createGraph() {
    this.context = new AudioContext({ latencyHint: "interactive" });
    this.master = this.context.createGain();
    this.musicBus = this.context.createGain();
    this.sfxBus = this.context.createGain();
    this.musicFilter = this.context.createBiquadFilter();

    this.master.gain.value = 0.34;
    this.musicBus.gain.value = 0;
    this.sfxBus.gain.value = this.sfx ? 0.9 : 0;
    this.musicFilter.type = "lowpass";
    this.musicFilter.frequency.value = 460;
    this.musicFilter.Q.value = 0.7;
    this.musicBus.connect(this.musicFilter).connect(this.master);
    this.sfxBus.connect(this.master);
    this.master.connect(this.context.destination);

    this.addDrone("sine", 32.7, 0.036);
    this.addDrone("triangle", 43.65, 0.028);
    this.addDrone("sine", 65.41, 0.013);
    this.addAirLayer();

    const lfo = this.context.createOscillator();
    const lfoGain = this.context.createGain();
    lfo.type = "sine";
    lfo.frequency.value = 0.075;
    lfoGain.gain.value = 115;
    lfo.connect(lfoGain).connect(this.musicFilter.frequency);
    lfo.start();
    this.persistentSources.push(lfo);

    this.pulseTimer = window.setInterval(() => this.playMusicPulse(), 1450);
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

  private playMusicPulse() {
    if (!this.music || this.gameplayPaused || !this.context || !this.musicBus || this.context.state !== "running") return;
    const notes = [82.41, 73.42, 65.41, 73.42, 87.31, 73.42, 61.74, 65.41];
    const now = this.context.currentTime;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = "triangle";
    oscillator.frequency.setValueAtTime(notes[this.pulseStep % notes.length], now);
    oscillator.frequency.exponentialRampToValueAtTime(notes[(this.pulseStep + 1) % notes.length], now + 1.15);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.022, now + 0.08);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.25);
    oscillator.connect(gain).connect(this.musicBus);
    oscillator.start(now);
    oscillator.stop(now + 1.3);
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
      this.sfxBus.gain.setTargetAtTime(this.sfx ? 0.9 : 0, now, 0.025);
    }
  }

  private unlock = () => {
    if (this.context?.state === "suspended") void this.context.resume().catch(() => undefined);
  };

  private bindUnlockGesture() {
    if (this.unlockListening || typeof window === "undefined") return;
    this.unlockListening = true;
    window.addEventListener("pointerdown", this.unlock, { passive: true });
    window.addEventListener("keydown", this.unlock);
  }

  private unbindUnlockGesture() {
    if (!this.unlockListening || typeof window === "undefined") return;
    this.unlockListening = false;
    window.removeEventListener("pointerdown", this.unlock);
    window.removeEventListener("keydown", this.unlock);
  }

  private resetNodes() {
    this.context = undefined;
    this.master = undefined;
    this.musicBus = undefined;
    this.sfxBus = undefined;
    this.musicFilter = undefined;
    this.persistentSources = [];
    this.pulseStep = 0;
  }
}
