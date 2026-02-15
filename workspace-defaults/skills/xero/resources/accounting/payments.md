# Payments


## Overview


| Property | Description |
| --- | --- |
| URL | [https://api.xero.com/api.xro/2.0/Payments](https://api.xero.com/api.xro/2.0/Payments) |
| Methods Supported | GET, PUT, POST |
| Description | Retrieve either one or many payments for invoices and credit notes <br>Apply payments to approved AR and AP invoices <br>Allow you to refund AR and AP credit notes <br>Delete (reverse) a payment <br>Allows you to refund spend and receive prepayments and overpayments <br>Allows you to retrieve history <br>Allows you to add notes |

To pay multiple AR or AP invoices in a single transaction use the BatchPayments endpoint.

### Multicurrency payments

A payment is multicurrency if the payment account, or the invoice paid against, are in a currency other than the base currency of the organisation. To understand how to correctly create and interpret multicurrency payments, refer to our multicurrency guidance.

## GET Payments


Use this method to retrieve either one or many payments for invoices, credit notes, overpayments or prepayments

| Field | Description |
| --- | --- |
| Date | Date the payment is being made (YYYY-MM-DD) e.g. 2009-09-06 |
| CurrencyRate | Exchange rate when payment is made or received. For non-multicurrency payments, has a value of 1. For multicurrency payments, see CurrencyRate meaning. |
| Amount | The amount of the payment in the currency of the Invoice the payment was made against. Must be less than or equal to the outstanding amount owing on the invoice e.g. 200.00 |
| BankAmount | The amount of the payment in the currency of the Account. This value is derived from the Amount and CurrencyRate. |
| Reference | An optional description for the payment e.g. Direct Debit |
| IsReconciled | An optional parameter for the payment. Conversion related apps can utilise the IsReconciled flag in scenarios when a matching bank statement line is not available. |
| Status | The status of the payment. |
| PaymentType | See Payment Types. |
| UpdatedDateUTC | UTC timestamp of last update to the payment |
| BatchPaymentID | Present if the payment was created as part of a batch. |
| BatchPayment | Details of the Batch the payment was part of. See Batch Payments for more details. |
| Account | The Account the payment was made from |
| Invoice | The Invoice the payment was made against |

### Optional parameters for GET Payments

| Field | Description |
| --- | --- |
| Record filter | You can specify an individual record by appending the PaymentID to the endpoint, i.e. <br>**GET [https://.../Payments/297c2dc5-cc47-4afd-8ec8-74990b8761e9](https://.../Payments/297c2dc5-cc47-4afd-8ec8-74990b8761e9)** |
| Modified After | The ModifiedAfter filter is actually an HTTP header: ‘If-Modified-Since‘. note payments created or modified since this timestamp will be returned e.g. 2009-11-12T00:00:00 |
| Where | Filter by any element ( _see Filters_ ). Only certain elements are optimised to ensure performance across organisations of all sizes. |
| Order | Order by any element returned ( _see Order By_ ). Only certain elements are optimised to ensure performance across organisations of all sizes. |
| page | 100 contacts will be returned per call as the default when the page parameter is used by itself e.g. page=1 |
| pageSize | Used with the page parameter. Up to 1000 contacts will be returned per call when the pageSize parameter is used e.g. page=1&pageSize=250. |

### High volume threshold limit

In order to make our platform more stable, we've added a high volume threshold limit for the GET Payments Endpoint.

- Requests that have more than 100k payments being returned in the response will be denied and receive a 400 response code
- Requests using unoptimised fields for filtering or ordering that result in more than 100k payments will be denied with a 400 response code

Please continue reading to find out how you can use paging and optimise your filtering to ensure your requests are always successful. Be sure to check out the Efficient Data Retrieval page for tips on query optimisation.

### Paging payments (recommended)

More information about retrieving paged resources.

### Optimised filtering using the where parameter

The most common filters have been optimised to ensure performance across organisations of all sizes. We recommend you restrict your filtering to the following optimised parameters.

#### Range Operators in Where clauses

Indicated fields also support the range operators: greater than, greater than or equals, less than, less than or equals (>, >=, <, <=).

Range operators can be combined with the AND operator to query a date range. eg where=Date>=DateTime(2020, 01, 01) AND Date<DateTime(2020, 02, 01)

_When using individually or combined with the AND operator:_

| Field | Operator | Query |
| --- | --- | --- |
| PaymentType | equals | where=PaymentType="ACCRECPAYMENT" |
| Status | equals | where=Status="AUTHORISED" |
| Date | equals, range | where=Date=DateTime(2020, 01, 01)<br>where=Date>DateTime(2020, 01, 01) |
| Invoice.InvoiceId | equals | where=Invoice.InvoiceID=guid("96988e67-ecf9-466d-bfbf-0afa1725a649") |
| Reference | equals | where=Reference="INV-0001" |

_When using with the OR operator:_

| Field | Operator | Query |
| --- | --- | --- |
| PaymentId | equals | where=PaymentID=guid("0a0ef7ee-7b91-46fa-8136-c4cc6287273a") OR PaymentID=guid("603b8347-d833-4e65-abf9-1f465652cb42") |
| Invoice.InvoiceId | equals | where=Invoice.InvoiceId=guid("0b0ef7ee-7b91-46fa-8136-c4cc6287273a") OR Invoice.InvoiceId=guid("693b8347-d833-4e65-abf9-1f465652cb42") |

**Example:** Retrieve all ACCRECPAYMENT payments with an AUTHORISED status

```
?where=PaymentType=="ACCRECPAYMENT" AND Status=="AUTHORISED"
```


This would translate to the following URL once encoded.

```
https://api.xero.com/api.xro/2.0/Payments?where=PaymentType%3D%3D%22ACCRECPAYMENT%22+AND+Status%3D%3D%22AUTHORISED%22%0D%0A
```


### Optimised ordering:

The following parameters are optimised for ordering:

- UpdatedDateUTC
- Date
- PaymentId

The default order is _UpdatedDateUTC ASC, PaymentId ASC_. Secondary ordering is applied by default using the PaymentId. This ensures consistency across pages.

The example below is fetching a payment on an AR invoice in the base currency of the organisation

```
GET https://api.xero.com/api.xro/2.0/Payments/b26fd49a-cbae-470a-a8f8-bcbc119e0379
```


```
{
  "Payments": [
    {
      "PaymentID": "b26fd49a-cbae-470a-a8f8-bcbc119e0379",
      "BatchPaymentID": "b54aa50c-794c-461b-89d1-846e1b84d9c0",
      "BatchPayment": {
        "Account": {
          "AccountID": "ac993f75-035b-433c-82e0-7b7a2d40802c"
        },
        "BatchPaymentID": "b54aa50c-794c-461b-89d1-846e1b84d9c0",
        "Date": "\/Date(1455667200000+0000)\/",
        "Type": "RECBATCH",
        "Status": "AUTHORISED",
        "TotalAmount": "600.00",
        "UpdatedDateUTC": "\/Date(1289572582537+0000)\/",
        "IsReconciled": "true",
        "DateString": "1970-01-01T00:00:00"
      },
      "Date": "\/Date(1455667200000+0000)\/",
      "BankAmount": 500.00,
      "Amount": 500.00,
      "Reference": "INV-0001",
      "CurrencyRate": 1.000000,
      "PaymentType": "ACCRECPAYMENT",
      "Status": "AUTHORISED",
      "UpdatedDateUTC": "\/Date(1289572582537+0000)\/",
      "HasAccount": true,
      "IsReconciled": true,
      "Account": {
        "AccountID": "ac993f75-035b-433c-82e0-7b7a2d40802c",
        "Code": "090",
        "Name": "Account Name"
      },
      "Invoice": {
        "Type": "ACCREC",
        "InvoiceID": "6a539484-ad93-47a4-a3f3-053fbb7a0606",
        "InvoiceNumber": "INV-0001",
        "Reference": "",
        "Payments": [],
        "CreditNotes": [],
        "Prepayments": [],
        "Overpayments": [],
        "AmountDue": 3.50,
        "AmountPaid": 7.00,
        "AmountCredited": 1.00,
        "SentToContact": false,
        "CurrencyRate": 1.0000000000,
        "IsDiscounted": false,
        "HasErrors": false,
        "Contact": {
          "ContactID": "39219d5e-a6cc-4bb3-a4a1-b2a5c44e6b1f",
          "Name": "mm",
          "ContactPersons": [],
          "HasValidationErrors": false
        },
        "DateString": "2025-02-26T00:00:00",
        "Date": "\/Date(1740528000000+0000)\/",
        "DueDateString": "2025-02-27T00:00:00",
        "DueDate": "\/Date(1740614400000+0000)\/",
        "BrandingThemeID": "e275691c-523d-409c-a10d-ccb6663142fc",
        "Status": "AUTHORISED",
        "LineAmountTypes": "Exclusive",
        "LineItems": [],
        "SubTotal": 10.00,
        "TotalTax": 1.50,
        "Total": 11.50,
        "UpdatedDateUTC": "\/Date(1742960734377+0000)\/",
        "CurrencyCode": "NZD"
      }
    }
  ]
}
```


The example below is fetching a collection of invoices without paging

```
GET https://api.xero.com/api.xro/2.0/Payments/
```


```
"Payments": [
    {
      "PaymentID": "fc09bdcf-6a17-4a60-9b60-8824553ca02a",
      "Date": "\/Date(1740787200000+0000)\/",
      "BankAmount": 1.00,
      "Amount": 1.00,
      "Reference": "Reference",
      "CurrencyRate": 1.0000000000,
      "PaymentType": "ACCRECPAYMENT",
      "Status": "AUTHORISED",
      "UpdatedDateUTC": "\/Date(1740556952543+0000)\/",
      "HasAccount": true,
      "IsReconciled": false,
      "Account": {
        "AccountID": "83cc3e90-0071-4636-9c00-9df055c524c9",
        "Code": "980"
      },
      "Invoice": {
        "Type": "ACCREC",
        "InvoiceID": "6a539484-ad93-47a4-a3f3-053fbb7a0606",
        "InvoiceNumber": "INV-0001",
        "Payments": [],
        "CreditNotes": [],
        "Prepayments": [],
        "Overpayments": [],
        "IsDiscounted": false,
        "InvoiceAddresses": [],
        "HasErrors": false,
        "Contact": {
          "ContactID": "39219d5e-a6cc-4bb3-a4a1-b2a5c44e6b1f",
          "Name": "mm",
          "Addresses": [],
          "Phones": [],
          "ContactGroups": [],
          "ContactPersons": [],
          "HasValidationErrors": false
        },
        "LineItems": [],
        "CurrencyCode": "NZD"
      },
      "HasValidationErrors": false
    }
]
```


Due to JSON serialization behavior, a null object may be represented as an empty array. As a result, an empty array does not necessarily indicate that the attribute has no value.

## PUT Payments


Use this method to apply payments to approved AR and AP invoices, refund AR or AP credit notes, refund spend or receive overpayments, or refund spend or receive prepayments.

Provide only one identifier object (Invoice, CreditNote, Prepayment, or Overpayment). Each object contains nested attributes (as described in the table below) that can be used to identify the document you are applying the payment to. It is essential that the nested attributes correspond to the chosen identifier object. Refer to the example below for correct usage.

| Field | Description |  |
| --- | --- | --- |
| **InvoiceID or CreditNoteID or PrepaymentID or OverpaymentID** | ID of the invoice, credit note, prepayment or overpayment you are applying payment to e.g. 297c2dc5-cc47-4afd-8ec8-74990b8761e9 |  |

Account

|  | Field | Description |
| --- | --- | --- |
| _either_ | AccountID | ID of account you are using to make the payment e.g. 294b1dc5-cc47-2afc-7ec8-64990b8761b8. This account needs to be either an account of type BANK or have enable payments to this accounts switched on (see GET Accounts) . See the edit account screen of your Chart of Accounts in Xero if you wish to enable payments for an account other than a bank account |
| _or_ | Code | Code of account you are using to make the payment e.g. 001 ( _note: not all accounts have a code value_) |

| Field |  | Description |
| --- | --- | --- |
| Date |  | Date the payment is being made (YYYY-MM-DD) e.g. 2009-09-06 |
| CurrencyRate |  | Exchange rate when payment is received. For how and when to set, see our multicurrency guide. |
| Amount |  | The amount of the payment in the currency of the Invoice the payment was made against. Must be less than or equal to the outstanding amount owing on the invoice e.g. 200.00 |
| Reference |  | An optional description for the payment e.g. Direct Debit |
| IsReconciled |  | A boolean indicating whether the payment has been reconciled. |
| Status |  | The status of the payment. |

### Example – single payment

Below is an example of applying a $32.06 payment to invoice OIT00545 from Account Code 001 on 8 Sept 2009.

```
{
  "Invoice": { "InvoiceID": "96df0dff-43ec-4899-a7d9-e9d63ef12b19" },
  "Account": { "Code": "001" },
  "Date": "2009-09-08",
  "Amount": 32.06
}
```


### Example – multiple payments

Below is an example of applying multiple payments to various Invoices (identified by InvoiceID) from various Accounts (identified by AccountID) across various dates.

```
{
  "Payments": [
    {
      "Invoice": { "InvoiceID": "96df0dff-43ec-4899-a7d9-e9d63ef12b19" },
      "Account": { "AccountID": "297c2dc5-cc47-4afd-8ec8-74990b8761e9" },
      "Date": "2009-07-13",
      "Amount": 3375.00
    },
    {
      "Invoice": { "InvoiceID": "0a1d0d71-b001-4c71-a260-31e77c9d4a92" },
      "Account": { "AccountID": "a65b0dac-b444-4b41-959b-c1580cd6268f" },
      "Date": "2009-09-01",
      "Amount": 393.75
    },
    {
      "Invoice": { "InvoiceID": "93c9be81-1df4-4338-b5dc-e67a89cd2d7c" },
      "Account": { "AccountID": "a65b0dac-b444-4b41-959b-c1580cd6268f" },
      "Date": "2009-07-21",
      "Amount": 398
    }
  ]
}
```


### Example – payments or refunds for different type

The following example demonstrates how to apply a payment to different types of accounting documents. Ensure that the correct object type is used for the corresponding document type (e.g., use CreditNoteID when applying a payment to a Credit Note).

```
{
  "Payments": [
    {
      "Invoice": { "InvoiceID": "96df0dff-43ec-4899-a7d9-e9d63ef12b19" },
      "Account": { "AccountID": "297c2dc5-cc47-4afd-8ec8-74990b8761e9" },
      "Date": "2009-07-13",
      "Amount": 3375.00
    },
    {
      "CreditNote": { "CreditNoteID": "8648fa8c-3d0c-4ea3-9f6b-3a3ec05d0e26" },
      "Account": { "Code": "090" },
      "Date": "2013-09-04",
      "Amount": 50.00,
      "Reference": "Full refund as we couldn't replace item"
    },
    {
      "Prepayment": { "PrepaymentID": "262c3049-cbf2-4b4b-9fca-60d55b076e35" },
      "Account": { "Code": "090" },
      "Date": "2015-03-25",
      "Amount": 100.00,
      "Reference": "Full refund as the customer cancelled their subscription"
    },
    {
      "Overpayment": { "OverpaymentID": "1ced4be7-ea6d-4f46-8279-4203e461de80" },
      "Account": { "Code": "090" },
      "Date": "2015-04-01",
      "Amount": 200.00,
      "Reference": "Refunded overpayment made by mistake"
    }
  ]
}
```


### Example – Creating a reconciled payment

Below is an example for applying an automatically reconciled payment to an invoice (useful for conversion purposes)

```
{
  "Invoice": { "InvoiceNumber": "OIT00619" },
  "Account": { "Code": "001" },
  "Date": "2009-09-08",
  "Amount": 20.00,
  "IsReconciled": true
}
```


### SummarizeErrors

If you are entering many payments in a single API call then we recommend you utilise our response format that shows validation errors for each invoice. Each Invoice will be returned with a status element that contains the value OK or ERROR. If an invoice has a error then one or more validation errors will be returned.

Example of the altered response format using the SummarizeErrors=false parameter

```
POST https://api.xero.com/api.xro/2.0/Payments?SummarizeErrors=false
```


```
{
  "Payments": [
    ...
    {
      "ValidationErrors": [
        {
          "Message": "...."
        }
      ]
    }
    ...
  ]
}
```


## POST Payments


Use this method to delete (reverse) payments to invoices, credit notes, prepayments & overpayments. Note that payments created via batch payments and receipts are not supported. Payments cannot be modified, only created and deleted.

### Required parameters for POST Payments

| Field | Description |
| --- | --- |
| PaymentID | The Xero identifier for an Payment e.g. 297c2dc5-cc47-4afd-8ec8-74990b8761e9 |

### Example – delete a payment

Below is an example of deleting a payment. In order to delete a payment, you must POST to the resource ID for the payment. e.g POST /Payments/b05466c8-dc54-4ff8-8f17-9d7008a2e44b

```
{
  "Status": "DELETED"
}
```


### Retrieving History

View a summary of the actions made by all users to the payment. See the History and Notes page for more details.

Example of retrieving a payment's history

```
GET https://api.xero.com/api.xro/2.0/Payments/{Guid}/History
```


```
{
  "HistoryRecords": [
     {
      "Changes": "Updated",
      "DateUTCString": "2018-02-28T21:02:11",
      "DateUTC": "\/Date(1519851731990+0000)\/",
      "User": "System Generated",
      "Details": "Received through the Xero API from ABC Org"
    },
    {
      "Changes": "Created",
      "DateUTCString": "2018-02-28T21:01:29",
      "DateUTC": "\/Date(1519851689297+0000)\/",
      "User": "Mac Haag",
      "Details": "INV-0041 to ABC Furniture for 100.00."
    }
    ...
  ]
}
```


### Add Notes to a Payment

Add a note which will appear in the history against a payment. See the History and Notes page for more details.

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
