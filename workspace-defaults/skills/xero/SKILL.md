---
name: xero
description: Xero API integration for accounting data including bank balances, invoices, bills, and financial reports. Use when the user asks about cash position, accounts receivable/payable, or any Xero financial data.
---

# Xero API Documentation

Reference documentation for Xero's APIs. Use when answering questions about Xero data, integrations, or API behavior.

## Authentication

Xero tokens expire every 30 minutes. **Always fetch a fresh token** from Balance before making API calls:

```python
import os
import requests

# Step 1: Get fresh Xero token from Balance's token proxy
BALANCE_API = os.environ.get("BALANCE_API_URL", "")
CLIENT_ID = os.environ.get("CLIENT_ID", "")
token_resp = requests.get(
    f"{BALANCE_API}/clients/{CLIENT_ID}/xero-token",
    timeout=10,
)
token_resp.raise_for_status()
xero_creds = token_resp.json()
ACCESS_TOKEN = xero_creds["access_token"]
TENANT_ID = xero_creds["tenant_id"]
```

If this returns 404, the client has no Xero connection. Tell the user to connect Xero first.

## Making API Calls

```python
# Step 2: Use the fresh token for Xero API calls
response = requests.get(
    "https://api.xero.com/api.xro/2.0/Reports/ProfitAndLoss",
    headers={
        "Authorization": f"Bearer {ACCESS_TOKEN}",
        "xero-tenant-id": TENANT_ID,
        "Accept": "application/json",
    }
)
data = response.json()
```

## API Modules

| Module | Description |
|--------|-------------|
| accounting | Core accounting: invoices, payments, contacts, bank transactions, credit notes, reports |
| assets | Fixed asset management, valuations, and depreciation |
| payrolluk | UK payroll: employees, payslips, leave, timesheets, tax |
| projects | Project time/cost tracking and profitability reporting |
| files | File/folder management and associations to invoices, contacts, payments |
| practice-manager-3-1 | Accountancy practice workflow, time tracking, job costing |
| xero-app-store | App subscriptions, pricing, and automated payment collection (UK/AU/NZ) |

## Key Concepts

- **Invoice Types**: ACCREC (sales invoices), ACCPAY (purchase bills)
- **Timestamps**: All dates in UTC, format YYYY-MM-DD
- **Currency**: ISO 4217 codes (GBP, USD, EUR, etc.)
- **Status Codes**: DRAFT → SUBMITTED → AUTHORISED → PAID/VOIDED

## Resources

See `resources/[module-name]/` for full API documentation. Start with `overview.md` in each module.
