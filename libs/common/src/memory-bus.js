import { envelope } from './events.js';

export function topicMatches(pattern, type) {
  const re = pattern.replace(/\./g, '\\.').replace(/\*/g, '[^.]+').replace(/#/g, '.*');
  return new RegExp(`^${re}$`).test(type);
}

/** In-process bus with the same contract as RabbitBus; used by tests. */
export class MemoryBus {
  constructor() {
    this.subs = [];
    this.pending = new Set();
    this.log = [];
    this.errors = [];
  }
  async connect() {}
  async close() {}

  async publish(type, data, { correlationId } = {}) {
    const evt = envelope(type, data, correlationId);
    this.log.push(evt);
    this.deliver(evt);
    return evt;
  }

  deliver(evt) {
    for (const sub of this.subs) {
      if (!sub.patterns.some((p) => topicMatches(p, evt.type))) continue;
      const p = new Promise((r) => setImmediate(r))
        .then(() => sub.handler(structuredClone(evt)))
        .catch((err) => this.errors.push({ queue: sub.queue, evt, err }))
        .finally(() => this.pending.delete(p));
      this.pending.add(p);
    }
  }

  async subscribe(queue, patterns, handler) {
    this.subs.push({ queue, patterns, handler });
  }

  /** Resolves once every in-flight (and cascading) delivery has finished. */
  async idle() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}
