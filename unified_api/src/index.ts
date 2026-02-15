import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { config, getApiBasePath } from './config';
import { logger } from './utils/logger';
import { errorHandler } from './middleware/error';
import { DatabaseManager } from './models/database';
import jobsRoutes from './routes/jobs.routes';
import discoveryRoutes from './routes/discovery.routes';
// Import other routes...

const app = express();

// Middleware
app.use(helmet());
app.use(cors());
app.use(compression());
app.use(express.json());

// Health Check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: config.version || '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// Routes
const apiBase = getApiBasePath();
app.use(`${apiBase}/jobs`, jobsRoutes);
app.use(`${apiBase}/discovery`, discoveryRoutes);

// Error Handling
app.use(errorHandler);

// Start Server
const start = async () => {
  try {
    const dbManager = DatabaseManager.getInstance();
    await dbManager.connect();
    logger.info('Database connected successfully');

    app.listen(config.port, () => {
      logger.info(`Server running on port ${config.port} in ${config.nodeEnv} mode`);
      logger.info(`API Base Path: ${apiBase}`);
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
};

if (require.main === module) {
  start();
}

export default app;
