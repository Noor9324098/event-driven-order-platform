import { createLogger } from './logger.js';
import { openDb } from './db.js';
import { RabbitBus } from './rabbit-bus.js';

/** Shared process wiring for every service. */
export async function bootstrap({ name, schema, create }) {
  const log = createLogger(name);
  const port = Number(process.env.PORT || 3000);
  const db = openDb(process.env.DB_FILE || ':memory:', schema);
  const bus = new RabbitBus({ url: process.env.RABBITMQ_URL || 'amqp://localhost', name, log });
  await bus.connect();

  const svc = create({ bus, db, log });
  await svc.register();
  const server = svc.app.listen(port, () => log.info('listening', { port }));

  const stop = async () => {
    server.close();
    await bus.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
