import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';

export interface AuthUser {
  id: string;
  email: string;
  role: 'admin' | 'user' | 'service';
  permissions: string[];
}

export interface AuthRequest extends Request {
  user?: AuthUser;
  apiKey?: string;
}

/**
 * JWT Authentication Middleware
 */
export function authenticateJWT(req: AuthRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    res.status(401).json({
      success: false,
      error: 'No authorization header provided',
      timestamp: new Date().toISOString()
    });
    return;
  }
  
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    res.status(401).json({
      success: false,
      error: 'Invalid authorization format. Use: Bearer <token>',
      timestamp: new Date().toISOString()
    });
    return;
  }
  
  const token = parts[1];
  
  try {
    const decoded = jwt.verify(token, config.jwt.secret) as AuthUser;
    req.user = decoded;
    next();
  } catch (error) {
    res.status(401).json({
      success: false,
      error: 'Invalid or expired token',
      timestamp: new Date().toISOString()
    });
  }
}

/**
 * API Key Authentication Middleware
 */
export function authenticateApiKey(req: AuthRequest, res: Response, next: NextFunction): void {
  const apiKey = req.headers['x-api-key'] as string;
  
  if (!apiKey) {
    res.status(401).json({
      success: false,
      error: 'No API key provided',
      timestamp: new Date().toISOString()
    });
    return;
  }
  
  // Validate API key format and check against valid keys
  const validApiKeys = process.env.VALID_API_KEYS?.split(',') || [];
  
  if (!validApiKeys.includes(apiKey)) {
    res.status(401).json({
      success: false,
      error: 'Invalid API key',
      timestamp: new Date().toISOString()
    });
    return;
  }
  
  req.apiKey = apiKey;
  next();
}

/**
 * Combined Authentication Middleware (JWT or API Key)
 */
export function authenticate(req: AuthRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  const apiKey = req.headers['x-api-key'] as string;
  
  if (authHeader) {
    return authenticateJWT(req, res, next);
  } else if (apiKey) {
    return authenticateApiKey(req, res, next);
  }
  
  res.status(401).json({
    success: false,
    error: 'Authentication required. Provide either Bearer token or X-API-Key header',
    timestamp: new Date().toISOString()
  });
}

/**
 * Optional Authentication - doesn't fail if no auth provided
 */
export function optionalAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  const apiKey = req.headers['x-api-key'] as string;
  
  if (authHeader) {
    const parts = authHeader.split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer') {
      try {
        const decoded = jwt.verify(parts[1], config.jwt.secret) as AuthUser;
        req.user = decoded;
      } catch {
        // Silently continue without auth
      }
    }
  } else if (apiKey) {
    const validApiKeys = process.env.VALID_API_KEYS?.split(',') || [];
    if (validApiKeys.includes(apiKey)) {
      req.apiKey = apiKey;
    }
  }
  
  next();
}

/**
 * Role-based Authorization Middleware
 */
export function requireRole(...roles: string[]): (req: AuthRequest, res: Response, next: NextFunction) => void {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        success: false,
        error: 'Authentication required',
        timestamp: new Date().toISOString()
      });
      return;
    }
    
    if (!roles.includes(req.user.role)) {
      res.status(403).json({
        success: false,
        error: `Insufficient permissions. Required role: ${roles.join(' or ')}`,
        timestamp: new Date().toISOString()
      });
      return;
    }
    
    next();
  };
}

/**
 * Permission-based Authorization Middleware
 */
export function requirePermission(...permissions: string[]): (req: AuthRequest, res: Response, next: NextFunction) => void {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        success: false,
        error: 'Authentication required',
        timestamp: new Date().toISOString()
      });
      return;
    }
    
    const hasPermission = permissions.some(perm => 
      req.user!.permissions.includes(perm) || req.user!.role === 'admin'
    );
    
    if (!hasPermission) {
      res.status(403).json({
        success: false,
        error: `Insufficient permissions. Required: ${permissions.join(' or ')}`,
        timestamp: new Date().toISOString()
      });
      return;
    }
    
    next();
  };
}

/**
 * Generate JWT Token (for login/token generation endpoints)
 */
export function generateToken(user: Omit<AuthUser, 'permissions'> & { permissions?: string[] }): string {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
      permissions: user.permissions || []
    },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn }
  );
}

/**
 * Verify and decode token without throwing
 */
export function verifyToken(token: string): AuthUser | null {
  try {
    return jwt.verify(token, config.jwt.secret) as AuthUser;
  } catch {
    return null;
  }
}
