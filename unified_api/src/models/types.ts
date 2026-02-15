import { z } from 'zod';

// Base types
export type ApiResponse<T = any> = {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  timestamp: string;
};

export type PaginatedResponse<T> = ApiResponse<{
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}>;

export type BatchJobStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';

// Domain Discovery Types
export interface DomainDiscoveryRequest {
  bankName: string;
  fdicCertNumber?: string;
  rssdId?: string;
  state?: string;
  priority?: 'high' | 'medium' | 'low';
  forceRefresh?: boolean;
  tiers?: number[];
}

export interface DomainCandidate {
  domain: string;
  confidence: number;
  source: string;
  tier: number;
  mxRecords: string[];
  verified: boolean;
  lastVerified: string | null;
  emailPatterns: EmailPattern[];
}

export interface DomainDiscoveryResult {
  bankName: string;
  discoveredDomains: DomainCandidate[];
  confidenceScore: number;
  sourceTiers: SourceTier[];
  timestamp: string;
  metadata: Record<string, any>;
}

export interface SourceTier {
  tier: number;
  source: string;
  confidence: number;
  data: any;
  timestamp: string;
}

// Email Pattern Types
export interface EmailPattern {
  pattern: string;
  examples: string[];
  confidence: number;
}

export interface EmailPatternRequest {
  domain: string;
  firstName?: string;
  lastName?: string;
  companyName?: string;
}

export interface EmailPatternResult {
  domain: string;
  patterns: EmailPattern[];
  suggestedPattern: string;
  confidence: number;
}

// SMTP Verification Types
export interface EmailVerificationRequest {
  email: string;
  verifyMx?: boolean;
  verifySmtp?: boolean;
  checkDisposable?: boolean;
  checkRoleAccount?: boolean;
}

export interface EmailVerificationResult {
  email: string;
  isValidFormat: boolean;
  hasMxRecord: boolean;
  smtpVerified: boolean;
  isDisposable: boolean;
  isRoleAccount: boolean;
  verificationTime: number;
  error?: string;
  details: {
    mxServers: string[];
    smtpResponse?: string;
    responseCode?: number;
  };
}

// Confidence Scoring Types
export interface ConfidenceScoringRequest {
  email: string;
  domainConfidence: number;
  verificationResult: EmailVerificationResult;
  patternConfidence: number;
}

export interface ConfidenceScore {
  overall: number;
  breakdown: {
    syntax: number;      // 10% weight
    dns: number;         // 20% weight  
    smtp: number;        // 40% weight
    format: number;      // 30% weight
  };
  weightedScore: number;
  thresholdMet: boolean;
  actionable: boolean;
}

// CRM Integration Types
export interface ContactCreationRequest {
  institutionId: string;
  name: string;
  titleRaw?: string;
  titleNormalized?: string;
  tier?: number;
  email: string;
  phone?: string;
  linkedinUrl?: string;
  confidence: number;
  sourceData: {
    domainDiscovery: DomainDiscoveryResult;
    emailPattern: EmailPatternResult;
    verification: EmailVerificationResult;
    scoring: ConfidenceScore;
  };
}

export interface Contact {
  id: number;
  institutionId: number;
  name: string;
  titleRaw?: string;
  titleNormalized?: string;
  tier?: number;
  email: string;
  phone?: string;
  linkedinUrl?: string;
  confidence: number;
  createdAt: string;
  updatedAt: string;
}

// Signal Calculation Types
export interface FinancialData {
  institutionId: number;
  quarterEndDate: string;
  nonaccrualCre?: number;
  nonaccrualMf?: number;
  nonaccrualConstruction?: number;
  pastDue30_89Cre?: number;
  pastDue30_89Mf?: number;
  oreo?: number;
  netChargeoffsCre?: number;
  netChargeoffsMf?: number;
  netChargeoffsConstruction?: number;
  tier1Ratio?: number;
  riskWeightedAssets?: number;
}

export interface DistressSignalRequest {
  institutionId: number;
  currentQuarter: FinancialData;
  previousQuarter?: FinancialData;
  peerData?: FinancialData[];
}

