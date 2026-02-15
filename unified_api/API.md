# Unified API Documentation

The Unified API provides a centralized interface for domain discovery, email verification, and CRM integration workflows.

## Base URL
`/api/v1`

## Authentication
Currently uses a shared API key or JWT (configurable).

## Endpoints

### Health Check
`GET /health`
Returns the status of the API and its components.

### Batch Jobs
Manage long-running discovery and verification tasks.

#### Create Job
`POST /jobs`
Body: `BatchJobRequest`

#### Get Job Status
`GET /jobs/:id`

#### List Jobs
`GET /jobs?type=discovery&status=pending`

#### Cancel Job
`POST /jobs/:id/cancel`

### Domain Discovery
Discover domains for a bank or institution.

#### Discover Domains
`POST /discovery`
Body: `DomainDiscoveryRequest`

### Email Verification
Verify email addresses for validity and deliverability.

#### Verify Email
`POST /email/verify`
Body: `EmailVerificationRequest`

## Models

### BatchJob
```json
{
  "id": "uuid",
  "type": "discovery",
  "status": "pending",
  "progress": {
    "total": 100,
    "processed": 45,
    "succeeded": 40,
    "failed": 5
  },
  "createdAt": "iso-timestamp"
}
```

## Error Handling
The API uses standard HTTP status codes and returns a structured error response:
```json
{
  "success": false,
  "error": "Detailed error message",
  "timestamp": "iso-timestamp"
}
```
