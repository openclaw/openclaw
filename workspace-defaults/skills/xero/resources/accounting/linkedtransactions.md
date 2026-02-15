# Linked Transactions (Billable Expenses)

## Overview


|  |  |
| --- | --- |
| URL | [https://api.xero.com/api.xro/2.0/LinkedTransactions](https://api.xero.com/api.xro/2.0/LinkedTransactions) |
| Methods Supported | GET, PUT, POST, DELETE |
| Description | Retrieve linked transactions (billable expenses) <br>Create linked transactions <br>Update linked transactions <br>Delete linked transactions |

The LinkedTransactions endpoint exposes the billable expenses functionality in Xero. The basic purpose is to link line items from a purchase transaction (e.g. ACCPAY invoice) to a customer and a sales transaction (e.g. ACCREC Invoice).

Read more about [Billable Expenses](http://help.xero.com/Billable-Expenses) in the Xero Help Centre or check out the demo below.

## GET LinkedTransactions


The following elements are returned in a GET response:

|  |  |
| --- | --- |
| LinkedTransactionID | The Xero generated identifier for a linked transaction (unique within organisations). |
| Status | The status of the linked transaction. This is derived from the statuses of the source and target transactions and cannot be explicitly set/updated. |
| Type | This will always be BILLABLEEXPENSE. More types may be added in future. |
| SourceTransactionID | The identifier of the source transaction (the purchase component of a billable expense). Either an invoice with a type of ACCPAY or a banktransaction of type SPEND. |
| SourceLineItemID | The line item identifier from the source transaction. |
| SourceTransactionTypeCode | The Type of the source tranasction. This will be ACCPAY if the linked transaction was created from an invoice and SPEND if it was created from a bank transaction. |
| ContactID | The identifier for the contact on the target transaction i.e. the customer that the expense is being billed on to. |
| TargetTransactionID | The identifier of the target transaction (the sale component of a billable expense). Currently, only invoices with a type of ACCREC can be a target transaction. |
| TargetLineItemID | The line item identifier from the target transaction. It is possible to link multiple billable expenses to the same TargetLineItemID. |
| UpdatedDateUTC | The last modified date in UTC format |

### Optional parameters for GET LinkedTransactions

|  |  |
| --- | --- |
| LinkedTransactionID | The Xero identifier for an Linked Transaction e.g. /LinkedTransactions/297c2dc5-cc47-4afd-8ec8-74990b8761e9 |
| Page | Up to 100 linked transactions will be returned in a single API call. Use the page parameter to specify the page to be returned e.g. page=1. |
| SourceTransactionID | Filter by the SourceTransactionID. Get all the linked transactions created from a particular ACCPAY invoice |
| ContactID | Filter by the ContactID. Get all the linked transactions that have been assigned to a particular customer. |
| ContactID & Status | Filter by the combination of ContactID and Status. Get all the linked transactions that have been assigned to a particular customer and have a particular status e.g. GET /LinkedTransactions?ContactID=4bb34b03-3378-4bb2-a0ed-6345abf3224e&Status=APPROVED. |
| TargetTransactionID | Filter by the TargetTransactionID. Get all the linked transactions allocated to a particular ACCREC invoice |

### Paging

Paging is enforced by default with a fixed page size of 100. To retrieve a particular page append a page parameter to the URL e.g. ?page=1. If there are 100 records in the response you will need to check if there is any more data by fetching the next page e.g ?page=2 and continuing this process until no more results are returned.

Example response for GET LinkedTransactions

```
GET https://api.xero.com/api.xro/2.0/LinkedTransactions
```


```
{
  "LinkedTransactions": [
    {
      "LinkedTransactionID": "2b921ac0-1ed9-4a61-bd67-706180f1bd94",
      "SourceTransactionID": "057df639-6632-4995-b0ac-00152e1c5092",
      "SourceLineItemID": "aa605236-49cc-4cf7-8c43-161def9bbf68",
      "ContactID": "a94c0f29-8924-4b05-b0e6-585ea1982faa",
      "TargetTransactionID": "147f3680-1b41-48ee-8c7f-61a656bbf49a",
      "TargetLineItemID": "14f06cf1-e2af-4825-8476-bb79f5ba503e",
      "Status": "BILLED",
      "Type": "BILLABLEEXPENSE",
      "UpdatedDateUTC": "2015-09-09T22:13:28",
      "SourceTransactionTypeCode": "SPEND"
    },
    {
      "LinkedTransactionID": "dc3c18e6-ab39-4d0e-8283-0609efa36145",
      "SourceTransactionID": "0465c7b5-69b8-4e55-8c32-af73eab9afba",
      "SourceLineItemID": "c92bf129-5da1-401c-8cf5-1508e92ee829",
      "Status": "DRAFT",
      "Type": "BILLABLEEXPENSE",
      "UpdatedDateUTC": "2015-09-09T23:43:54",
      "SourceTransactionTypeCode": "ACCPAY"
    }
  ]
}
```


## POST LinkedTransactions


Use this method to create or update linked transactions.

### Elements for Linked Transactions

_The following elements are **required** to create a linked transaction_

|  |  |
| --- | --- |
| SourceTransactionID | The identifier of the source transaction (the purchase component of a billable expense). Either an invoice with a type of ACCPAY or a banktransaction of type SPEND. |
| SourceLineItemID | The line item identifier from the source transaction. |

_The following elements are **optional** when creating or updating linked transactions_

|  |  |
| --- | --- |
| ContactID | The identifier for the contact on the target transaction i.e. the customer that the expense is being billed on to. |
| TargetTransactionID | The identifier of the target transaction (the sale component of a billable expense). Currently, only invoices with a type of ACCREC can be a target transaction. |
| TargetLineItemID | The line item identifier from the target transaction. It is possible to link multiple billable expenses to the same TargetLineItemID. |

Example request for creating a new linked transaction with source transaction details only (not assigned to a contact)

```
POST https://api.xero.com/api.xro/2.0/LinkedTransactions
```


```
{
  "SourceTransactionID": "0cfcc9f7-9166-4dae-9b7c-7d0f25663886",
  "SourceLineItemID": "da115c3b-41e5-4204-a7a3-082323197f9f"
}
```


Example request for creating a Linked Transaction assigned to a contact

```
POST https://api.xero.com/api.xro/2.0/LinkedTransactions
```


```
{
  "SourceTransactionID": "0cfcc9f7-9166-4dae-9b7c-7d0f25663886",
  "SourceLineItemID": "da115c3b-41e5-4204-a7a3-082323197f9f",
  "ContactID": "73d15ee0-27db-4352-ac8d-28463a2110f4"
}
```


Example request for creating a fully allocated linked transaction

```
POST https://api.xero.com/api.xro/2.0/LinkedTransactions
```


```
{
  "SourceTransactionID": "0cfcc9f7-9166-4dae-9b7c-7d0f25663886",
  "SourceLineItemID": "da115c3b-41e5-4204-a7a3-082323197f9f",
  "ContactID": "73d15ee0-27db-4352-ac8d-28463a2110f4",
  "TargetTransactionID": "2e926f7b-022c-44d3-8a9a-a5201dd37b61",
  "TargetLineItemID": "43c944b5-1556-42d6-aa35-b3a60f6c0a49"
}
```


Example request for updating a linked transaction to assign it to a contact

```
POST https://api.xero.com/api.xro/2.0/LinkedTransactions/c83947a9-5f57-47c4-bdb1-b77862207382
```


```
{
  "LinkedTransactionID": "c83947a9-5f57-47c4-bdb1-b77862207382",
  "ContactID": "73d15ee0-27db-4352-ac8d-28463a2110f4"
}
```


Example request for updating a linked transaction to allocate it to a target transaction

```
POST https://api.xero.com/api.xro/2.0/LinkedTransactions/c83947a9-5f57-47c4-bdb1-b77862207382
```


```
{
  "LinkedTransactionID": "c83947a9-5f57-47c4-bdb1-b77862207382",
  "TargetTransactionID": "2e926f7b-022c-44d3-8a9a-a5201dd37b61",
  "TargetLineItemID": "43c944b5-1556-42d6-aa35-b3a60f6c0a49"
}
```


## PUT LinkedTransactions


The PUT method is similar to the POST method however you can only create new linked transactions

## DELETE LinkedTransactions


The DELETE method is used to delete a Linked Transaction.

Example request to delete a linked transaction

```
DELETE https://api.xero.com/api.xro/2.0/LinkedTransactions/b05466c8-dc54-4ff8-8f17-9d7008a2e44b
```


## Billable Expenses Demo


A demonstration of the billable expenses functionality in Xero and the API [here](https://www.youtube.com/watch?v=9gwHEZudsNA&ab_channel=XeroDeveloper).
