# Bank Transfers


## Overview


|  |  |
| --- | --- |
| URL | [https://api.xero.com/api.xro/2.0/BankTransfers](https://api.xero.com/api.xro/2.0/BankTransfers) |
| Methods Supported | GET, PUT |
| Description | Allows you to retrieve any bank transfers <br>Allows you to create bank transfers <br>Allows you to attach files to bank transfers <br>Allows you to retrieve history <br>Allows you to add notes |

## GET BankTransfers


The following elements are returned in the BankTransfers response

|  |  |
| --- | --- |
| FromBankAccount | See FromBankAccount below |
| ToBankAccount | See ToBankAccount below |
| Amount | The amount being transferred (in the currency of FromBankAccount) |
| Date | The date of the Transfer YYYY-MM-DD |
| BankTransferID | The identifier of the Bank Transfer (unique to organsiations) |
| CurrencyRate | The FromBankAccount to ToBankAccount Currency Rate. CAUTION: this is in different units to other endpoints that deal with CurrencyRates. This value will differ from the CurrencyRate of the underlying BankTransactions when FromBankAccount is not in the organisation's base currency. |
| FromBankTransactionID | The Bank Transaction ID for the source account |
| ToBankTransactionID | The Bank Transaction ID for the destination account |
| FromIsReconciled | The Bank Transaction boolean to show if it is reconciled for the source account |
| ToIsReconciled | The Bank Transaction boolean to show if it is reconciled for the destination account |
| Reference | The Reference for the transactions |
| HasAttachments | Boolean to indicate if a Bank Transfer has an attachment |
| CreatedDateUTC | UTC timestamp of creation date of bank transfer |

Elements for FromBankAccount and ToBankAccount

|  |  |
| --- | --- |
| Code | The Account Code of the Bank Account |
| AccountID | The ID of the Bank Account |
| Name | The Name Bank Account |

### Optional parameters

|  |  |
| --- | --- |
| **Record filter** | You can specify an individual record by appending the BankTransferID to the endpoint, i.e. <br>**GET [https://.../BankTransfers/297c2dc5-cc47-4afd-8ec8-74990b8761e9](https://.../BankTransfers/297c2dc5-cc47-4afd-8ec8-74990b8761e9)** |
| Modified After | The ModifiedAfter filter is actually an HTTP header: ' **If-Modified-Since**'. <br>A UTC timestamp (yyyy-mm-ddThh:mm:ss) . Only bank transfers created or modified since this timestamp will be returned e.g. 2009-11-12T00:00:00 |
| Where | Filter by an any element ( _see Filters_ ) |
| order | Order by any element returned ( _see Order By_ ) |

Example response when retrieving all BankTransfers

```
GET https://api.xero.com/api.xro/2.0/BankTransfers
```


```
{
  "BankTransfers": [
    ...
    {
      "BankTransferID": "d79f3e07-5f11-45e4-9d1a-30be536d0e13",
      "CreatedDateUTCString": "2018-02-15T04:22:42",
      "CreatedDateUTC": "\/Date(1518668562850+0000)\/",
      "DateString": "2018-01-25T00:00:00",
      "Date": "\/Date(1516838400000+0000)\/",
      "FromBankAccount": {
        "AccountID": "ac993f75-035b-433c-82e0-7b7a2d40802c",
        "Name": "Business Bank Account"
      },
      "ToBankAccount": {
        "AccountID": "ebd06280-af70-4bed-97c6-7451a454ad85",
        "Name": "Business Savings Account"
      },
      "Amount": "20.00",
      "FromBankTransactionID": "b11794bc-775b-4f78-9b28-8f13240082ff",
      "ToBankTransactionID": "f589fb5e-34b3-4392-8207-4ba5a093eae",
      "FromIsReconciled": "true",
      "ToIsReconciled": "true",
      "Reference": "Sub 098801"
    }
  ...
  ]
}
```


Example response when retrieving a single BankTransfer

```
GET https://api.xero.com/api.xro/2.0/BankTransfers/f589fb5e-34b3-4392-8207-4ba5a093ea6e
```


```
{
  "BankTransfers": [{
      "BankTransferID": "f589fb5e-34b3-4392-8207-4ba5a093ea6e",
      "CreatedDateUTCString": "2018-02-15T04:22:42",
      "CreatedDateUTC": "\/Date(1518668562850+0000)\/",
      "DateString": "2018-01-25T00:00:00",
      "Date": "\/Date(1516838400000+0000)\/",
      "FromBankAccount": {
        "AccountID": "ac993f75-035b-433c-82e0-7b7a2d40802c",
        "Code": "090",
        "Name": "Business Bank Account"
      },
      "ToBankAccount": {
        "AccountID": "ebd06280-af70-4bed-97c6-7451a454ad85",
        "Code": "091",
        "Name": "Business Savings Account"
      },
      "Amount": "20.00",
      "FromBankTransactionID": "b11794bc-775b-4f78-9b28-8f13240082ff",
      "ToBankTransactionID": "f589fb5e-34b3-4392-8207-4ba5a093ea6e",
      "FromIsReconciled": "true",
      "ToIsReconciled": "true",
      "Reference": "Sub 098801",
      "CurrencyRate": "1.000000"
    }]
}
```


## PUT BankTransfers


Use this method to create a bank transfer

- The two sides of each bank transfer will automatically be recorded as RECEIVE-TRANSFER and SPEND-TRANSFER types in the GET BankTransactions endpoint
- The BankTransationIDs are returned in responses for successful PUTs.

Note the following functionality is not currently supported

- You cannot transfer between accounts in different currencies

_The following are **required** to create a bank transfer_

|  |  |
| --- | --- |
| FromBankAccount | See FromBankAccount below |
| ToBankAccount | See ToBankAccount below |
| Amount | The amount being transferred (in the currency of FromBankAccount) |

_The following are **optional** to create a bank transfer_

|  |  |
| --- | --- |
| Date | The date of the Transfer YYYY-MM-DD. Defaults to current date. |
| FromIsReconciled | The Bank Transaction boolean to show if it is reconciled for the source account. |
| ToIsReconciled | The Bank Transaction boolean to show if it is reconciled for the destination account. |
| Reference | The Reference for the transactions. |

Elements for FromBankAccount and ToBankAccount

|  |  |
| --- | --- |
| Code | The Account Code of the Bank Account. If Code is not included then AccountID is required. |
| AccountID | The ID of the Bank Account. If AccountID is not included then Code is required. |

Example of creating a bank transfer between accounts

```
PUT https://api.xero.com/api.xro/2.0/BankTransfers
```


```
{
  "BankTransfers": [{
    "FromBankAccount": { "Code": "090" },
    "ToBankAccount": { "Code": "091" },
    "Amount": 20.00
  }]
}
```


### Uploading an Attachment

You can upload up to 10 attachments (each up to 25mb in size) per bank transfer, once the bank transfer has been created in Xero. To do this you'll need to know the ID of the bank transfer which you'll use to construct the URL when POST/PUTing a byte stream containing the attachment file. e.g. [https://api.xero.com/api.xro/2.0/BankTransfers/](https://api.xero.com/api.xro/2.0/BankTransfers/) _f0ec0d8c-6fce-4330-bb3b-8306278c6fd8_/Attachments/ _image.png_. See the Attachments page for more details.

Example of uploading an attachment

```
POST /api.xro/2.0/BankTransfers/f0ec0d8c-4330-bb3b-83062c6fd8/Attachments/Image002932.png
```


```
Headers:
Authorization: Bearer...
Content Type: image/png
Content-Length: 10293
Body:
{RAW-IMAGE-CONTENT}
```


### Retrieving History

View a summary of the actions made by all users to the bank transfer. History for bank transfers can be accessed via bank transactions endpoint. See the History and Notes page for more details.

Example retrieving the history of a bank transfer

```
GET https://api.xero.com/api.xro/2.0/BankTransactions/{Guid}/History
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


### Add Notes to a Bank Transfer

Add a note which will appear in the history against a bank transfer. Note can be added to a bank tranfer via the bank transactions endpoint. See the History and Notes page for more details.

Example of creating a note against a bank transfer

```
PUT https://api.xero.com/api.xro/2.0/BankTransactions/{Guid}/History
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
