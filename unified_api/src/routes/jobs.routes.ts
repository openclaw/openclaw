import { Router } from 'express';
import { JobsController } from '../controllers/jobs.controller';
import { validate } from '../middleware/validation';
import { BatchJobRequestSchema } from '../models/types';
import { z } from 'zod';

const router = Router();
const controller = new JobsController();

const JobIdParamsSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
});

router.post('/', validate(z.object({ body: BatchJobRequestSchema })), controller.createJob);
router.get('/', controller.listJobs);
router.get('/:id', validate(JobIdParamsSchema), controller.getJob);
router.post('/:id/cancel', validate(JobIdParamsSchema), controller.cancelJob);

export default router;
