import { Request, Response, NextFunction } from 'express';
import { DiscoveryService } from '../services/discovery.service';
import { ApiResponse } from '../models/types';

export class DiscoveryController {
  private discoveryService = new DiscoveryService();

  discoverDomains = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await this.discoveryService.discoverDomains(req.body);
      const response: ApiResponse = {
        success: true,
        data: result,
        timestamp: new Date().toISOString(),
      };
      res.json(response);
    } catch (error) {
      next(error);
    }
  };
}
