import winston from 'winston';
import { config } from '../config';

// Custom format for structured logging
const customFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

// Console format for development
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    let metaStr = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
    return `[${timestamp}] ${level}: ${message} ${metaStr}`;
  })
);

// Create logger instance
const logger = winston.createLogger({
  level: config.logging.level,
  format: customFormat,
  defaultMeta: { service: 'unified-api' },
  transports: [
    // File transport for all logs
    new winston.transports.File({
      filename: config.logging.file,
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
    // Separate file for errors
    new winston.transports.File({
      filename: config.logging.file.replace('.log', '.error.log'),
      level: 'error',
      maxsize: 5242880,
      maxFiles: 5,
    }),
  ],
});

// Add console transport in development
if (config.nodeEnv !== 'production') {
  logger.add(new winston.transports.Console({
    format: consoleFormat,
  }));
}

// Helper functions for common log patterns
export const log = {
  info: (message: string, meta?: any) => logger.info(message, meta),
  error: (message: string, meta?: any) => logger.error(message, meta),
  warn: (message: string, meta?: any) => logger.warn(message, meta),
  debug: (message: string, meta?: any) => logger.debug(message, meta),
  
  // Request logging
  request: (req: { method: string; path: string; ip?: string }, meta?: any) => {
    logger.info('Incoming request', {
      method: req.method,
      path: req.path,
      ip: req.ip,
      ...meta
    });
  },
  
  // Response logging
  response: (res: { statusCode: number }, duration: number, meta?: any) => {
    logger.info('Response sent', {
      status: res.statusCode,
      duration: `${duration}ms`,
      ...meta
    });
  },
  
  // Error logging with context
  errorWithContext: (error: Error, context: string, meta?: any) => {
    logger.error(`Error in ${context}`, {
      error: error.message,
      stack: error.stack,
      ...meta
    });
  },
  
  // Performance logging
  performance: (operation: string, duration: number, meta?: any) => {
    const level = duration > 5000 ? 'warn' : 'info';
    logger.log(level, `Performance: ${operation}`, {
      duration: `${duration}ms`,
      ...meta
    });
  },
  
  // Audit logging
  audit: (action: string, userId: string, resource: string, meta?: any) => {
    logger.info('Audit log', {
      action,
      userId,
      resource,
      timestamp: new Date().toISOString(),
      ...meta
    });
  },
  
  // Security event logging
  security: (event: string, meta?: any) => {
    logger.warn(`Security event: ${event}`, {
      event,
      timestamp: new Date().toISOString(),
      ...meta
    });
  }
};

export { logger };
export default logger;
