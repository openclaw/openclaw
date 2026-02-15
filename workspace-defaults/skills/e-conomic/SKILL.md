---
name: e-conomic
description: E-conomic accounting API (Danish ERP). Use for financial questions - cash, invoices, payments, customer/supplier data, journal entries.
---

# E-conomic API

Danish accounting system by Visma. Two separate REST APIs exist - choosing the right one is critical.

**Read-only access** — cannot create, update, or delete records.

## Authentication

Both APIs use identical headers:
- `X-AppSecretToken`: `os.environ["ECONOMIC_APP_SECRET_TOKEN"]`
- `X-AgreementGrantToken`: `os.environ["ECONOMIC_AGREEMENT_GRANT_TOKEN"]`
- `Content-Type`: `application/json`

## Two APIs

| API | Base URL | Use For |
|-----|----------|---------|
| **Legacy REST** | `https://restapi.e-conomic.com` | Core data: customers, suppliers, invoices, accounts, entries |
| **Modular** | `https://apis.e-conomic.com/{module}api/v{version}/` | Specialized: dimensions, documents, invoice lines |

**Default to Legacy REST** - it has richer data (balances, PDF links, embedded relations).

## API Routing

| Task | API | Endpoint |
|------|-----|----------|
| **Period totals (monthly revenue, expenses)** | Legacy | `/accounting-years/{year}/periods/{period}/totals?pagesize=1000` |
| **Annual account totals (year-end balance sheet)** | Legacy | `/accounting-years/{year}/totals?pagesize=1000` |
| Transaction entries (line-level detail) | Legacy | `/accounting-years/{year}/entries` |
| Period entries (line-level detail) | Legacy | `/accounting-years/{year}/periods/{period}/entries` |
| Customer list/balances | Legacy | `/customers` |
| Supplier list | Legacy | `/suppliers` |
| Unpaid invoices (AR) | Legacy | `/invoices/unpaid` |
| Invoice PDF | Legacy | `/invoices/booked/{n}` → `pdf.download` |
| Account balances (current live, no date filter) | Legacy | `/accounts` |
| Invoice line items | Modular | `q2capi/v5.0.0/invoices/booked/lines` |
| Cost center data | Modular | `dimensionsapi/v5.0.4/dimension-data/booked-entries` |
| Attached documents | Modular | `documentsapi/v2.1.0/AttachedDocuments` |
| Bulk entry export | Modular | `bookedEntriesapi/v3.2.1/booked-entries` |

## Entry Types

The `/accounting-years/{year}/entries` endpoint returns journal entries with different `entryType` values:

| entryType | Meaning |
|-----------|---------|
| `customerInvoice` | Amounts billed to customers (debits to AR) |
| `customerPayment` | Amounts received from customers (credits to AR) |
| `supplierInvoice` | Amounts owed to suppliers (credits to AP) |
| `supplierPayment` | Amounts paid to suppliers (debits to AP) |
| `financeVoucher` | Manual journal entries |

Note: Payment entries have negative `amount` values (credits). Use `abs(amount)` when summing cash received/paid.

## Current vs Historical Balances

`/accounts` = cumulative through today. `/accounting-years/{year}/totals` = cumulative through year-end.

For partial year (Q1, Q3, etc.): sum relevant periods from `/accounting-years/{year}/periods/{period}/totals`.

<example>
"Liquidity ratio at end of 2025" → use `/accounting-years/2025/totals`, not `/accounts` (which includes 2026 activity).
</example>

## Best Practices

**Pagination**: All collection endpoints can return more results than fit on one page. Use `?pagesize=1000` and always loop until `pagination.nextPage` is `None`:
```python
all_items = []
url = f"{BASE_URL}/accounting-years/{year}/totals?pagesize=1000"
while url:
    data = requests.get(url, headers=headers).json()
    all_items.extend(data.get("collection", []))
    url = data.get("pagination", {}).get("nextPage")
```


**Using period endpoints**: The `{period}` parameter is a `periodNumber` (integer, sequentially numbered from when the company's books start—not month number). To find it:
1. List periods: `GET /accounting-years/{year}/periods`
2. Each period has `periodNumber`, `fromDate`, `toDate`
3. Match your target date range to find the period number
4. Use that number: `/accounting-years/{year}/periods/{periodNumber}/totals`

**Currency awareness**: Entries may be recorded in foreign currencies (EUR, USD, GBP, etc.). Each entry has:
- `amount` — value in the original transaction currency
- `amountInBaseCurrency` — value converted to the agreement's base currency (typically DKK)

## Response Patterns

**Legacy REST**: `{"collection": [...], "pagination": {"results": N, "nextPage": "..."}}`
- Pagination: `?pagesize=1000&skippages=0` (default varies: `/entries` defaults to 1000, `/totals` defaults to 20)
- Filtering: `?filter=date$gte:2025-01-01$and:accountNumber$gt:3000`

**Modular APIs**: `{"items": [...], "cursor": "..."}`
- Pagination: `?cursor=<value>` (use `/count` endpoint for totals)

## Field Name Differences

| Legacy | Modular |
|--------|---------|
| `accountNumber` | `number` |
| `customerNumber` | `number` |
| `fromDate` | `dateFrom` |
| `closed` | `isClosed` |
| `collection` | `items` |

## Critical Gotchas

1. **4xx errors**: Retry (credentials are valid)
2. **`/entries` returns nothing** — Must use `/accounting-years/{year}/entries`
3. **`/invoices` is an index** — Returns links only. Use `/invoices/booked`, `/invoices/unpaid`, etc.
4. **Response keys differ** — Legacy: `data["collection"]`, Modular: `data["items"]`
5. **Pagination differs** — Legacy has `results` count, Modular needs separate `/count` call
6. **Multi-currency entries** — amount is in the entry's original currency; amountInBaseCurrency is the DKK equivalent


## Modular API Resources

| Module | OpenAPI Spec | Key Endpoints |
|--------|--------------|---------------|
| accounts | `resources/accounts.json` | `/Accounts`, `/KeyFigureCodes` |
| bookedentries | `resources/bookedentries.json` | `/booked-entries` |
| dimensions | `resources/dimensions.json` | `/dimension-data/booked-entries` |
| documents | `resources/documents.json` | `/AttachedDocuments` |
| journals | `resources/journals.json` | `/draft-entries`, `/accruals` |
| q2c | `resources/q2c.json` | `/invoices/booked/lines` |
| customers | `resources/customers.json` | `/Contacts`, `/DeliveryLocations` |
| suppliers | `resources/suppliers.json` | `/Contacts`, `/Groups` |

## Resources

**Read the OpenAPI specs in `resources/*.json` for endpoint details, request/response schemas, and parameters.**

Legacy REST API endpoints are not documented in resource files - use the routing table above.
