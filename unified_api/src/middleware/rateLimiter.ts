import rateLimit from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import { createClient } from 'redis';
import { config } from '../config';
import { Request, Response } from 'express';

// Redis client for distributed rate limiting
let redisClient: ReturnType<typeof createClient> | null = null;

async function getRedisClient() {
  if (!redisClient) {
    redisClient = createClient({
      socket: {
        host: config.redis.host,
        port: config.redis.port,
      },
      password: config.redis.password || undefined,
      database: config.redis.db,
    });
    
    await redisClient.connect();
  }
  return redisClient;
}

// Custom rate limit exceeded handler
const rateLimitHandler = (req: Request, res: Response) => {
  res.status(429).json({
    success: false,
    error: 'Too many requests, please try again later',
    retryAfter: res.getHeader('Retry-After'),
    timestamp: new Date().toISOString()
  });
};

// Standard API rate limiter
export const apiLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.maxRequests,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
  keyGenerator: (req: Request) => {
    // Use API key if available, otherwise use IP
    const apiKey = req.headers['x-api-key'];
    return (apiKey as string) || req.ip || 'unknown';
  }
});

// Strict rate limiter for authentication endpoints
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts per window
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
  message: {
    success: false,
    error: 'Too many authentication attempts, please try again later',
    timestamp: new Date().toISOString()
  }
});

// Relaxed rate limiter for health checks and public endpoints
export const publicLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // 60 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler
});

// Batch operation rate limiter
export const batchLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 50, // 50 batch operations per hour
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
  keyGenerator: (req: Request) => {
    const apiKey = req.headers['x-api-key'];
    return (apiKey as string) || req.ip || 'unknown';
  }
});

// Domain discovery rate limiter (expensive operation)
export const discoveryLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 100, // 100 discoveries per hour
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
  skip: (req: Request) => {
    // Skip rate limiting for admin users
    return req.user?.role === 'admin';
  }
});

// Email verification rate limiter
export const verificationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 500, // 500 verifications per hour
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler
});

// Dynamic rate limiter based on user tier
export function createTieredLimiter(tiers: Record<string, { windowMs: number; max: number }>) {
  return rateLimit({
    windowMs: 60 * 60 * 1000, // Default 1 hour
    max: 100, // Default 100 requests
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitHandler,
    keyGenerator: (req: Request) => {
      const apiKey = req.headers['x-api-key'] as string;
      const user = (req as any).user;
      
      // Create a composite key with user tier
      const tier = user?.tier || 'default';
      return `${apiKey || req.ip}:${tier}`;
    },
    skip: (req: Request) => {
      return req.user?.role === 'admin';
    }
  });
}

// Redis-backed distributed rate limiter (for production)
export async function createDistributedLimiter() {
  try {
    const client = await getRedisClient();
    
    return rateLimit({
      store: new RedisStore({
        sendCommand: (...args: string[]) => client.sendCommand(args),
      }),
      windowMs: config.rateLimit.windowMs,
      max: config.rateLimit.maxRequests,
      standardHeaders: true,
      legacyHeaders: false,
      handler: rateLimitHandler
    });
  } catch (error) {
    console.warn('Redis not available, falling back to memory store');
    return apiLimiter;
  }
}
