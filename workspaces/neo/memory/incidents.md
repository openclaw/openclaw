# Incidents Log

## 2026-03-23: Virtualmin Port 3000 Validation Error

### Context

User's Virtualmin server shows validation errors when port 3000 is used for a custom application (likely Node.js).

### Root Cause

Virtualmin's validation system (`validate-domains`) only recognizes standard web ports (80/443). Custom ports like 3000 trigger validation failures. No configuration option exists to skip port-specific validation.

### Fix Applied

Recommended reverse proxy solution (Nginx/Apache) to properly integrate custom application with Virtualmin's expected architecture.

### Prevention

- Use reverse proxy for any non-standard port applications
- If custom ports needed, exclude `web` feature from validation: `virtualmin validate-domains --feature dns,email,db`

### References

- Daily log: `memory/2026-03-23.md`
- Virtualmin validate-domains docs: https://www.virtualmin.com/docs/development/api-programs/validate-domains/
