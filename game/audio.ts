export class GameAudio {
  private context?: AudioContext;
  private master?: GainNode;
  private sfx = true;
  private music = true;
  private drone?: OscillatorNode;
  private droneGain?: GainNode;

  configure(settings: { sfx: boolean; music: boolean }) {
    this.sfx = settings.sfx;
    this.music = settings.music;
    if (this.droneGain) this.droneGain.gain.value = this.music ? 0.018 : 0;
  }

  start() {
    if (typeof window === "undefined") return;
    this.context ??= new AudioContext();
    this.master ??= this.context.createGain();
    this.master.gain.value = 0.28;
    this.master.connect(this.context.destination);
    void this.context.resume();
    if (!this.drone) {
      this.drone = this.context.createOscillator();
      this.droneGain = this.context.createGain();
      this.drone.type = "sawtooth";
      this.drone.frequency.value = 44;
      this.droneGain.gain.value = this.music ? 0.018 : 0;
      this.drone.connect(this.droneGain).connect(this.master);
      this.drone.start();
    }
  }

  tone(frequency: number, duration = 0.05, volume = 0.08, type: OscillatorType = "square") {
    if (!this.sfx || !this.context || !this.master) return;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = type;
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(volume, this.context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, this.context.currentTime + duration);
    oscillator.connect(gain).connect(this.master);
    oscillator.start();
    oscillator.stop(this.context.currentTime + duration);
  }

  stop() {
    this.drone?.stop();
    this.drone = undefined;
    void this.context?.close();
    this.context = undefined;
  }
}
