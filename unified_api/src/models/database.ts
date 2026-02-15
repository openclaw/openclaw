import { Database } from 'sqlite3';
import { Pool } from 'pg';
import { config } from '../config';

export interface DatabaseConnection {
  query: (sql: string, params?: any[]) => Promise<any>;
  close: () => Promise<void>;
}

export class SQLiteConnection implements DatabaseConnection {
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path);
  }

  async query(sql: string, params: any[] = []): Promise<any> {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
  }

  async close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }
}

export class PostgreSQLConnection implements DatabaseConnection {
  private pool: Pool;

  constructor(config: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
  }) {
    this.pool = new Pool(config);
  }

  async query(sql: string, params: any[] = []): Promise<any> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(sql, params);
      return result.rows;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export class DatabaseManager {
  private static instance: DatabaseManager;
  private connection: DatabaseConnection | null = null;

  private constructor() {}

  static getInstance(): DatabaseManager {
    if (!DatabaseManager.instance) {
      DatabaseManager.instance = new DatabaseManager();
    }
    return DatabaseManager.instance;
  }

  async connect(): Promise<DatabaseConnection> {
    if (this.connection) {
      return this.connection;
    }

    const dbType = config.database.type;
    
    switch (dbType) {
      case 'sqlite':
        this.connection = new SQLiteConnection(config.database.path);
        break;
      case 'postgres':
        this.connection = new PostgreSQLConnection({
          host: config.database.host,
          port: config.database.port,
          database: config.database.name,
          user: config.database.user,
          password: config.database.password,
        });
        break;
      default:
        throw new Error(`Unsupported database type: ${dbType}`);
    }

    // Initialize database schema
    await this.initializeSchema();

    return this.connection;
  }

  async getConnection(): Promise<DatabaseConnection> {
    if (!this.connection) {
      await this.connect();
    }
    return this.connection!;
  }

  async close(): Promise<void> {
    if (this.connection) {
      await this.connection.close();
      this.connection = null;
    }
  }

  private async initializeSchema(): Promise<void> {
    const connection = await this.getConnection();
    
    // Create tables if they don't exist
    const tables = [
      // Batch Jobs table
      `
      CREATE TABLE IF NOT EXISTS batch_jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        input TEXT NOT NULL,
        output TEXT,
        progress TEXT NOT NULL,
        metadata TEXT,
        started_at TIMESTAMP NOT NULL,
        completed_at TIMESTAMP,
        error TEXT,
        created_by TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
      `,
      
      // Workflow Results table
      `
      CREATE TABLE IF NOT EXISTS workflow_results (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        bank_name TEXT NOT NULL,
        institution_id TEXT,
        status TEXT NOT NULL,
        results TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_workflow_id (workflow_id),
        INDEX idx_bank_name (bank_name),
        INDEX idx_status (status)
      )
      `,
      
      // Domain Discovery Cache table
      `
      CREATE TABLE IF NOT EXISTS domain_discovery_cache (
        bank_name TEXT NOT NULL,
        domain TEXT NOT NULL,
        confidence REAL NOT NULL,
        source TEXT NOT NULL,
        tier INTEGER NOT NULL,
        mx_records TEXT,
        verified BOOLEAN DEFAULT FALSE,
        last_verified TIMESTAMP,
        email_patterns TEXT,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP,
        PRIMARY KEY (bank_name, domain),
        INDEX idx_bank_name (bank_name),
        INDEX idx_domain (domain),
        INDEX idx_expires_at (expires_at)
      )
      `,
      
      // Email Verification Cache table
      `
      CREATE TABLE IF NOT EXISTS email_verification_cache (
        email TEXT PRIMARY KEY,
        is_valid_format BOOLEAN NOT NULL,
        has_mx_record BOOLEAN NOT NULL,
        smtp_verified BOOLEAN NOT NULL,
        is_disposable BOOLEAN NOT NULL,
        is_role_account BOOLEAN NOT NULL,
        verification_time REAL NOT NULL,
        error TEXT,
        details TEXT NOT NULL,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP,
        INDEX idx_email (email),
        INDEX idx_expires_at (expires_at)
      )
      `,
      
      // Integration Logs table
      `
      CREATE TABLE IF NOT EXISTS integration_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        component TEXT NOT NULL,
        operation TEXT NOT NULL,
        status TEXT NOT NULL,
        input TEXT,
        output TEXT,
        error TEXT,
        duration_ms INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_component (component),
        INDEX idx_status (status),
        INDEX idx_created_at (created_at)
      )
      `,
      
      // System Metrics table
      `
      CREATE TABLE IF NOT EXISTS system_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        metric_name TEXT NOT NULL,
        metric_value REAL NOT NULL,
        tags TEXT,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_metric_name (metric_name),
        INDEX idx_timestamp (timestamp)
      )
      `,
    ];

    for (const tableSql of tables) {
      try {
        await connection.query(tableSql);
      } catch (error) {
        console.error(`Error creating table: ${error}`);
      }
    }

    // Create views for common queries
    const views = [
      // Daily workflow summary view
      `
      CREATE VIEW IF NOT EXISTS v_daily_workflow_summary AS
      SELECT 
        DATE(created_at) as date,
        COUNT(*) as total_workflows,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_workflows,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_workflows,
        AVG(JSON_EXTRACT(summary, '$.overallConfidence')) as avg_confidence
      FROM workflow_results
      GROUP BY DATE(created_at)
      ORDER BY date DESC
      `,
      
      // Component performance view
      `
      CREATE VIEW IF NOT EXISTS v_component_performance AS
      SELECT 
        component,
        COUNT(*) as total_operations,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successful_operations,
        AVG(duration_ms) as avg_duration_ms,
        MAX(duration_ms) as max_duration_ms,
        MIN(duration_ms) as min_duration_ms
      FROM integration_logs
      GROUP BY component
      ORDER BY total_operations DESC
      `,
      
      // High confidence contacts view
      `
      CREATE VIEW IF NOT EXISTS v_high_confidence_contacts AS
      SELECT 
        wr.bank_name,
        wr.institution_id,
        JSON_EXTRACT(wr.summary, '$.highConfidenceContacts') as high_confidence_contacts,
        JSON_EXTRACT(wr.summary, '$.totalContacts') as total_contacts,
        wr.created_at
      FROM workflow_results wr
      WHERE JSON_EXTRACT(wr.summary, '$.highConfidenceContacts') > 0
      ORDER BY wr.created_at DESC
      `,
    ];

    for (const viewSql of views) {
      try {
        await connection.query(viewSql);
      } catch (error) {
        console.error(`Error creating view: ${error}`);
      }
    }
  }

  // Helper methods for common operations
  async saveBatchJob(job: any): Promise<void> {
    const connection = await this.getConnection();
    const sql = `
      INSERT OR REPLACE INTO batch_jobs 
      (id, type, status, input, output, progress, metadata, started_at, completed_at, error, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    
    await connection.query(sql, [
      job.id,
      job.type,
      job.status,
      JSON.stringify(job.input),
      job.output ? JSON.stringify(job.output) : null,
      JSON.stringify(job.progress),
      job.metadata ? JSON.stringify(job.metadata) : null,
      job.startedAt,
      job.completedAt || null,
      job.error || null,
      job.createdBy,
    ]);
  }

  async getBatchJob(id: string): Promise<any> {
    const connection = await this.getConnection();
    const sql = `SELECT * FROM batch_jobs WHERE id = ?`;
    const rows = await connection.query(sql, [id]);
    
    if (rows.length === 0) {
      return null;
    }
    
    const row = rows[0];
    return {
      ...row,
      input: JSON.parse(row.input),
      output: row.output ? JSON.parse(row.output) : [],
      progress: JSON.parse(row.progress),
      metadata: row.metadata ? JSON.parse(row.metadata) : {},
    };
  }

  async updateBatchJobProgress(id: string, progress: any): Promise<void> {
    const connection = await this.getConnection();
    const sql = `UPDATE batch_jobs SET progress = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;
    await connection.query(sql, [JSON.stringify(progress), id]);
  }

  async saveWorkflowResult(result: any): Promise<void> {
    const connection = await this.getConnection();
    const sql = `
      INSERT OR REPLACE INTO workflow_results 
      (id, workflow_id, bank_name, institution_id, status, results, summary)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `;
    
    await connection.query(sql, [
      result.id,
      result.workflowId,
      result.bankName,
      result.institutionId || null,
      result.status,
      JSON.stringify(result.results),
      JSON.stringify(result.summary),
    ]);
  }

  async getWorkflowResult(workflowId: string): Promise<any> {
    const connection = await this.getConnection();
    const sql = `SELECT * FROM workflow_results WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1`;
    const rows = await connection.query(sql, [workflowId]);
    
    if (rows.length === 0) {
      return null;
    }
    
    const row = rows[0];
    return {
      ...row,
      results: JSON.parse(row.results),
      summary: JSON.parse(row.summary),
    };
  }

  async logIntegration(component: string, operation: string, status: string, input?: any, output?: any, error?: string, durationMs?: number): Promise<void> {
    const connection = await this.getConnection();
    const sql = `
      INSERT INTO integration_logs 
      (component, operation, status, input, output, error, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `;
    
    await connection.query(sql, [
      component,
      operation,
      status,
      input ? JSON.stringify(input) : null,
      output ? JSON.stringify(output) : null,
      error || null,
      durationMs || null,
    ]);
  }

  async recordMetric(metricName: string, metricValue: number, tags?: Record<string, any>): Promise<void> {
    const connection = await this.getConnection();
    const sql = `INSERT INTO system_metrics (metric_name, metric_value, tags) VALUES (?, ?, ?)`;
    await connection.query(sql, [metricName, metricValue, tags ? JSON.stringify(tags) : null]);
  }

  async cleanupExpiredCache(): Promise<number> {
    const connection = await this.getConnection();
    
    const tables = ['domain_discovery_cache', 'email_verification_cache'];
    let totalDeleted = 0;
    
    for (const table of tables) {
      const sql = `DELETE FROM ${table} WHERE expires_at < CURRENT_TIMESTAMP`;
      const result = await connection.query(sql);
      totalDeleted += result.changes || 0;
    }
    
    return totalDeleted;
  }
}