import { Router } from 'express';
import { DiscoveryController } from '../controllers/discovery.controller';
import { validate } from '../middleware/validation';
import { DomainDiscoveryRequestSchema } from '../models/types';
import { z } from 'zod';

const router = Router();
const controller = new DiscoveryController();

router.post('/', validate(z.object({ body: DomainDiscoveryRequestSchema })), controller.discoverDomains);

export default router;
