import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryBus, openDb, EVENTS } from '@shop/common';
import * as order from '../services/order-service/src/service.js';
import * as inventory from '../services/inventory-service/src/service.js';
import * as payment from '../services/payment-service/src/service.js';
import * as notification from '../services/notification-service/src/service.js';

const quiet = { info() {}, warn() {}, error() {} };
let bus, servers, url;

async function startAll() {
  bus = new MemoryBus();
  servers = [];
  url = {};
  for (const [key, mod] of Object.entries({ order, inventory, payment, notification })) {
    const db = openDb(':memory:', mod.schema);
    const svc = mod.createService({ bus, db, log: quiet });
    await svc.register();
    const server = await new Promise((r) => {
      const s = svc.app.listen(0, () => r(s));
    });
    servers.push(server);
    url[key] = `http://127.0.0.1:${server.address().port}`;
  }
}

const stopAll = () => Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
const post = (path, body) =>
  fetch(url.order + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const json = async (u) => (await fetch(u)).json();
const stockOf = async (sku) => (await json(`${url.inventory}/products`)).find((p) => p.sku === sku).available;

async function placeOrder(body) {
  const res = await post('/orders', body);
  assert.equal(res.status, 202);
  const created = await res.json();
  await bus.idle();
  return json(`${url.order}/orders/${created.id}`);
}

beforeEach(startAll);
afterEach(stopAll);

test('happy path: order is confirmed, stock decremented, customer notified', async () => {
  const o = await placeOrder({ customerId: 'alice', items: [{ sku: 'SKU-MOUSE', qty: 2 }, { sku: 'SKU-KEYBOARD', qty: 1 }] });
  assert.equal(o.status, 'CONFIRMED');
  assert.equal(o.totalCents, 2 * 2999 + 7999);
  assert.equal(await stockOf('SKU-MOUSE'), 98);

  const pay = await json(`${url.payment}/payments/${o.id}`);
  assert.equal(pay.status, 'COMPLETED');

  const notes = await json(`${url.notification}/notifications?customerId=alice`);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].kind, 'ORDER_CONFIRMED');
  assert.deepEqual(bus.errors, []);
});

test('events share the order id as correlation id and follow the saga order', async () => {
  const o = await placeOrder({ customerId: 'bob', items: [{ sku: 'SKU-MOUSE', qty: 1 }] });
  assert.deepEqual(
    bus.log.map((e) => e.type),
    [EVENTS.ORDER_CREATED, EVENTS.INVENTORY_RESERVED, EVENTS.PAYMENT_COMPLETED, EVENTS.ORDER_CONFIRMED],
  );
  assert.ok(bus.log.every((e) => e.correlationId === o.id));
});

test('insufficient stock: order cancelled, payment never attempted', async () => {
  const o = await placeOrder({ customerId: 'carol', items: [{ sku: 'SKU-LAPTOP', qty: 99 }] });
  assert.equal(o.status, 'CANCELLED');
  assert.match(o.reason, /insufficient stock/);
  assert.equal((await fetch(`${url.payment}/payments/${o.id}`)).status, 404);
  const notes = await json(`${url.notification}/notifications?customerId=carol`);
  assert.equal(notes[0].kind, 'ORDER_CANCELLED');
});

test('unknown sku is rejected without touching stock', async () => {
  const o = await placeOrder({ customerId: 'dave', items: [{ sku: 'SKU-NOPE', qty: 1 }, { sku: 'SKU-MOUSE', qty: 1 }] });
  assert.equal(o.status, 'CANCELLED');
  assert.equal(await stockOf('SKU-MOUSE'), 100);
});

test('payment declined: compensation releases reserved stock', async () => {
  const o = await placeOrder({ customerId: 'declined-erin', items: [{ sku: 'SKU-MONITOR', qty: 2 }] });
  assert.equal(o.status, 'CANCELLED');
  assert.equal(o.reason, 'card declined');
  assert.equal(await stockOf('SKU-MONITOR'), 10);
  const r = await json(`${url.inventory}/reservations/${o.id}`);
  assert.equal(r.status, 'RELEASED');
});

test('payment over the limit is declined and stock restored', async () => {
  const o = await placeOrder({ customerId: 'frank', items: [{ sku: 'SKU-LAPTOP', qty: 1 }] });
  assert.equal(o.status, 'CANCELLED');
  assert.equal(o.reason, 'amount exceeds limit');
  assert.equal(await stockOf('SKU-LAPTOP'), 3);
});

test('redelivered events are processed once (idempotent consumers)', async () => {
  const o = await placeOrder({ customerId: 'gina', items: [{ sku: 'SKU-MOUSE', qty: 5 }] });
  const created = bus.log.find((e) => e.type === EVENTS.ORDER_CREATED);
  bus.deliver(created);
  bus.deliver(created);
  await bus.idle();
  assert.equal(await stockOf('SKU-MOUSE'), 95);
  assert.equal((await json(`${url.notification}/notifications?customerId=gina`)).length, 1);
  assert.equal(o.status, 'CONFIRMED');
  assert.deepEqual(bus.errors, []);
});

test('order validation returns 400', async () => {
  for (const body of [{}, { customerId: 'x', items: [] }, { customerId: 'x', items: [{ sku: 'a', qty: 0 }] }]) {
    assert.equal((await post('/orders', body)).status, 400);
  }
  assert.equal((await fetch(`${url.order}/orders/missing`)).status, 404);
});

test('every service exposes /health', async () => {
  for (const u of Object.values(url)) assert.equal((await fetch(`${u}/health`)).status, 200);
});
