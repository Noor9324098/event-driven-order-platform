# Architecture

## Goals

- Four services with clear, single-purpose boundaries
- No shared database and no synchronous calls between services
- All inter-service communication is asynchronous events over a broker
- A multi-step business transaction (placing an order) that stays consistent without distributed locks

## System context

```mermaid
flowchart TB
    customer([Customer / API client])
    subgraph Platform[Order Platform]
        direction TB
        order[Order Service]
        inventory[Inventory Service]
        payment[Payment Service]
        notification[Notification Service]
    end
    broker{{RabbitMQ}}
    gateway[(External payment gateway<br/>simulated)]
    channel[(Email / SMS provider<br/>log only)]

    customer -->|HTTP| order
    customer -.->|HTTP read-only| inventory
    order <--> broker
    inventory <--> broker
    payment <--> broker
    notification <--> broker
    payment -.-> gateway
    notification -.-> channel
```

The gateway and the notification channel are stubs in this repository. They are the seams where real integrations would plug in.

## Containers

```mermaid
flowchart LR
    subgraph order_c[order-service]
        o_api[HTTP API]
        o_cons[Event consumer]
        o_db[(orders.db)]
        o_api --> o_db
        o_cons --> o_db
    end
    subgraph inv_c[inventory-service]
        i_api[HTTP API]
        i_cons[Event consumer]
        i_db[(inventory.db)]
        i_api --> i_db
        i_cons --> i_db
    end
    subgraph pay_c[payment-service]
        p_api[HTTP API]
        p_cons[Event consumer]
        p_db[(payment.db)]
        p_api --> p_db
        p_cons --> p_db
    end
    subgraph not_c[notification-service]
        n_api[HTTP API]
        n_cons[Event consumer]
        n_db[(notification.db)]
        n_api --> n_db
        n_cons --> n_db
    end
    mq{{RabbitMQ: shop.events}}
    o_cons <--> mq
    i_cons <--> mq
    p_cons <--> mq
    n_cons <--> mq
```

Every service has the same shape: a small HTTP API for commands and queries, an event consumer for reacting to other services, and a private database.

## Messaging topology

All events are published to one durable **topic exchange**, `shop.events`, using the event type as the routing key. Each service owns one durable queue and binds it to the routing keys it cares about. A failed message is rejected without requeue and lands in that queue's dead-letter queue via the `shop.dlx` exchange.

```mermaid
flowchart LR
    pub[Any service] -->|routing key = event type| ex{{shop.events<br/>topic}}
    ex -->|order.created<br/>payment.failed| q1[inventory-service.events]
    ex -->|inventory.*<br/>payment.*| q2[order-service.events]
    ex -->|inventory.reserved| q3[payment-service.events]
    ex -->|order.confirmed<br/>order.cancelled| q4[notification-service.events]
    q1 -. reject .-> dlx{{shop.dlx<br/>direct}}
    q2 -. reject .-> dlx
    q3 -. reject .-> dlx
    q4 -. reject .-> dlx
    dlx --> d1[inventory-service.events.dlq]
    dlx --> d2[order-service.events.dlq]
    dlx --> d3[payment-service.events.dlq]
    dlx --> d4[notification-service.events.dlq]
```

## Design principles

| Principle | How it shows up |
|---|---|
| Database per service | Each service has its own SQLite file; no cross-service reads |
| Choreography over orchestration | There is no central coordinator; each service reacts to events and emits new ones ([ADR-002](decisions.md#adr-002-choreographed-saga-instead-of-an-orchestrator)) |
| Loose coupling | Producers do not know who consumes their events; adding a consumer needs no producer change |
| At-least-once delivery, idempotent handling | Consumers record processed event ids so a redelivery is harmless ([Reliability](reliability.md)) |
| Compensating transactions | A failed payment releases the reserved stock instead of rolling back a distributed transaction |
| Traceability | Every event carries a `correlationId` equal to the order id, and each service emits structured JSON logs |
| Stateless processes | State lives in the service database and the broker, so a service can be restarted or scaled |

## Shared library

`libs/common` holds only infrastructure that every service needs: the event envelope, the RabbitMQ and in-memory bus implementations, the idempotency wrapper, HTTP scaffolding and process bootstrap. It contains no business logic. Business rules stay inside the owning service.

The in-memory bus implements the same `publish` / `subscribe` contract as the RabbitMQ bus, which is what lets the saga be tested end to end in a single process.

## Deployment view

```mermaid
flowchart TB
    subgraph host[Docker Compose network]
        mq[rabbitmq<br/>5672, 15672]
        os[order-service<br/>host 3001]
        is[inventory-service<br/>host 3002]
        ps[payment-service<br/>host 3003]
        ns[notification-service<br/>host 3004]
        v1[(order-data)]
        v2[(inventory-data)]
        v3[(payment-data)]
        v4[(notification-data)]
    end
    os --> mq
    is --> mq
    ps --> mq
    ns --> mq
    os --- v1
    is --- v2
    ps --- v3
    ns --- v4
```

Services wait for the broker healthcheck and also retry the broker connection on startup, so start order does not matter.
