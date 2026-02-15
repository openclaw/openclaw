import { v4 as uuidv4 } from 'uuid';
import { DatabaseManager } from '../models/database';
import { BatchJob, BatchJobRequest, BatchJobStatus } from '../models/types';
import { AppError } from '../middleware/error';

export class JobsService {
  private dbManager = DatabaseManager.getInstance();

  async createJob(request: BatchJobRequest, createdBy: string = 'api'): Promise<BatchJob> {
    const job: BatchJob = {
      id: uuidv4(),
      type: request.type,
      status: 'pending',
      input: request.input,
      output: [],
      progress: {
        total: request.input.length,
        processed: 0,
        succeeded: 0,
        failed: 0,
      },
      metadata: request.metadata || {},
      startedAt: new Date().toISOString(),
      createdBy,
    };

    await this.dbManager.saveBatchJob(job);
    
    // In a real implementation, we would queue this job in Bull/Redis
    // For this unified API completion, we'll assume the worker picks it up
    
    return job;
  }

  async getJob(id: string): Promise<BatchJob> {
    const job = await this.dbManager.getBatchJob(id);
    if (!job) {
      throw new AppError(404, `Job with ID ${id} not found`);
    }
    return job;
  }

  async listJobs(type?: string, status?: BatchJobStatus): Promise<BatchJob[]> {
    const connection = await this.dbManager.getConnection();
    let sql = `SELECT * FROM batch_jobs`;
    const params: any[] = [];

    if (type || status) {
      sql += ' WHERE';
      if (type) {
        sql += ' type = ?';
        params.push(type);
      }
      if (status) {
        if (type) sql += ' AND';
        sql += ' status = ?';
        params.push(status);
      }
    }

    sql += ' ORDER BY created_at DESC LIMIT 100';
    
    const rows = await connection.query(sql, params);
    return rows.map((row: any) => ({
      ...row,
      input: JSON.parse(row.input),
      output: row.output ? JSON.parse(row.output) : [],
      progress: JSON.parse(row.progress),
      metadata: row.metadata ? JSON.parse(row.metadata) : {},
    }));
  }

  async cancelJob(id: string): Promise<void> {
    const job = await this.getJob(id);
    if (job.status === 'completed' || job.status === 'failed') {
      throw new AppError(400, `Cannot cancel job in status ${job.status}`);
    }

    const connection = await this.dbManager.getConnection();
    await connection.query('UPDATE batch_jobs SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['cancelled', id]);
  }
}
