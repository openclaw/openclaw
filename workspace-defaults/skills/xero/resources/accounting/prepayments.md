# Prepayments


## Overview


|  |  |
| --- | --- |
| URL | [https://api.xero.com/api.xro/2.0/Prepayments](https://api.xero.com/api.xro/2.0/Prepayments) |
| Methods Supported | GET, PUT, DELETE |
| Description | Allows you to retrieve prepayments Allows you to allocate prepayments to outstanding invoices <br>Allows you to retrieve history <br>Allows you to add notes |

Create prepayments using the BankTransactions endpoint.

Refund prepayments using the Payments endpoint.

## GET Prepayments


Use this method to retrieve prepayments.

Amounts are in the prepayment's currency.

|  |  |
| --- | --- |
| Type | See Prepayment Types |
| Contact | See Contacts |
| Date | The date the prepayment is created YYYY-MM-DD |
| Status | See Prepayment Status Codes |
| LineAmountTypes | See Prepayment Line Amount Types |
| LineItems | See Prepayment Line Items |
| SubTotal | The subtotal of the prepayment excluding taxes |
| Total Tax | The total tax on the prepayment |
| Total | The total of the prepayment(subtotal + total tax) |
| UpdatedDateUTC | UTC timestamp of last update to the prepayment |
| CurrencyCode | The currency that the prepayment has been raised in (see Currencies) |
| PrepaymentID | Xero generated identifier (unique within organisations) |
| CurrencyRate | For base currency prepayments, has a value of 1. For non-base-currency prepayments, see CurrencyRate meaning. |
| Reference | Returns Invoice # field. Reference field isn't available. |
| RemainingCredit | The remaining credit balance on the prepayment |
| Allocations |  |
| Payments | See Payments |
| HasAttachments | boolean to indicate if a prepayment has an attachment |

Elements for Line Items

|  |  |
| --- | --- |
| Description | Description needs to be at least 1 char long. A line item with just a description (i.e no unit amount or quantity) can be created by specifying just a Description element that contains at least 1 character |
| Quantity | LineItem Quantity |
| UnitAmount | Lineitem unit amount. By default, unit amount will be rounded to two decimal places. You can opt in to use four decimal places by adding the querystring parameter unitdp=4 to your query. See the Rounding in Xero guide for more information. |
| AccountCode | See Accounts |
| TaxType | Used as an override if the default Tax Code for the selected AccountCode is not correct – see TaxTypes. |
| TaxAmount | The tax amount is auto calculated as a percentage of the line amount (see below) based on the tax rate. This value can be overriden if the calculated TaxAmount is not correct. |
| LineAmount | If you wish to omit either of the Quantity or UnitAmount you can provide a LineAmount and Xero will calculate the missing amount for you. |
| Tracking | Optional Tracking Category – see Tracking. Any LineItem can have a maximum of 2 TrackingCategory elements. |

### Optional parameters for GET Prepayments

|  |  |
| --- | --- |
| PrepaymentID | You can specify an individual record by appending the PrepaymentID to the endpoint, i.e. `GET https://.../Prepayments/{identifier}` |
| Modified After | The ModifiedAfter filter is actually an HTTP header: ' **If-Modified-Since**'. A UTC timestamp (yyyy-mm-ddThh:mm:ss) . Only prepayments created or modified since this timestamp will be returned e.g. 2009-11-12T00:00:00 |
| Where | Filter by an any element ( _see Filters_ ) |
| order | Order by any element returned ( _see Order By_ ) |
| page | Up to 100 prepayments will be returned per call, with line items shown for each, when the page parameter is used e.g. page=1 |

Example response for retrieving Prepayments

```
GET https://api.xero.com/api.xro/2.0/Prepayments
```


```
{
  "Prepayments": [
    {
      "Contact": {
        "ContactID": "c6c7b870-bb4d-489a-921e-2f0ee4192ff9",
        "Name": "Mr Contact"
      },
      "Date": "\/Date(1222340661707+0000)\/",
      "Status": "PAID",
      "LineAmountTypes": "Inclusive",
      "SubTotal": "86.96",
      "TotalTax": "13.04",
      "Total": "100.00",
      "UpdatedDateUTC": "\/Date(1222340661707+0000)\/",
      "CurrencyCode": "NZD",
      "FullyPaidOnDate": "\/Date(1222340661707+0000)\/",
      "Type": "RECEIVE-PREPAYMENT",
      "PrepaymentID": "aea95d78-ea48-456b-9b08-6bc012600072",
      "CurrencyRate": "1.000000",
      "RemainingCredit": "0.00",
      "Allocations": [
        {
          "Amount": "100.00",
          "Date": "\/Date(1222340661707+0000)\/",
          "Invoice": {
            "InvoiceID": "87cfa39f-136c-4df9-a70d-bb80d8ddb975",
            "InvoiceNumber": "INV-0001"
          }
        }
      ],
      "HasAttachments": "false"
    }
  ]
}
```


## PUT Prepayments/{PrepaymentID}/Allocations


Use this endpoint to allocate part or full amounts of a prepayment to outstanding invoices.

### Elements for Allocations

|  |  |
| --- | --- |
| Invoice | the invoice the prepayment is being allocated against |
| AppliedAmount | the amount being applied to the invoice |
| Date | the date the prepayment is applied YYYY-MM-DD (read-only). This will be the latter of the invoice date and the prepayment date. |

Example request allocating $60.50 from an RECEIVE-PREPAYMENT to an outstanding ACCREC invoice

```
PUT https://api.xero.com/api.xro/2.0/Prepayments/b356e488-2678-4be4-ad4b-d294df2d48d6/Allocations
```


```
{
  "Amount": "60.50",
  "Invoice": {
    "InvoiceID": "f5832195-5cd3-4660-ad3f-b73d9c64f263"
  }
}
```


## Prepayments Demo


A demonstration of prepayments and overpayments including a walkthrough on how to create a prepayment and assign it to an invoice using the API can be found [here](https://youtu.be/YUfQjB150jk).

### Retrieving History

View a summary of the actions made by all users to the prepayments. See the History and Notes page for more details.

Example of retrieving a prepayment's history

```
GET https://api.xero.com/api.xro/2.0/Prepayments/{Guid}/History
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


### Add Notes to a Prepayment

Add a note which will appear in the history against a prepayment. See the History and Notes page for more details.

Example of creating a note against a prepayment

```
PUT https://api.xero.com/api.xro/2.0/Prepayments/{Guid}/History
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


## DELETE Prepayments


### Deleting Prepayments Allocations

The DELETE method can be used to delete Prepayments allocations. Note the Request URL needs to specify the allocation ID. You can obtain it from the GET request.

```
DELETE https://api.xero.com/api.xro/2.0/Prepayments/{PrepaymentID}/Allocations/{AllocationID}
```


Example response for deleting Prepayments allocation

```
{
  "AllocationID": "b12335f4-a1e5-4431-aeb4-488e5547558e",
  "Date": "\/Date(1481846400000+0000)\/",
  "Invoice": {
    "InvoiceID": "f5832195-5cd3-4660-ad3f-b73d9c64f263"
  },
  "IsDeleted": true
}
```
