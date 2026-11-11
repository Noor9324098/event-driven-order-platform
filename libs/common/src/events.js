import { randomUUID } from 'node:crypto';

export const EXCHANGE = 'shop.events';
export const DLX = 'shop.dlx';

export const EVENTS = Object.freeze({
  ORDER_CREATED: 'order.created',
  INVENTORY_RESERVED: 'inventory.reserved',
  INVENTORY_REJECTED: 'inventory.rejected',
  PAYMENT_COMPLETED: 'payment.completed',
  PAYMENT_FAILED: 'payment.failed',
  ORDER_CONFIRMED: 'order.confirmed',
  ORDER_CANCELLED: 'order.cancelled',
});

/** Every message on the bus is wrapped in this envelope. */
export function envelope(type, data, correlationId) {
  return {
    id: randomUUID(),
    type,
    occurredAt: new Date().toISOString(),
    correlationId: correlationId ?? randomUUID(),
    data,
  };
}
