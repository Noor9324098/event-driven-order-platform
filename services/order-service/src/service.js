import { randomUUID } from 'node:crypto';
import { createApp, finalize, HttpError, EVENTS, once, createLogger } from '@shop/common';

export const name = 'order-service';

export const schema = `
CREATE TABLE IF NOT EXISTS orders (
  id           TEXT PRIMARY KEY,
  customer_id  TEXT NOT NULL,
  items        TEXT NOT NULL,
  status       TEXT NOT NULL,
  total_cents  INTEGER,
  reason       TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);`;

const toOrder = (r) =>
  r && {
    id: r.id,
    customerId: r.customer_id,
    items: JSON.parse(r.items),
    status: r.status,
    totalCents: r.total_cents,
    reason: r.reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };

function validate(body) {
  const { customerId, items } = body ?? {};
  if (typeof customerId !== 'string' || !customerId.trim()) throw new HttpError(400, 'customerId is required');
  if (!Array.isArray(items) || items.length === 0) throw new HttpError(400, 'items must be a non-empty array');
  for (const it of items) {
    if (typeof it?.sku !== 'string' || !it.sku) throw new HttpError(400, 'each item needs a sku');
    if (!Number.isInteger(it.qty) || it.qty < 1) throw new HttpError(400, 'each item needs a positive integer qty');
  }
  return { customerId: customerId.trim(), items: items.map(({ sku, qty }) => ({ sku, qty })) };
}

export function createService({ bus, db, log = createLogger(name) }) {
  const now = () => new Date().toISOString();
  const get = (id) => toOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(id));

  /** Only non-terminal orders may move; returns true when the transition applied. */
  function transition(id, status, { totalCents = null, reason = null } = {}) {
    const r = db
      .prepare(
        `UPDATE orders SET status = ?, total_cents = COALESCE(?, total_cents),
           reason = COALESCE(?, reason), updated_at = ?
         WHERE id = ? AND status NOT IN ('CONFIRMED', 'CANCELLED')`,
      )
      .run(status, totalCents, reason, now(), id);
    return r.changes > 0;
  }

  const app = createApp(name);

  app.post('/orders', async (req, res) => {
    const { customerId, items } = validate(req.body);
    const id = randomUUID();
    const ts = now();
    db.prepare(
      'INSERT INTO orders (id, customer_id, items, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, customerId, JSON.stringify(items), 'PENDING', ts, ts);
    await bus.publish(EVENTS.ORDER_CREATED, { orderId: id, customerId, items }, { correlationId: id });
    res.status(202).json(get(id));
  });

  app.get('/orders/:id', (req, res) => {
    const order = get(req.params.id);
    if (!order) throw new HttpError(404, 'order not found');
    res.json(order);
  });

  app.get('/orders', (req, res) => {
    const rows = req.query.customerId
      ? db.prepare('SELECT * FROM orders WHERE customer_id = ? ORDER BY created_at DESC').all(req.query.customerId)
      : db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 100').all();
    res.json(rows.map(toOrder));
  });

  finalize(app, log);

  const cancel = (evt, reason) => {
    const { orderId, customerId } = evt.data;
    if (transition(orderId, 'CANCELLED', { reason })) {
      return bus.publish(EVENTS.ORDER_CANCELLED, { orderId, customerId, reason }, { correlationId: evt.correlationId });
    }
  };

  async function onEvent(evt) {
    const { orderId, customerId } = evt.data;
    switch (evt.type) {
      case EVENTS.INVENTORY_RESERVED:
        transition(orderId, 'INVENTORY_RESERVED', { totalCents: evt.data.amountCents });
        break;
      case EVENTS.INVENTORY_REJECTED:
        await cancel(evt, evt.data.reason);
        break;
      case EVENTS.PAYMENT_COMPLETED:
        if (transition(orderId, 'CONFIRMED')) {
          await bus.publish(
            EVENTS.ORDER_CONFIRMED,
            { orderId, customerId, amountCents: evt.data.amountCents },
            { correlationId: evt.correlationId },
          );
        }
        break;
      case EVENTS.PAYMENT_FAILED:
        await cancel(evt, evt.data.reason);
        break;
    }
  }

  return {
    app,
    register: () => bus.subscribe('order-service.events', ['inventory.*', 'payment.*'], once(db, onEvent)),
  };
}
