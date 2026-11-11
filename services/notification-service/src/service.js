import { randomUUID } from 'node:crypto';
import { createApp, finalize, EVENTS, once, createLogger } from '@shop/common';

export const name = 'notification-service';

export const schema = `
CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT PRIMARY KEY,
  order_id    TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  kind        TEXT NOT NULL,
  message     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);`;

const dollars = (cents) => `$${(cents / 100).toFixed(2)}`;

/** Builds the customer-facing message for a terminal order event. */
export function render(evt) {
  const { orderId } = evt.data;
  if (evt.type === EVENTS.ORDER_CONFIRMED) {
    return { kind: 'ORDER_CONFIRMED', message: `Order ${orderId} confirmed. Charged ${dollars(evt.data.amountCents)}.` };
  }
  return { kind: 'ORDER_CANCELLED', message: `Order ${orderId} was cancelled: ${evt.data.reason}.` };
}

export function createService({ bus, db, log = createLogger(name) }) {
  const app = createApp(name);
  app.get('/notifications', (req, res) => {
    const rows = req.query.customerId
      ? db.prepare('SELECT * FROM notifications WHERE customer_id = ? ORDER BY created_at').all(req.query.customerId)
      : db.prepare('SELECT * FROM notifications ORDER BY created_at DESC LIMIT 100').all();
    res.json(
      rows.map((r) => ({
        id: r.id,
        orderId: r.order_id,
        customerId: r.customer_id,
        kind: r.kind,
        message: r.message,
        createdAt: r.created_at,
      })),
    );
  });
  finalize(app, log);

  async function onEvent(evt) {
    const { orderId, customerId } = evt.data;
    const { kind, message } = render(evt);
    db.prepare(
      'INSERT INTO notifications (id, order_id, customer_id, kind, message, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(randomUUID(), orderId, customerId, kind, message, new Date().toISOString());
    // A real deployment would hand this to an email/SMS/push provider here.
    log.info('notification sent', { customerId, kind, message });
  }

  return {
    app,
    register: () =>
      bus.subscribe('notification-service.events', [EVENTS.ORDER_CONFIRMED, EVENTS.ORDER_CANCELLED], once(db, onEvent)),
  };
}
