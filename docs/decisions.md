# Decision records

## ADR-001: Message broker instead of direct HTTP calls

**Status:** accepted

**Context.** The order flow touches three services in sequence. Chaining synchronous HTTP calls would couple their availability and latency: one slow or failed service would fail the whole request.

**Decision.** Services communicate only through RabbitMQ events. HTTP is used only between clients and services.

**Consequences.**
- Services can be down independently and catch up later.
- The client sees an eventually consistent order and polls for its result.
- We must handle duplicate delivery ([Reliability](reliability.md)).

## ADR-002: Choreographed saga instead of an orchestrator

**Status:** accepted

**Context.** The order flow needs multi-step consistency. The two common patterns are orchestration (a coordinator tells each service what to do) and choreography (services react to each other's events).

**Decision.** Choreography. With only three steps, a coordinator adds a component without removing complexity, and it would become a fifth service.

**Consequences.**
- No single point of control or failure.
- The flow is not visible in one place, so it is documented in [Saga flows](saga-flows.md) and traced through `correlationId`.
- If the flow grows past roughly five steps or gains branching, revisit and consider an orchestrator.

## ADR-003: Database per service

**Status:** accepted

**Decision.** Each service owns a private database that no other service reads. Data crosses boundaries only as events.

**Consequences.**
- Services can change their schema freely.
- No cross-service joins or transactions, hence the saga.
- Data that other services need must be carried in events. For example, `inventory.reserved` includes the price because Inventory owns the catalogue.

## ADR-004: Inventory prices the order

**Status:** accepted

**Decision.** The client sends SKUs and quantities only. Inventory looks up prices and returns the total in `inventory.reserved`.

**Consequences.** The client cannot tamper with prices, and the Order service stays free of catalogue knowledge. The order total is unknown until the reservation succeeds.

## ADR-005: Idempotency by event id

**Status:** accepted

**Decision.** Every consumer records the ids of events it has handled in the same database as its business data, and skips repeats.

**Consequences.** Safe under at-least-once delivery. The `processed_events` table grows and needs periodic pruning in a long-running deployment.

## ADR-006: Node.js, Express and SQLite

**Status:** accepted

**Context.** The project is about architecture, so the stack should be common and easy to run.

**Decision.** Node.js 22 with Express 5, `amqplib` for RabbitMQ, and the built-in `node:sqlite` module for storage. No ORM, no build step.

**Consequences.** `git clone` followed by `docker compose up` is enough to run everything, with no database containers. SQLite is not meant for multi-instance production use. Swapping in PostgreSQL only touches each service's data access code.

## ADR-007: Single shared library, infrastructure only

**Status:** accepted

**Decision.** `libs/common` contains messaging, HTTP scaffolding and idempotency helpers. Business logic and event payload handling stay in each service.

**Consequences.** Less duplicated plumbing, with a deliberately narrow shared surface. Event payload shapes are documented contracts rather than shared types, so services are not forced to upgrade together.
