import { randomUUID } from 'node:crypto';
import { createApp, finalize, HttpError, EVENTS, once, createLogger } from '@shop/common';

export const name = 'payment-service';

export const schema = `
CREATE TABLE IF NOT EXISTS payments (
  id           TEXT PRIMARY KEY,
  order_id     TEXT NOT NULL UNIQUE,
  customer_id  TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  status       TEXT NOT NULL,
  reason       TEXT,
  created_at   TEXT NOT NULL
);`;

/** Per-order spending limit of the simulated payment gateway (in cents). */
export const LIMIT_CENTS = 100_000;

/**
 * Simulated gateway, deterministic so the failure path is easy to demo:
 *  - customerId starting with "declined-" is always declined
 *  - amounts above LIMIT_CENTS are declined
 */
export function charge({ customerId, amountCents }) {
  if (customerId.startsWith('declined-')) return { ok: false, reason: 'card declined' };
  if (amountCents > LIMIT_CENTS) return { ok: false, reason: 'amount exceeds limit' };
  return { ok: true };
}

export function createService({ bus, db, log = createLogger(name) }) {
  const app = createApp(name);
  app.get('/payments/:orderId', (req, res) => {
    const p = db.prepare('SELECT * FROM payments WHERE order_id = ?').get(req.params.orderId);
    if (!p) throw new HttpError(404, 'payment not found');
    res.json({
      id: p.id,
      orderId: p.order_id,
      customerId: p.customer_id,
      amountCents: p.amount_cents,
      status: p.status,
      reason: p.reason,
      createdAt: p.created_at,
    });
  });
  finalize(app, log);

  async function onReserved(evt) {
    const { orderId, customerId, amountCents } = evt.data;
    const result = charge({ customerId, amountCents });
    const id = randomUUID();
    db.prepare(
      'INSERT OR IGNORE INTO payments (id, order_id, customer_id, amount_cents, status, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, orderId, customerId, amountCents, result.ok ? 'COMPLETED' : 'FAILED', result.reason ?? null, new Date().toISOString());

    if (result.ok) {
      await bus.publish(
        EVENTS.PAYMENT_COMPLETED,
        { orderId, customerId, amountCents, paymentId: id },
        { correlationId: evt.correlationId },
      );
    } else {
      await bus.publish(
        EVENTS.PAYMENT_FAILED,
        { orderId, customerId, reason: result.reason },
        { correlationId: evt.correlationId },
      );
    }
  }

  return {
    app,
    register: () => bus.subscribe('payment-service.events', [EVENTS.INVENTORY_RESERVED], once(db, onReserved)),
  };
}
