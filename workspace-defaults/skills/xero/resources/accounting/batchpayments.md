# Batch Payments

## Overview


|  |  |
| --- | --- |
| URL | [https://api.xero.com/api.xro/2.0/BatchPayments](https://api.xero.com/api.xro/2.0/BatchPayments) |
| Methods Supported | GET, PUT, POST |
| Description | Create a batch payment <br>Retrieve batch payments |

Batch payments allow you to bundle multiple bills or invoices into one payment transaction. This means a single payment in Xero can be reconciled with a single transaction on the bank statement making for a much simpler bank reconciliation experience.

### Limitations of batch payments

- You can only make batch payments in the organisation base currency via the API
- You can’t create a batch payment with a mixture of sales invoices and bills
- You can’t include credit notes, prepayments or overpayments on batch payments

### Multicurrency batch payments

Although they cannot be created via the API, some parts of Xero do create multicurrency batch payments. Your system should identify and handle these appropriately:

- A batch payment is base currency if the account currency code, and all of the invoice currency codes are the same as the organisation's base currency, otherwise it is a multicurrency batch payment.
- For multicurrency batch payments the exchange rate for each payment can be calculated by comparing the Amount and BankAmount of the payment.

## GET BatchPayments


Use this method to retrieve batch payments

|  |  |
| --- | --- |
| Account | ID and the CurrencyCode of the account used to make the payment. This account needs to be either an account of type BANK or have 'enable payments to this account' switched on (see GET Accounts) |
| Particulars, Code, Reference | (NZ Only) Optional references for the batch payment transaction. It will also show with the batch payment transaction in the bank reconciliation Find & Match screen. Depending on your individual bank, the detail may also show on the bank statement you import into Xero. Max length =12. |
| Details | (Non-NZ Only) These details are sent to the org’s bank as a reference for the batch payment transaction. They will also show with the batch payment transaction in the bank reconciliation Find & Match screen. Depending on your individual bank, the detail may also show on the bank statement imported into Xero. Maximum field length = 18 |
| Narrative | (UK Only) Only shows on the statement line in Xero. Max length =18 |
| BatchPaymentID | The Xero generated identifier for the bank transaction (read-only and unique within organsiations) |
| Date | Date the payment is being made (YYYY-MM-DD) e.g. 2018-09-06 |
| Payments | The collection of one or more payments that make up the batch |
| Type | PAYBATCH for bill payments or RECBATCH for sales invoice payments (read-only) |
| Status | AUTHORISED or DELETED. New batch payments will have a status of AUTHORISED. |
| TotalAmount | The total of the payments that make up the batch in the currency of the account (read-only). This will match the sum of the BankAmount on each payment |
| IsReconciled | Booelan that tells you if the batch payment has been reconciled (read-only) |
| UpdatedDateUTC | UTC timestamp of last update to the payment |

Elements for Payments

|  |  |
| --- | --- |
| Invoice | The ID and CurrencyCode of the Invoice the payment was made against |
| PaymentID | The Xero generated unique identifier for the payment (read-only) |
| BankAccountNumber | The suppliers bank account number the payment is being made to |
| Particulars, Code & Reference | (NZ Only) The information to appear on the supplier's bank account and bank statement. |
| Details | The information to appear on the supplier's bank account. |
| Amount | The amount being paid in the currency of the invoice. It's rounded to 2DP and positive. |
| BankAmount | The absolute value of the amount being paid in the currency of the account (read-only). It will be rounded to 2DP. |

### Optional parameters for GET Batchpayments

|  |  |
| --- | --- |
| Record filter | You can specify an individual record by appending the BatchPaymentID to the endpoint, i.e. <br>**GET [https://.../BatchPayments/297c2dc5-cc47-4afd-8ec8-74990b8761e9](https://.../BatchPayments/297c2dc5-cc47-4afd-8ec8-74990b8761e9)** |
| Modified After | The ModifiedAfter filter is actually an HTTP header: ‘If-Modified-Since‘. note payments created or modified since this timestamp will be returned e.g. 2009-11-12T00:00:00 |
| Where | Filter by an any element ( _see Filters_ ) |
| order | Order by any element returned ( _see Order By_ ) |

### Optimised filtering using the where parameter

The most common filters have been optimised to ensure performance across organisations of all sizes. We recommend you restrict your filtering to the following optimised parameters.
_When using individually or combined with the AND operator:_

|  |  |  |
| --- | --- | --- |
| Type | equals | `where=Type="PAYBATCH"` |
| Account.AccountId | equals | `where=Account.AccountId=guid("13918178-849a-4823-9a31-57b7eac713d7")` |
| Status | equals | `where=Status="AUTHORISED"` |

### Optimised ordering:

The following parameters are optimised for ordering:

- BatchPaymentID
- UpdatedDateUTC
- Date

The default order is _UpdatedDateUTC ASC, BatchPaymentID ASC_. Secondary ordering is applied by default using the BatchPaymentID. This ensures consistency across pages.

Example response when retrieving an individual batch payment (NZ)

```
GET https://api.xero.com/api.xro/2.0/BatchPayments/54fb5c27-b2bc-4d54-a92f-a86b765d71c1
```


```
{
  "BatchPayments": [
    {
      "Account": {
        "AccountID": "13918178-849a-4823-9a31-57b7eac713d7",
        "CurrencyCode": "NZD"
      },
      "Reference": "ref",
      "BatchPaymentID": "44a1013e-4946-4a73-b207-dfe5424a5ea5",
      "DateString": "2018-10-03T00:00:00",
      "Date": "/Date(1538524800000+0000)/",
      "Payments": [
        {
          "Invoice": {
            "InvoiceID": "5aa9451d-95d1-4f95-a966-bbab2573f71c",
            "Payments": [],
            "CreditNotes": [],
            "Prepayments": [],
            "Overpayments": [],
            "HasErrors": false,
            "IsDiscounted": false,
            "LineItems": [],
            "CurrencyCode": "NZD"
          },
          "PaymentID": "a22a64cb-364e-43fa-9a1f-bb2cd1f4adde",
          "Reference": "ref/cheque",
          "Amount": 913.55,
          "BankAmount": 913.55
        },
        {
          "Invoice": {
            "InvoiceID": "30a87092-31b5-4a2c-831e-327486533dd2",
            "Payments": [],
            "CreditNotes": [],
            "Prepayments": [],
            "Overpayments": [],
            "HasErrors": false,
            "IsDiscounted": false,
            "LineItems": [],
            "CurrencyCode": "AUD"
          },
          "PaymentID": "6e20be79-32d8-4ae1-978e-f76d9b245c02",
          "Amount": 495,
          "BankAmount": 540
        },
        {
          "Invoice": {
            "InvoiceID": "86d6e00f-ef56-49f7-9a54-796ccd5ca057",
            "Payments": [],
            "CreditNotes": [],
            "Prepayments": [],
            "Overpayments": [],
            "HasErrors": false,
            "IsDiscounted": false,
            "LineItems": [],
            "CurrencyCode": "NZD"
          },
          "PaymentID": "4ba761b8-5940-4a3f-bcdf-7775adb00332",
          "Amount": 3080,
          "BankAmount": 3080
        }
      ],
      "Type": "RECBATCH",
      "Status": "AUTHORISED",
      "TotalAmount": 4533.55,
      "UpdatedDateUTC": "/Date(1538525239370+0000)/",
      "IsReconciled": false
    }
  ]
}
```


## PUT BatchPayments


Use this method to create batch payments

|  |  |
| --- | --- |
| Account | ID of the account used to make the payment. This account needs to be either an account of type BANK or have enable payments to this accounts switched on (see GET Accounts) |
| Particulars, Code, Reference | (NZ Only) Optional references for the batch payment transaction. It will also show with the batch payment transaction in the bank reconciliation Find & Match screen. Depending on your individual bank, the detail may also show on the bank statement you import into Xero. Max length =12. |
| Details | (Non-NZ Only) These details are sent to the org’s bank as a reference for the batch payment transaction. They will also show with the batch payment transaction in the bank reconciliation Find & Match screen. Depending on your individual bank, the detail may also show on the bank statement imported into Xero. Maximum field length = 18 |
| Narrative | (UK Only) Only shows on the statement line in Xero. Max length =18 |
| Date | Date the payment is being made (YYYY-MM-DD) e.g. 2018-09-06 |
| Payments | The collection of one or more payments that make up the batch |

Elements for Payments

|  |  |
| --- | --- |
| Invoice | The ID of the Invoice the payment was made against |
| BankAccountNumber | The suppliers bank account number the payment is being made to |
| Particulars, Code & Reference | (NZ Only) The information to appear on the supplier's bank account and bank statement. |
| Details | The information to appear on the supplier's bank account. |
| Amount | The amount being paid in the currency of the invoice. It must be a positive amount. |

Example request to create an ACCPAY batch payment (NZ)

```
PUT https://api.xero.com/api.xro/2.0/BatchPayments
```


```
{
  "Date": "2018-08-01",
  "Particulars": "paying",
  "Code": "333",
  "Reference": "ddd",
  "Account": {
    "AccountID": "ac993f75-035b-433c-82e0-7b7a2d40802c"
  },
  "Payments": [
    {
      "BankAccountNumber": "123-456-7890",
      "Particulars": "def",
      "Code": "543",
      "Reference": "ggg",
      "Invoice": {
        "InvoiceID": "d8ec835f-fef6-4d5c-ae41-28df59c57f11"
      },
      "Amount": 10
    },
    {
      "BankAccountNumber": "123-456-7890",
      "Particulars": "abc",
      "Code": "123",
      "Reference": "fff",
      "Invoice": {
        "InvoiceID": "71d1c9ca-3e99-4ef5-8f44-19d24c500ac8"
      },
      "Amount": 10
    }
  ]
}
```


Example request to create an ACCREC batch payment

```
PUT https://api.xero.com/api.xro/2.0/BatchPayments
```


```
{
  "Date": "2018-08-01",
  "Reference": "Particulars",
  "Account": {
    "AccountID": "ac993f75-035b-433c-82e0-7b7a2d40802c"
  },
  "Payments": [
    {
      "Reference": "Something",
      "Invoice": {
        "InvoiceID": "d8ec835f-fef6-4d5c-ae41-28df59c57f11"
      },
      "Amount": 100
    },
    {
      "Reference": "Something else",
      "Invoice": {
        "InvoiceID": "58ec1ad5-5f69-423c-b32e-706a29c13248"
      },
      "Amount": 200
    }
  ]
}
```


## POST BatchPayments


Use this method to update the status of a single batch payment to DELETED.

|  |  |
| --- | --- |
| BatchPaymentID | The Xero generated unique identifier for the bank transaction |
| Status | AUTHORISED or DELETED. New batch payments will have a status of AUTHORISED. |

Example request to delete a batch payment

```
POST https://api.xero.com/api.xro/2.0/BatchPayments
```


```
{
  "BatchPaymentID": "9bf296e9-0748-4d29-a3dc-24dde1098030",
  "Status": "DELETED"
}
```


Example request to delete a batch payment with ID in URL

```
POST https://api.xero.com/api.xro/2.0/BatchPayments/9bf296e9-0748-4d29-a3dc-24dde1098030
```


```
{
  "Status": "DELETED"
}
```


### Add Notes to a Batch Payment

Add a note which will appear in the history against a batch payment. See the History and Notes page for more details.

Example of creating a note against a payment

```
PUT https://api.xero.com/api.xro/2.0/Payments/{Guid}/History
```


```
{
  "HistoryRecords": [
    {
      "Details": "Note added by your favourite app!"
    }
    ...
  ]
}
```
