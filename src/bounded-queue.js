"use strict";

// Count queued AND executing work. Byte accounting bounds retained frames while
// an asynchronous operation (disk, network, pin storage) is pending.
class BoundedQueue {
  constructor({ concurrency = 1, maxTasks = 128, maxBytes = 8 * 1024 * 1024, onError = () => {} } = {}) {
    Object.assign(this, { concurrency, maxTasks, maxBytes, onError });
    this.tasks = []; this.running = 0; this.count = 0; this.bytes = 0; this.closed = false;
  }
  enqueue(fn, bytes = 0) {
    if (this.closed || this.count >= this.maxTasks || bytes < 0 || this.bytes + bytes > this.maxBytes) return false;
    this.count++; this.bytes += bytes; this.tasks.push({ fn, bytes }); this.drain(); return true;
  }
  drain() {
    while (!this.closed && this.running < this.concurrency && this.tasks.length) {
      const task = this.tasks.shift(); this.running++;
      Promise.resolve().then(task.fn).catch(error => this.onError(error)).finally(() => {
        this.running--; this.count--; this.bytes -= task.bytes; this.drain();
      });
    }
  }
  close() {
    this.closed = true;
    for (const task of this.tasks) { this.count--; this.bytes -= task.bytes; }
    this.tasks = [];
  }
}
module.exports = { BoundedQueue };