export interface DistressSignal {
  institutionId: number;
  quarterEndDate: string;
  nonaccrualCreGrowthQoq?: number;
  oreoGrowthQoq?: number;
  chargeoffsGrowthQoq?: number;
  pastDue30_89CreGrowthQoq?: number;
  capitalRatioDeclining: boolean;
  peerMedianTier1?: number;
  distressScore: number; // 0-100
  reasonCodes: string[];
  severity: 'low' | 'medium' | 'high' | 'critical';
  createdAt: string;
  updatedAt: string;
}

// Batch Processing Types
export interface BatchJob {
  id: string;
  type: 'discovery' | 'verification' | 'enrichment' | 'signal' | 'integration';
  status: BatchJobStatus;
  input: any[];
  output: any[];
  progress: {
    total: number;
    processed: number;
    succeeded: number;
    failed: number;
  };
  metadata: Record<string, any>;
  startedAt: string;
  completedAt?: string;
  error?: string;
  createdBy: string;
}

export interface BatchJobRequest {
  type: BatchJob['type'];
  input: any[];
  priority?: number;
  metadata?: Record<string, any>;
}

// Unified Workflow Types
export interface UnifiedWorkflowRequest {
  bankName: string;
  institutionId?: string;
  contacts: Array<{
    name: string;
    title?: string;
    tier?: number;
  }>;
  priority?: 'high' | 'medium' | 'low';
  batchSize?: number;
}

export interface UnifiedWorkflowResult {
  workflowId: string;
  bankName: string;
  institutionId?: string;
  status: BatchJobStatus;
  results: {
    domainDiscovery?: DomainDiscoveryResult;
    emailPatterns?: EmailPatternResult[];
    verifiedContacts: Array<{
      contact: ContactCreationRequest;
      verification: EmailVerificationResult;
      scoring: ConfidenceScore;
      crmContact?: Contact;
    }>;
    distressSignals?: DistressSignal[];
  };
  summary: {
    totalContacts: number;
    verifiedContacts: number;
    highConfidenceContacts: number;
    crmContactsCreated: number;
    distressSignalsGenerated: number;
    overallConfidence: number;
  };
  timestamp: string;
}

// Zod Schemas for Validation
export const DomainDiscoveryRequestSchema = z.object({
  bankName: z.string().min(1),
  fdicCertNumber: z.string().optional(),
  rssdId: z.string().optional(),
  state: z.string().optional(),
  priority: z.enum(['high', 'medium', 'low']).default('medium'),
  forceRefresh: z.boolean().default(false),
  tiers: z.array(z.number().min(1).max(4)).optional(),
});

export const EmailVerificationRequestSchema = z.object({
  email: z.string().email(),
  verifyMx: z.boolean().default(true),
  verifySmtp: z.boolean().default(true),
  checkDisposable: z.boolean().default(true),
  checkRoleAccount: z.boolean().default(true),
});

export const ContactCreationRequestSchema = z.object({
  institutionId: z.string(),
  name: z.string().min(1),
  titleRaw: z.string().optional(),
  titleNormalized: z.string().optional(),
  tier: z.number().min(1).max(3).optional(),
  email: z.string().email(),
  phone: z.string().optional(),
  linkedinUrl: z.string().url().optional(),
  confidence: z.number().min(0).max(1),
  sourceData: z.object({
    domainDiscovery: z.any(),
    emailPattern: z.any(),
    verification: z.any(),
    scoring: z.any(),
  }),
});

export const BatchJobRequestSchema = z.object({
  type: z.enum(['discovery', 'verification', 'enrichment', 'signal', 'integration']),
  input: z.array(z.any()),
  priority: z.number().min(1).max(10).default(5),
  metadata: z.record(z.any()).optional(),
});

export const UnifiedWorkflowRequestSchema = z.object({
  bankName: z.string().min(1),
  institutionId: z.string().optional(),
  contacts: z.array(z.object({
    name: z.string().min(1),
    title: z.string().optional(),
    tier: z.number().min(1).max(3).optional(),
  })),
  priority: z.enum(['high', 'medium', 'low']).default('medium'),
  batchSize: z.number().min(1).max(1000).default(100),
});