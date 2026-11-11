import amqp from 'amqplib';
import { DLX, EXCHANGE, envelope } from './events.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class RabbitBus {
  constructor({ url, name, log }) {
    this.url = url;
    this.name = name;
    this.log = log;
  }

  async connect(attempts = 30) {
    for (let i = 1; ; i++) {
      try {
        this.conn = await amqp.connect(this.url);
        break;
      } catch (err) {
        if (i >= attempts) throw err;
        this.log?.warn('broker unavailable, retrying', { attempt: i });
        await sleep(2000);
      }
    }
    this.conn.on('error', (e) => this.log?.error('amqp connection error', { error: e.message }));
    this.pub = await this.conn.createConfirmChannel();
    await this.pub.assertExchange(EXCHANGE, 'topic', { durable: true });
    await this.pub.assertExchange(DLX, 'direct', { durable: true });
    this.log?.info('connected to broker');
  }

  async publish(type, data, { correlationId } = {}) {
    const evt = envelope(type, data, correlationId);
    this.pub.publish(EXCHANGE, type, Buffer.from(JSON.stringify(evt)), {
      persistent: true,
      contentType: 'application/json',
      messageId: evt.id,
      correlationId: evt.correlationId,
      type,
    });
    await this.pub.waitForConfirms();
    this.log?.info('published', { type, id: evt.id, correlationId: evt.correlationId });
    return evt;
  }

  /** Durable queue per service; failures are dead-lettered to `<queue>.dlq`. */
  async subscribe(queue, patterns, handler) {
    const ch = await this.conn.createChannel();
    await ch.prefetch(10);
    await ch.assertQueue(`${queue}.dlq`, { durable: true });
    await ch.bindQueue(`${queue}.dlq`, DLX, queue);
    await ch.assertQueue(queue, {
      durable: true,
      arguments: { 'x-dead-letter-exchange': DLX, 'x-dead-letter-routing-key': queue },
    });
    for (const p of patterns) await ch.bindQueue(queue, EXCHANGE, p);

    await ch.consume(queue, async (msg) => {
      if (!msg) return;
      try {
        const evt = JSON.parse(msg.content.toString());
        await handler(evt);
        ch.ack(msg);
      } catch (err) {
        this.log?.error('handler failed, dead-lettering', { queue, error: err.message });
        ch.nack(msg, false, false);
      }
    });
  }

  async close() {
    await this.conn?.close();
  }
}
