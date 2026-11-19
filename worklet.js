// Собирает моно-блоки по 2048 отсчётов и отдаёт их анализатору. Звук вкладки он не меняет.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 2048;
    this.buf = new Float32Array(this.size);
    this.n = 0;
  }
  process(inputs) {
    const inp = inputs[0];
    if (inp && inp.length) {
      const ch = inp.length;
      const len = inp[0].length;
      for (let i = 0; i < len; i++) {
        let s = 0;
        for (let c = 0; c < ch; c++) s += inp[c][i];
        this.buf[this.n++] = s / ch;
        if (this.n === this.size) {
          this.port.postMessage(this.buf, [this.buf.buffer]);
          this.buf = new Float32Array(this.size);
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('capture-processor', CaptureProcessor);
