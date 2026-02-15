# Overpayments


## Overview


Allows you to retrieve history

Allows you to add notes

|  |  |
| --- | --- |
| URL | [https://api.xero.com/api.xro/2.0/Overpayments](https://api.xero.com/api.xro/2.0/Overpayments) |
| Methods Supported | GET, PUT, DELETE |
| Description | Allows you to retrieve overpayments<br>Allows you to allocate overpayments to outstanding invoices |

Create Overpayments using the BankTransactions endpoint.

Refund Overpayments using the Payments endpoint

## GET Overpayments


Amounts are in the overpayment's currency.

Use this method to retrieve Overpayments

|  |  |
| --- | --- |
| Type | See Overpayment Types |
| Contact | See Contacts |
| Date | The date the overpayment was made YYYY-MM-DD |
| Status | See Overpayment Status Codes |
| LineAmountTypes | See Overpayment Line Amount Types |
| LineItems | See Overpayment Line Items |
| SubTotal | The subtotal of the overpayment excluding taxes |
| TotalTax | The total tax on the overpayment |
| Total | The total of the overpayment (subtotal + total tax) |
| UpdatedDateUTC | UTC timestamp of last update to the overpayment |
| CurrencyCode | Currency used for the overpayment |
| OverpaymentID | Xero generated identifier (unique within organisations) |
| CurrencyRate | For base currency invoices, has a value of 1. For non-base-currency invoices, see CurrencyRate meaning. |
| RemainingCredit | The remaining credit balance on the overpayment |
| Allocations | See Allocations |
| Payments | See Payments |
| HasAttachments | boolean to indicate if a overpayment has an attachment |

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

### Optional parameters for GET Overpayments

|  |  |
| --- | --- |
| OverpaymentID | You can specify an individual record by appending the OverpaymentID to the endpoint, i.e. `GET https://.../Overpayments/{identifier}` |
| Modified After | The ModifiedAfter filter is actually an HTTP header: ' **If-Modified-Since**'. A UTC timestamp (yyyy-mm-ddThh:mm:ss) . Only overpayments created or modified since this timestamp will be returned e.g. 2009-11-12T00:00:00 |
| Where | Filter by an any element ( _see Filters_ ) |
| order | Order by any element returned ( _see Order By_ ) |
| page | Up to 100 Overpayments will be returned per call, with line items shown for each, when the page parameter is used e.g. page=1 |

Example response for retrieving Overpayments

```
GET https://api.xero.com/api.xro/2.0/Overpayments
```


```
{
  "Overpayments": [
    {
      "Contact": {
        "ContactID": "c6c7b870-bb4d-489a-921e-2f0ee4192ff9",
        "Name": "Mr Contact"
      },
      "DateString": "2014-05-26T00:00:00",
      "Date": "\/Date(1401062400000+0000)\/",
      "Status": "PAID",
      "LineAmountTypes": "Inclusive",
      "SubTotal": "86.96",
      "TotalTax": "13.04",
      "Total": "100.00",
      "UpdatedDateUTC": "2015-03-29T23:43:01.097",
      "CurrencyCode": "NZD",
      "Type": "RECEIVE-OVERPAYMENT",
      "OverpaymentID": "aea95d78-ea48-456b-9b08-6bc012600072",
      "CurrencyRate": "1.000000",
      "RemainingCredit": "0.00",
      "Allocations": [
          {
          "AllocationID": "b12335f4-a1e5-4431-aeb4-488e5547558e"
          "Amount": "100.00",
          "DateString": "2014-05-26T00:00:00",
          "Date": "\/Date(1401062400000+0000)\/",
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


## PUT Overpayments/{OverpaymentID}/Allocations


Use this endpoint to allocate part or full amounts of an overpayment to outstanding invoices.

### Elements for Allocations

|  |  |
| --- | --- |
| Invoice | The invoice the overpayment is being allocated against |
| AppliedAmount | The amount being applied to the invoice |
| Date | The date the overpayment is applied YYYY-MM-DD (read-only). This will be the latter of the invoice date and the overpayment date. |

Example request allocating $60.50 from an RECEIVE-OVERPAYMENT to an outstanding ACCREC invoice

```
PUT https://api.xero.com/api.xro/2.0/Overpayments/b356e488-2678-4be4-ad4b-d294df2d48d6/Allocations
```


```
{
  "Amount": "60.50",
  "Invoice": {
    "InvoiceID": "f5832195-5cd3-4660-ad3f-b73d9c64f263"
  }
}
```


## Overpayments Demo


A demonstration of prepayments and overpayments including a walkthrough on how to create an overpayment and refund it using the API can be found [here](https://youtu.be/YUfQjB150jk).

### Retrieving History

View a summary of the actions made by all users to the overpayment. See the History and Notes page for more details.

Example of retrieving an overpayment's history

```
GET https://api.xero.com/api.xro/2.0/Overpayments/{Guid}/History
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


### Add Notes to an Overpayment

Add a note which will appear in the history against an overpayment. See the History and Notes page for more details.

Example of creating a note against a overpayment

```
PUT https://api.xero.com/api.xro/2.0/Overpayments/{Guid}/History
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


## DELETE Overpayments


### Deleting Overpayments Allocations

The DELETE method can be used to delete Overpayments allocations. Note the Request URL needs to specify the allocation ID. You can obtain it from the GET request.

```
DELETE https://api.xero.com/api.xro/2.0/Overpayments/{OverpaymentID}/Allocations/{AllocationID}
```


Example response for deleting Overpayments allocation

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
