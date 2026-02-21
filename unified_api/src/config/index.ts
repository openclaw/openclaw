import dotenv from 'dotenv';
import { z } from 'zod';

// Load environment variables
dotenv.config();

// Configuration schema
const ConfigSchema = z.object({
  // Server Configuration
  port: z.number().default(3000),
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
  apiVersion: z.string().default('v1'),
  
  // Database Configuration
  database: z.object({
    type: z.enum(['sqlite', 'postgres']).default('sqlite'),
    path: z.string().default('./data/database.sqlite'),
    host: z.string().default('localhost'),
    port: z.number().default(5432),
    name: z.string().default('clawbot_crm'),
    user: z.string().default('postgres'),
    password: z.string().default('postgres'),
  }),
  
  // Redis Configuration
  redis: z.object({
    host: z.string().default('localhost'),
    port: z.number().default(6379),
    password: z.string().optional(),
    db: z.number().default(0),
  }),
  
  // JWT Configuration
  jwt: z.object({
    secret: z.string().default('your-super-secret-jwt-key-change-this-in-production'),
    expiresIn: z.string().default('24h'),
  }),
  
  // API Keys (for external services)
  apiKeys: z.object({
    secApiKey: z.string().optional(),
    googleApiKey: z.string().optional(),
    googleCx: z.string().optional(),
    fdicApiKey: z.string().optional(),
  }),
  
  // Rate Limiting
  rateLimit: z.object({
    windowMs: z.number().default(900000), // 15 minutes
    maxRequests: z.number().default(100),
  }),
  
  // Logging
  logging: z.object({
    level: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
    file: z.string().default('./logs/app.log'),
  }),
  
  // Email Verification
  smtp: z.object({
    timeout: z.number().default(10000),
    maxRetries: z.number().default(3),
    retryDelay: z.number().default(1000),
  }),
  
  // Batch Processing
  batch: z.object({
    size: z.number().default(100),
    maxWorkers: z.number().default(5),
    maxContactsPerHour: z.number().default(200000),
  }),
  
  // Confidence Scoring
  scoring: z.object({
    weights: z.object({
      syntax: z.number().default(0.1),   // 10%
      dns: z.number().default(0.2),      // 20%
      smtp: z.number().default(0.4),     // 40%
      format: z.number().default(0.3),   // 30%
    }),
    threshold: z.number().default(0.7),  // 70% minimum
  }),
  
  // Domain Discovery
  domainDiscovery: z.object({
    tiers: z.object({
      tier1: z.object({ enabled: z.boolean().default(true), weight: z.number().default(0.95) }),
      tier2: z.object({ enabled: z.boolean().default(true), weight: z.number().default(0.85) }),
      tier3: z.object({ enabled: z.boolean().default(true), weight: z.number().default(0.75) }),
      tier4: z.object({ enabled: z.boolean().default(true), weight: z.number().default(0.90) }),
    }),
    cacheTtl: z.number().default(86400), // 24 hours in seconds
  }),
  
  // Distress Signal Calculation
  distressSignals: z.object({
    weights: z.object({
      nonaccrualGrowth: z.number().default(0.3),
      oreoGrowth: z.number().default(0.25),
      chargeoffsGrowth: z.number().default(0.2),
      pastDueGrowth: z.number().default(0.15),
      capitalRatioDecline: z.number().default(0.1),
    }),
    thresholds: z.object({
      low: z.number().default(30),
      medium: z.number().default(50),
      high: z.number().default(70),
      critical: z.number().default(90),
    }),
  }),
});

// Parse environment variables
const rawConfig = {
  // Server Configuration
  port: parseInt(process.env.PORT || '3000'),
  nodeEnv: process.env.NODE_ENV || 'development',
  apiVersion: process.env.API_VERSION || 'v1',
  
  // Database Configuration
  database: {
    type: process.env.DB_TYPE || 'sqlite',
    path: process.env.DB_PATH || './data/database.sqlite',
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    name: process.env.DB_NAME || 'clawbot_crm',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  },
  
  // Redis Configuration
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD,
    db: parseInt(process.env.REDIS_DB || '0'),
  },
  
  // JWT Configuration
  jwt: {
    secret: process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-this-in-production',
    expiresIn: process.env.JWT_EXPIRES_IN || '24h',
  },
  
  // API Keys
  apiKeys: {
    secApiKey: process.env.SEC_API_KEY,
    googleApiKey: process.env.GOOGLE_API_KEY,
    googleCx: process.env.GOOGLE_CX,
    fdicApiKey: process.env.FDIC_API_KEY,
  },
  
  // Rate Limiting
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'),
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100'),
  },
  
  // Logging
  logging: {
    level: (process.env.LOG_LEVEL || 'info') as 'error' | 'warn' | 'info' | 'debug',
    file: process.env.LOG_FILE || './logs/app.log',
  },
  
  // Email Verification
  smtp: {
    timeout: parseInt(process.env.SMTP_TIMEOUT || '10000'),
    maxRetries: parseInt(process.env.SMTP_MAX_RETRIES || '3'),
    retryDelay: parseInt(process.env.SMTP_RETRY_DELAY || '1000'),
  },
  
  // Batch Processing
  batch: {
    size: parseInt(process.env.BATCH_SIZE || '100'),
    maxWorkers: parseInt(process.env.MAX_WORKERS || '5'),
    maxContactsPerHour: parseInt(process.env.MAX_CONTACTS_PER_HOUR || '200000'),
  },
  
  // Confidence Scoring (default weights)
  scoring: {
    weights: {
      syntax: 0.1,
      dns: 0.2,
      smtp: 0.4,
      format: 0.3,
    },
    threshold: 0.7,
  },
  
  // Domain Discovery
  domainDiscovery: {
    tiers: {
      tier1: { enabled: true, weight: 0.95 },
      tier2: { enabled: true, weight: 0.85 },
      tier3: { enabled: true, weight: 0.75 },
      tier4: { enabled: true, weight: 0.90 },
    },
    cacheTtl: 86400,
  },
  
  // Distress Signal Calculation
  distressSignals: {
    weights: {
      nonaccrualGrowth: 0.3,
      oreoGrowth: 0.25,
      chargeoffsGrowth: 0.2,
      pastDueGrowth: 0.15,
      capitalRatioDecline: 0.1,
    },
    thresholds: {
      low: 30,
      medium: 50,
      high: 70,
      critical: 90,
    },
  },
};

// Validate configuration
const config = ConfigSchema.parse(rawConfig);

// Export configuration
export { config };

// Helper functions
export function isDevelopment(): boolean {
  return config.nodeEnv === 'development';
}

export function isProduction(): boolean {
  return config.nodeEnv === 'production';
}

export function isTest(): boolean {
  return config.nodeEnv === 'test';
}

export function getApiBasePath(): string {
  return `/api/${config.apiVersion}`;
}

export function getDatabaseConfig() {
  return config.database;
}

export function getRedisConfig() {
  return config.redis;
}

export function getJwtConfig() {
  return config.jwt;
}

export function getRateLimitConfig() {
  return config.rateLimit;
}

export function getLoggingConfig() {
  return config.logging;
}

export function getBatchConfig() {
  return config.batch;
}

export function getScoringConfig() {
  return config.scoring;
}

export function getDomainDiscoveryConfig() {
  return config.domainDiscovery;
}

export function getDistressSignalConfig() {
  return config.distressSignals;
}