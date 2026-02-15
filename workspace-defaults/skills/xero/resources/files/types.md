# Types and Codes

## Overview


Below is a detailed list of all the types and codes the Files API uses:

## Objects


### Object Groups

Object Groups indicate the Accounting API endpoint to be used to retrieve the detail of the object. Not all objects are available via the Accounting API.

|  |  |
| --- | --- |
| **Object Group** | **Accounting API Endpoint** |
| Account | Accounts |
| BankTransaction | Bank Transactions |
| Contact | Contacts |
| CreditNote | Credit Notes |
| FixedAsset | Assets |
| Invoice | Invoices |
| Item | Items |
| ManualJournal | Manual Journals |
| Overpayment | Overpayments |
| Payment | Payments |
| Payrun | Not yet available |
| Prepayment | Prepayments |
| PurchaseOrder | Not yet available |
| Quote | Quotes |
| Receipt | Receipts |
| Reconciliation | Not yet available |

### Object Types

Object types are a more specific code for the object (e.g. differentiates between sales and purchases invoices).

|  |  |
| --- | --- |
| **Object Type** | **Description** |
| ACCOUNT | Account |
| ACCPAY | Purchases Invoice |
| ACCPAYCREDIT | Purchases Credit Note |
| ACCPAYPAYMENT | Payment on a Purchases Invoice |
| ACCREC | Sales Invoice |
| ACCRECCREDIT | Sales Credit Note |
| ACCRECPAYMENT | Payment on a sales invoice |
| ADJUSTMENT | Reconciliation adjustment |
| APCREDITPAYMENT | Payment on a purchases credit note |
| APOVERPAYMENT | Purchases overpayment |
| APOVERPAYMENTPAYMENT | Purchases overpayment |
| APOVERPAYMENTSOURCEPAYMENT | The bank transaction part of a purchases overpayment |
| APPREPAYMENT | Purchases prepayment |
| APPREPAYMENTPAYMENT | Purchases prepayment |
| APPREPAYMENTSOURCEPAYMENT | The bank transaction part of a purchases prepayment |
| ARCREDITPAYMENT | Payment on a sales credit note |
| AROVERPAYMENT | Sales overpayment |
| AROVERPAYMENTPAYMENT | Sales overpayment |
| AROVERPAYMENTSOURCEPAYMENT | The bank transaction part of a sales overpayment |
| ARPREPAYMENT | Sales prepayment |
| ARPREPAYMENTPAYMENT | Sales prepayment |
| ARPREPAYMENTSOURCEPAYMENT | The bank transaction part of a sales prepayment |
| CASHPAID | A spend money transaction |
| CASHREC | A receive money transaction |
| CONTACT | Contact |
| EXPPAYMENT | Expense claim payment |
| FIXEDASSET | Fixed Asset |
| MANUALJOURNAL | Manual Journal |
| PAYRUN | Payrun |
| PRICELISTITEM | Item |
| PURCHASEORDER | Purchase order |
| RECEIPT | Expense receipt |
| SALESQUOTE | Quote |
| TRANSFER | BankTransfer |
