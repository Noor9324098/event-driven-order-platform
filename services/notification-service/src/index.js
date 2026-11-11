import { bootstrap } from '@shop/common';
import { name, schema, createService } from './service.js';

bootstrap({ name, schema, create: createService });
