import { Request, Response, NextFunction } from 'express';
import { JobsService } from '../services/jobs.service';
import { ApiResponse, BatchJobStatus } from '../models/types';

export class JobsController {
  private jobsService = new JobsService();

  createJob = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const job = await this.jobsService.createJob(req.body);
      const response: ApiResponse = {
        success: true,
        data: job,
        timestamp: new Date().toISOString(),
      };
      res.status(201).json(response);
    } catch (error) {
      next(error);
    }
  };

  getJob = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const job = await this.jobsService.getJob(req.params.id);
      const response: ApiResponse = {
        success: true,
        data: job,
        timestamp: new Date().toISOString(),
      };
      res.json(response);
    } catch (error) {
      next(error);
    }
  };

  listJobs = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const type = req.query.type as string;
      const status = req.query.status as BatchJobStatus;
      const jobs = await this.jobsService.listJobs(type, status);
      const response: ApiResponse = {
        success: true,
        data: jobs,
        timestamp: new Date().toISOString(),
      };
      res.json(response);
    } catch (error) {
      next(error);
    }
  };

  cancelJob = async (req: Request, res: Response, next: NextFunction) => {
    try {
      await this.jobsService.cancelJob(req.params.id);
      const response: ApiResponse = {
        success: true,
        message: 'Job cancelled successfully',
        timestamp: new Date().toISOString(),
      };
      res.json(response);
    } catch (error) {
      next(error);
    }
  };
}
