# Saga flows

Placing an order is a **choreographed saga**: a chain of local transactions, one per service, linked by events. If a step fails, earlier steps are undone with compensating actions.

## Happy path

```mermaid
sequenceDiagram
    autonumber
    actor C as Client
    participant O as Order Service
    participant MQ as RabbitMQ
    participant I as Inventory Service
    participant P as Payment Service
    participant N as Notification Service

    C->>O: POST /orders
    O->>O: save order (PENDING)
    O-->>C: 202 Accepted
    O->>MQ: order.created
    MQ->>I: order.created
    I->>I: reserve stock, price the order
    I->>MQ: inventory.reserved
    MQ->>O: inventory.reserved
    O->>O: status = INVENTORY_RESERVED
    MQ->>P: inventory.reserved
    P->>P: charge customer
    P->>MQ: payment.completed
    MQ->>O: payment.completed
    O->>O: status = CONFIRMED
    O->>MQ: order.confirmed
    MQ->>N: order.confirmed
    N->>N: notify customer
```

The client gets `202 Accepted` immediately and polls `GET /orders/{id}` for the final status. The order is never blocked on downstream services.

## Failure: out of stock

```mermaid
sequenceDiagram
    autonumber
    participant O as Order Service
    participant MQ as RabbitMQ
    participant I as Inventory Service
    participant N as Notification Service

    O->>MQ: order.created
    MQ->>I: order.created
    I->>I: stock check fails, nothing reserved
    I->>MQ: inventory.rejected (reason)
    MQ->>O: inventory.rejected
    O->>O: status = CANCELLED
    O->>MQ: order.cancelled
    MQ->>N: order.cancelled
    N->>N: notify customer
```

Payment is never attempted, so there is nothing to compensate.

## Failure: payment declined (compensation)

```mermaid
sequenceDiagram
    autonumber
    participant O as Order Service
    participant MQ as RabbitMQ
    participant I as Inventory Service
    participant P as Payment Service
    participant N as Notification Service

    O->>MQ: order.created
    MQ->>I: order.created
    I->>I: reserve stock
    I->>MQ: inventory.reserved
    MQ->>P: inventory.reserved
    P->>P: charge fails
    P->>MQ: payment.failed (reason)
    par compensate
        MQ->>I: payment.failed
        I->>I: release reservation, restore stock
    and cancel
        MQ->>O: payment.failed
        O->>O: status = CANCELLED
        O->>MQ: order.cancelled
        MQ->>N: order.cancelled
        N->>N: notify customer
    end
```

`payment.failed` fans out to two consumers: Inventory undoes its reservation, and Order cancels the order. Neither depends on the other.

## Order state machine

```mermaid
stateDiagram-v2
    [*] --> PENDING: POST /orders
    PENDING --> INVENTORY_RESERVED: inventory.reserved
    PENDING --> CANCELLED: inventory.rejected
    INVENTORY_RESERVED --> CONFIRMED: payment.completed
    INVENTORY_RESERVED --> CANCELLED: payment.failed
    CONFIRMED --> [*]
    CANCELLED --> [*]
```

`CONFIRMED` and `CANCELLED` are terminal. The Order Service refuses any further transition out of them, so duplicate or late events cannot reopen a finished order.

## Reservation state machine (Inventory)

```mermaid
stateDiagram-v2
    [*] --> RESERVED: order.created accepted
    RESERVED --> RELEASED: payment.failed
    RESERVED --> [*]: payment.completed (kept)
    RELEASED --> [*]
```

## Demo scenarios

| Scenario | Request | Result |
|---|---|---|
| Success | `customerId: alice`, `SKU-MOUSE` x2 | `CONFIRMED` |
| Out of stock | `SKU-LAPTOP` x99 | `CANCELLED`: insufficient stock |
| Unknown product | `SKU-NOPE` | `CANCELLED`: unknown sku |
| Declined card | `customerId: declined-bob` | `CANCELLED`: card declined, stock restored |
| Over the limit | `SKU-LAPTOP` x1 (1299.00 > 1000.00 limit) | `CANCELLED`: amount exceeds limit, stock restored |
