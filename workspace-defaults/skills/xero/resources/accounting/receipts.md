# Receipts (Deprecated)

**Important Update – October 2018:** Last year, we announced the arrival of our new [Xero Expenses](https://www.xero.com/blog/2017/09/say-hello-new-xero-expense-claims/) product. Access to classic expense claims functionality is only available to customers who used it in the 6 months prior to 10 July 2018.

If you're planning on building a new expenses integration we suggest you create ACCPAY Invoices (bills) in Xero instead of using ExpenseClaims and Receipts.


## Overview


|  |  |
| --- | --- |
| URL | [https://api.xero.com/api.xro/2.0/Receipts](https://api.xero.com/api.xro/2.0/Receipts) |
| Methods Supported | GET, PUT, POST |
| Description | Allows you to retrieve draft expense claim receipts for any user <br>Allows you to add or update draft expense claim receipts <br>Allows you to attach images to draft expense claim receipts <br>Allows you to delete draft expense claim receipts <br>Allows you to retrieve history <br>Allows you to add notes |

## GET Receipts


Use this method to retrieve either one or many draft receipts.

### Elements for Receipts

|  |  |
| --- | --- |
| Date | Date of receipt – YYYY-MM-DD |
| Contact | See Contacts |
| Lineitems | The LineItems element can contain any number of individual LineItem sub-elements. |
| User | The user in the organisation that the expense claim receipt is for. See Users |
| Reference | Additional reference number |
| LineAmountTypes | See Line Amount Types |
| SubTotal | Total of receipt excluding taxes |
| TotalTax | Total tax on receipt |
| Total | Total of receipt tax inclusive (i.e. SubTotal + TotalTax) |
| ReceiptID | Xero generated identifier for receipt (unique within organisations) |
| Status | Current status of receipt – see status types |
| ReceiptNumber | Xero generated sequence number for receipt in current claim for a given user |
| UpdatedDateUTC | Last modified date UTC format |
| HasAttachments | boolean to indicate if a receipt has an attachment |
| Url | URL link to a source document – shown as "Go to `[appName]`" in the Xero app |

Elements for Line Items

|  |  |
| --- | --- |
| Description | Description needs to be at least 1 char long. A line item with just a description (i.e no unit amount or quantity) can be created by specifying just a Description element that contains at least 1 character |
| UnitAmount | Lineitem unit amount. By default, unit amount will be rounded to two decimal places. You can opt in to use four decimal places by adding the querystring parameter unitdp=4 to your query. See the Rounding in Xero guide for more information. |
| AccountCode | AccountCode must be active for the organisation. AccountCodes can only be applied to a receipt when the ShowInExpenseClaims value is true. Bank Accounts can not be applied to receipts. |
| Quantity | LineItem Quantity |
| TaxType | Used as an override if the default Tax Code for the selected AccountCode is not correct – see TaxTypes. |
| LineAmount | If you wish to omit either of the Quantity or UnitAmount you can provide a LineAmount and Xero will calculate the missing amount for you |
| Tracking | Optional Tracking Category – see Tracking. Any LineItem can have a maximum of 2 TrackingCategory elements. You must use the Name and Option elements instead of the TrackingCategoryID and TrackingOptionID fields. |
| DiscountRate | Percentage discount being applied to a line item. _Vote [here](http://xero.uservoice.com/forums/5528-xero-api/suggestions/2755003-apply-discounts-to-line-items) to be able to create discounts via the API._ |

### Optional parameters

|  |  |
| --- | --- |
| ReceiptID | You can specify an individual record by appending the ReceiptID to the endpoint, i.e. **GET [https://.../Receipts/{identifier](https://.../Receipts/%7Bidentifier)}** |
| Modified After | The ModifiedAfter filter is actually an HTTP header: ' **If-Modified-Since**'. <br>A UTC timestamp (yyyy-mm-ddThh:mm:ss) . Only receipts created or modified since this timestamp will be returned e.g. 2009-11-12T00:00:00 |
| Where | Filter by an any element ( _see Filters_ ) |
| order | Order by any element returned ( _see Order By_ ) |

Example response retrieving an individual receipt

```
GET https://api.xero.com/api.xro/2.0/Receipts/e59a2c7f-1306-4078-a0f3-73537afcbba9
```


```
{
  "Receipts": [
    {
      "ReceiptID": "e59a2c7f-1306-4078-a0f3-73537afcbba9",
      "ReceiptNumber": "6",
      "Status": "DRAFT",
      "User": {
        "UserID": "c81045b2-5740-4aea-bf8a-3956941af387",
        "FirstName": "John",
        "LastName": "Smith"
      },
      "Contact": {
        "ContactID": "ee9619df-7419-446d-af3d-6becf72d9e64",
        "ContactStatus": "ACTIVE",
        "Name": "Faster Taxis",
        "Addresses": [
          { "AddressType": "POBOX" },
          { "AddressType": "STREET" }
        ],
        "Phones": [
          { "PhoneType": "MOBILE" },
          { "PhoneType": "FAX" },
          { "PhoneType": "DDI" },
          { "PhoneType": "DEFAULT" }
        ],
        "UpdatedDateUTC": "\/Date(1222340661707+0000)\/"
      },
      "Date": "\/Date(1487808000000+0000)\/",
      "UpdatedDateUTC": "\/Date(1466787321930+0000)\/",
      "LineAmountTypes": "Inclusive",
      "LineItems": [
        {
          "Description": "Cab to Airport",
          "UnitAmount": "18.62",
          "TaxType": "INPUT2",
          "TaxAmount": "2.43",
          "LineAmount": "18.62",
          "AccountCode": "420",
          "Quantity": "1.0000"
        }
      ],
      "SubTotal": "16.19",
      "TotalTax": "2.43",
      "Total": "18.62",
      "HasAttachments": "false"
    }
  ]
}
```


Example response retrieving a collection of receipts

```
GET https://api.xero.com/api.xro/2.0/Receipts
```


```
{
  "Receipts": [
    {
      "ReceiptID": "b7072163-84e5-4501-a7bd-2849927980c0",
      "ReceiptNumber": "1",
      "User": {
        "UserID": "c81045b2-5740-4aea-bf8a-3956941af387",
        "FirstName": "John",
        "LastName": "Smith"
      },
      "Contact": {
        "ContactID": "7f71b205-4ad9-4779-8479-60f46e91fa5c",
        "Name": "City Coffeeworks"
      },
      "Date": "\/Date(1487808000000+0000)\/",
      "UpdatedDateUTC": "\/Date(1466787321930+0000)\/",
      "LineAmountTypes": "Inclusive",
      "SubTotal": "3.30",
      "TotalTax": "0.50",
      "Total": "3.80",
      "HasAttachments": "false"
    }
    ...
  ]
}
```


## POST Receipts


Use this method to create or update DRAFT receipts.

### Elements for Receipts

_The following are **mandatory** for a PUT / POST request_

|  |  |
| --- | --- |
| Date | Date of receipt – YYYY-MM-DD |
| Contact | See Contacts |
| Lineitems | At least _**one**_ line item is required to create a complete receipt. |
| User | The user in the organisation that the expense claim receipt is for. See Users |

_The following are **optional** for a PUT / POST request_

|  |  |
| --- | --- |
| Reference | Additional reference number |
| LineAmountTypes | See Line Amount Types |
| SubTotal | Total of receipt excluding taxes |
| TotalTax | Total tax on receipt |
| Total | Total of receipt tax inclusive (i.e. SubTotal + TotalTax) |

Elements for Line Items
_The following elements are **required** to submit a complete receipt_

|  |  |
| --- | --- |
| Description | Description needs to be at least 1 char long. A line item with just a description (i.e no unit amount or quantity) can be created by specifying just a Description element that contains at least 1 character |
| UnitAmount | Lineitem unit amount. By default, unit amount will be rounded to two decimal places. You can opt in to use four decimal places by adding the querystring parameter unitdp=4 to your query. See the Rounding in Xero guide for more information. |
| AccountCode | AccountCode must be active for the organisation. AccountCodes can only be applied to a receipt when the ShowInExpenseClaims value is true. Bank Accounts can not be applied to receipts. |

_The following are **optional** for a PUT / POST request_

|  |  |
| --- | --- |
| Quantity | LineItem Quantity |
| TaxType | Used as an override if the default Tax Code for the selected AccountCode is not correct – see TaxTypes. |
| LineAmount | If you wish to omit either of the Quantity or UnitAmount you can provide a LineAmount and Xero will calculate the missing amount for you |
| Tracking | Optional Tracking Category – see Tracking. Any LineItem can have a maximum of 2 TrackingCategory elements. You must use the Name and Option elements instead of the TrackingCategoryID and TrackingOptionID fields. |

Example of the minimum request to create a receipt

```
POST https://api.xero.com/api.xro/2.0/Receipts
```


```
{
  "Date": "2011-09-30",
  "User": {
    "UserID": "0ccf3aa2-3207-422f-82ef-2e3fc1ad5a82"
  },
  "Contact": {
    "ContactID": "eaa28f49-6028-4b6e-bb12-d8f6278073fc"
  },
  "LineAmountTypes": "Inclusive",
  "LineItems": [
    {
      "Description": "Coffee with client to discuss support contract",
      "UnitAmount": "13.80",
      "AccountCode": "420"
    }
  ],
  "Total": "13.80"
}
```


Example request to create a receipt with all available elements

```
POST https://api.xero.com/api.xro/2.0/Receipts
```


```
{
  "User": {
    "UserID": "0ccf3aa2-3207-422f-82ef-2e3fc1ad5a82"
  },
  "Contact": {
    "Name": "Joe's Coffee House"
  },
  "Date": "2016-09-20T00:00:00",
  "LineAmountTypes": "Inclusive",
  "LineItems": [
    {
      "Description": "thing",
      "UnitAmount": "5.00",
      "TaxType": "INPUT",
      "TaxAmount": ".45",
      "LineAmount": "5.00",
      "AccountCode": "400",
      "Tracking": [
        {
          "Name": "Region",
          "Option": "North"
        }
      ],
      "Quantity": "1.0000"
    }
  ]
}
```


Example request to delete a DRAFT receipt

```
POST https://api.xero.com/api.xro/2.0/Receipts/e59a2c7f-1306-4078-a0f3-73537afcbba9
```


```
{
  "ReceiptID": "e59a2c7f-1306-4078-a0f3-73537afcbba9",
  "Status": "DELETED",
  "User": {
    "UserID": "c81045b2-5740-4aea-bf8a-3956941af387"
  }
}
```


## PUT Receipts


The PUT method is similar to the POST Invoices method, however you can only create new receipts with this method.

### Submitting and entering many receipts

If you are entering many receipts in a single API call then we recommend you utilise our new response format that shows validation errors for each receipt. Each Receipt will be returned with a status element that contains the value OK or ERROR. If a receipt has a error then one or more validation errors will be returned. To utilise this functionality you'll need to append ?SummarizeErrors=false to the end of your API calls.

Example of the altered response format using the SummarizeErrors=false parameter

```
POST https://api.xero.com/api.xro/2.0/Receipts?SummarizeErrors=false
```


```
{
  "Receipts": [
    {
      "ReceiptID": "5ceffde5-6786-4987-b03a-bf88d262c286",
      ...
      "StatusAttributeString": "OK"
    },
    {
      "ReceiptID": "5ceffde5-6786-4987-b03a-bf88d262c286",
      ...
      "StatusAttributeString": "OK"
    },
    {
      "ReceiptID": "5ceffde5-6786-4987-b03a-bf88d262c286",
      ...
      "StatusAttributeString": "WARNING",
      "Warnings": [
        {
          "Message": "Error message"
        }
      ]
    },
    {
      "ReceiptID": "5ceffde5-6786-4987-b03a-bf88d262c286",
      ...
      "StatusAttributeString": "ERROR",
      "ValidationErrors": [
        {
          "Description": "Error message"
        }
      ]
    }
  ]
}
```


### Uploading a receipt image

You can upload up to 10 attachments (each up to 25mb in size) per receipt once they have been entered as drafts. To do this you'll need to know the ID of the receipt which you'll use to construct the URL when POST/PUTing a byte stream containing the image file.

Example of uploading an attachment to a receipt

```
POST https://api.xero.com/api.xro/2.0/Receipts/f0ec0d8c-4330-bb3b-83062c6fd8/Attachments/Image002932.png
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

View a summary of the actions made by all users to the receipt. See the History and Notes page for more details.

Example of retrieving a receipt's history

```
GET https://api.xero.com/api.xro/2.0/Receipts/{Guid}/History
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


### Add Notes to a Receipt

Add a note which will appear in the history against a receipt. See the History and Notes page for more details.

Example of creating a note against a receipt

```
PUT https://api.xero.com/api.xro/2.0/Receipts/{Guid}/History
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
