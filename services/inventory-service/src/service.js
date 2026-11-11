import { createApp, finalize, HttpError, EVENTS, once, transaction, createLogger } from '@shop/common';

export const name = 'inventory-service';

export const schema = `
CREATE TABLE IF NOT EXISTS stock (
  sku         TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  available   INTEGER NOT NULL CHECK (available >= 0)
);
CREATE TABLE IF NOT EXISTS reservations (
  order_id   TEXT PRIMARY KEY,
  items      TEXT NOT NULL,
  status     TEXT NOT NULL,
  created_at TEXT NOT NULL
);`;

export const SEED = [
  ['SKU-KEYBOARD', 'Mechanical keyboard', 7999, 50],
  ['SKU-MOUSE', 'Wireless mouse', 2999, 100],
  ['SKU-MONITOR', '27" monitor', 24999, 10],
  ['SKU-LAPTOP', 'Workstation laptop', 129900, 3],
];

class Rejection extends Error {}

export function createService({ bus, db, log = createLogger(name) }) {
  const seeded = db.prepare('SELECT COUNT(*) AS n FROM stock').get().n;
  if (!seeded) {
    const ins = db.prepare('INSERT INTO stock (sku, name, price_cents, available) VALUES (?, ?, ?, ?)');
    for (const row of SEED) ins.run(...row);
  }

  const mergeItems = (items) => {
    const m = new Map();
    for (const { sku, qty } of items) m.set(sku, (m.get(sku) ?? 0) + qty);
    return [...m].map(([sku, qty]) => ({ sku, qty }));
  };

  /** Atomically reserves every line or none of them. */
  function reserve(orderId, items) {
    return transaction(db, () => {
      const lines = mergeItems(items);
      let amountCents = 0;
      for (const { sku, qty } of lines) {
        const p = db.prepare('SELECT * FROM stock WHERE sku = ?').get(sku);
        if (!p) throw new Rejection(`unknown sku ${sku}`);
        if (p.available < qty) throw new Rejection(`insufficient stock for ${sku}`);
        amountCents += p.price_cents * qty;
      }
      for (const { sku, qty } of lines) {
        db.prepare('UPDATE stock SET available = available - ? WHERE sku = ?').run(qty, sku);
      }
      db.prepare('INSERT INTO reservations (order_id, items, status, created_at) VALUES (?, ?, ?, ?)').run(
        orderId,
        JSON.stringify(lines),
        'RESERVED',
        new Date().toISOString(),
      );
      return { amountCents, items: lines };
    });
  }

  /** Compensating action: put reserved stock back. */
  function release(orderId) {
    return transaction(db, () => {
      const r = db.prepare('SELECT * FROM reservations WHERE order_id = ? AND status = ?').get(orderId, 'RESERVED');
      if (!r) return false;
      for (const { sku, qty } of JSON.parse(r.items)) {
        db.prepare('UPDATE stock SET available = available + ? WHERE sku = ?').run(qty, sku);
      }
      db.prepare('UPDATE reservations SET status = ? WHERE order_id = ?').run('RELEASED', orderId);
      return true;
    });
  }

  const app = createApp(name);
  app.get('/products', (_req, res) => {
    res.json(
      db.prepare('SELECT sku, name, price_cents AS priceCents, available FROM stock ORDER BY sku').all(),
    );
  });
  app.get('/reservations/:orderId', (req, res) => {
    const r = db.prepare('SELECT * FROM reservations WHERE order_id = ?').get(req.params.orderId);
    if (!r) throw new HttpError(404, 'reservation not found');
    res.json({ orderId: r.order_id, items: JSON.parse(r.items), status: r.status, createdAt: r.created_at });
  });
  finalize(app, log);

  async function onEvent(evt) {
    if (evt.type === EVENTS.ORDER_CREATED) {
      const { orderId, customerId, items } = evt.data;
      try {
        const { amountCents, items: lines } = reserve(orderId, items);
        await bus.publish(
          EVENTS.INVENTORY_RESERVED,
          { orderId, customerId, amountCents, items: lines },
          { correlationId: evt.correlationId },
        );
      } catch (err) {
        if (!(err instanceof Rejection)) throw err;
        await bus.publish(
          EVENTS.INVENTORY_REJECTED,
          { orderId, customerId, reason: err.message },
          { correlationId: evt.correlationId },
        );
      }
    } else if (evt.type === EVENTS.PAYMENT_FAILED) {
      if (release(evt.data.orderId)) log.info('stock released', { orderId: evt.data.orderId });
    }
  }

  return {
    app,
    register: () =>
      bus.subscribe('inventory-service.events', [EVENTS.ORDER_CREATED, EVENTS.PAYMENT_FAILED], once(db, onEvent)),
  };
}
