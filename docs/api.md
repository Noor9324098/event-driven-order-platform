# API reference

All services speak JSON over HTTP. Errors use the shape `{ "error": "message" }`.

Only the Order Service accepts commands. The other services expose read-only endpoints for inspection and debugging.

## Order Service (`:3001`)

### `POST /orders`

Creates an order. Responds `202 Accepted` because processing continues asynchronously.

Request:

```json
{
  "customerId": "alice",
  "items": [
    { "sku": "SKU-MOUSE", "qty": 2 },
    { "sku": "SKU-KEYBOARD", "qty": 1 }
  ]
}
```

Response `202`:

```json
{
  "id": "0b8f4a7e-5a0d-4c0b-a1f4-9d3f5c2e6a10",
  "customerId": "alice",
  "items": [{ "sku": "SKU-MOUSE", "qty": 2 }, { "sku": "SKU-KEYBOARD", "qty": 1 }],
  "status": "PENDING",
  "totalCents": null,
  "reason": null,
  "createdAt": "2026-11-11T10:15:30.000Z",
  "updatedAt": "2026-11-11T10:15:30.000Z"
}
```

| Status | When |
|---|---|
| `400` | `customerId` missing, `items` empty, or an item has no `sku` or a non-positive integer `qty` |

### `GET /orders/{id}`
Returns the order, or `404`. Poll this for the final `status`: `PENDING`, `INVENTORY_RESERVED`, `CONFIRMED` or `CANCELLED`. A cancelled order includes a `reason`.

### `GET /orders?customerId={id}`
Lists orders, newest first. Without `customerId`, returns the latest 100.

## Inventory Service (`:3002`)

### `GET /products`
```json
[{ "sku": "SKU-MOUSE", "name": "Wireless mouse", "priceCents": 2999, "available": 98 }]
```

### `GET /reservations/{orderId}`
```json
{ "orderId": "…", "items": [{ "sku": "SKU-MOUSE", "qty": 2 }], "status": "RESERVED", "createdAt": "…" }
```
`404` if the order has no reservation (for example, it was rejected).

## Payment Service (`:3003`)

### `GET /payments/{orderId}`
```json
{ "id": "…", "orderId": "…", "customerId": "alice", "amountCents": 5998, "status": "COMPLETED", "reason": null, "createdAt": "…" }
```
`status` is `COMPLETED` or `FAILED`. `404` if no payment was attempted.

## Notification Service (`:3004`)

### `GET /notifications?customerId={id}`
```json
[{ "id": "…", "orderId": "…", "customerId": "alice", "kind": "ORDER_CONFIRMED",
   "message": "Order … confirmed. Charged $59.98.", "createdAt": "…" }]
```
`kind` is `ORDER_CONFIRMED` or `ORDER_CANCELLED`.

## All services

### `GET /health`
```json
{ "service": "order-service", "status": "ok" }
```
