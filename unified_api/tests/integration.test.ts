import request from 'supertest';
import app from '../src/index';
import { DatabaseManager } from '../src/models/database';

describe('Unified API Integration Tests', () => {
  let dbManager: DatabaseManager;

  beforeAll(async () => {
    dbManager = DatabaseManager.getInstance();
    await dbManager.connect();
  });

  afterAll(async () => {
    await dbManager.close();
  });

  describe('Health Check', () => {
    it('should return 200 OK', async () => {
      const response = await request(app).get('/health');
      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ok');
    });
  });

  describe('Jobs API', () => {
    it('should create a new job', async () => {
      const jobData = {
        type: 'discovery',
        input: [{ bankName: 'Test Bank' }],
        priority: 5
      };

      const response = await request(app)
        .post('/api/v1/jobs')
        .send(jobData);

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data.type).toBe('discovery');
      expect(response.body.data.id).toBeDefined();
    });

    it('should list jobs', async () => {
      const response = await request(app).get('/api/v1/jobs');
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(Array.isArray(response.body.data)).toBe(true);
    });
  });

  describe('Discovery API', () => {
    it('should discover domains', async () => {
      const discoveryData = {
        bankName: 'Goldman Sachs',
        priority: 'high'
      };

      const response = await request(app)
        .post('/api/v1/discovery')
        .send(discoveryData);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.bankName).toBe('Goldman Sachs');
      expect(Array.isArray(response.body.data.discoveredDomains)).toBe(true);
    });
  });
});
