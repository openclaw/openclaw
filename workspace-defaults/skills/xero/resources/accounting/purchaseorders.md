# Purchase Orders


## Overview


|  |  |
| --- | --- |
| URL | [https://api.xero.com/api.xro/2.0/PurchaseOrders](https://api.xero.com/api.xro/2.0/PurchaseOrders) |
| Methods Supported | GET, PUT, POST |
| Description | Allows you to retrieve purchase orders <br>Allows you to add or update purchase orders <br>Allows you to delete purchase orders <br>Allows you to retrieve history <br>Allows you to add notes |

## GET PurchaseOrders


Use this method to retrieve one or many purchase orders.

- By default responses are formatted as XML. You can also retrieve responses in JSON format.
- When you retrieve multiple purchase orders, paging is enforced by default. 100 purchase orders are returned per page.
- Individual purchase orders (e.g. PurchaseOrders/97c2dc5-cc47-4afd-8ec8-74990b8761e9) can also be returned as PDF's see our HTTP GET documentation

Amounts are in the purchase order's currency.

|  |  |
| --- | --- |
| Contact | See Contacts. |
| Date | Date purchase order was issued – YYYY-MM-DD |
| DeliveryDate | Date the goods are to be delivered – YYYY-MM-DD |
| LineAmountTypes | See Line Amount Types |
| PurchaseOrderNumber | Unique alpha numeric code identifying purchase order |
| Reference | Additional reference number |
| LineItems | The LineItems collection can contain any number of individual LineItem sub-elements. |
| BrandingThemeID | See BrandingThemes |
| CurrencyCode | The currency that purchase order has been raised in (see Currencies) |
| Status | See Purchase Order Status Codes |
| SentToContact | Boolean to set whether the purchase order should be marked as "sent" |
| DeliveryAddress | The address the goods are to be delivered to |
| AttentionTo | The person that the delivery is going to |
| Telephone | The phone number for the person accepting the delivery |
| DeliveryInstructions | A free text field for instructions |
| ExpectedArrivalDate | The date the goods are expected to arrive. |
| PurchaseOrderID | Xero generated identifier for purchase order (unique within organisations) |
| CurrencyRate | For base currency purchase orders, has a value of 1. For non-base-currency purchase orders, see CurrencyRate meaning. |
| SubTotal | Total of purchase order excluding taxes |
| TotalTax | Total tax on purchase order |
| Total | Total of Purchase Order tax inclusive (i.e. SubTotal + TotalTax) |
| TotalDiscount | Total of discounts applied on the purchase order line items |
| HasAttachments | boolean to indicate if a purchase order has an attachment |
| UpdatedDateUTC | Last modified date UTC format |

Elements for Line Items

|  |  |
| --- | --- |
| Description | The description of the line item. A line item can be created with only a description (i.e no unit amount or quantity) |
| Quantity | LineItem Quantity. If Quantity is specified then a UnitAmount must be specified |
| UnitAmount | Lineitem unit amount. Will be rounded to four decimal places |
| ItemCode | See Items |
| AccountCode | See Accounts |
| TaxType | Used as an override if the default Tax Code for the selected AccountCode is not correct – see TaxTypes. |
| DiscountRate | Percentage discount being applied to a line item |
| Tracking | Optional Tracking Category – see Tracking. Any LineItem can have a maximum of 2 TrackingCategory elements. |
| LineItemID | The Xero generated identifier for a LineItem. If LineItemIDs are not included with line items in an update request then the line items are deleted and recreated. |
| TaxAmount | The tax amount is auto calculated as a percentage of the line amount based on the tax rate. |
| LineAmount | The line amount reflects the discounted price if a DiscountRate has been used . i.e LineAmount = Quantity \* Unit Amount \* ((100 – DiscountRate)/100) |

### Optional parameters

|  |  |
| --- | --- |
| Record filter | You can specify an individual record by appending the value to the endpoint, i.e. `GET https://.../PurchaseOrders/{identifier}`<br>* * *<br> **PurchaseOrderID** – The Xero identifier for a PurchaseOrder e.g. 297c2dc5-cc47-4afd-8ec8-74990b8761e9 <br>* * *<br>**PurchaseOrderNumber** – The PurchaseOrderNumber e.g. PO-01514 |
| Modified After | The ModifiedAfter filter is actually an HTTP header: ' **If-Modified-Since**'. A UTC timestamp (yyyy-mm-ddThh:mm:ss) . Only purchase orders created or modified since this timestamp will be returned e.g. 2015-11-12T00:00:00 |
| Status | Filter by purchase order status (e.g. GET [https://.../PurchaseOrders?status=DRAFT](https://.../PurchaseOrders?status=DRAFT)) |
| DateFrom and DateTo | Filter by purchase order date (e.g. GET [https://.../PurchaseOrders?DateFrom=2015-12-01&DateTo=2015-12-31](https://.../PurchaseOrders?DateFrom=2015-12-01&DateTo=2015-12-31)) |
| order | Order by any element returned ( _see Order By_ ) |
| page | 100 purchase orders will be returned per call as the default when the page parameter is used by itself e.g. page=1 |
| pageSize | Used with the page parameter. Up to 1000 purchase orders will be returned per call when the pageSize parameter is used e.g. page=1&pageSize=250. |

Example response retrieving PurchaseOrders

```
GET https://api.xero.com/api.xro/2.0/PurchaseOrders
```


```
{
  "PurchaseOrders": [
    {
      "PurchaseOrderID": "44d3f8a4-7031-45e8-b252-e92914e43c7e",
      "PurchaseOrderNumber": "PO-0001",
      "DateString": "2017-02-21T00:00:00",
      "Date": "\/Date(1487635200000+0000)\/",
      "DeliveryDateString": "2017-02-22T00:00:00",
      "DeliveryDate": "\/Date(1487721600000+0000)\/",
      "DeliveryAddress": "23 Main Street\r\nCentral City\r\nMarineville\r\n1234\r\n",
      "AttentionTo": "FOH",
      "Telephone": "0800 1234 5678",
      "DeliveryInstructions": "Deliver to reception. As agreed, table needs to be assembled prior to delivery.",
      "IsDiscounted": false,
      "Reference": "710",
      "Type": "PURCHASEORDER",
      "CurrencyRate": 1.000000,
      "CurrencyCode": "NZD",
      "Contact": {
        "ContactID": "bde095a6-1c01-4e1d-b6f4-9190cfe89a9c",
        "ContactStatus": "ACTIVE",
        "Name": "ABC Furniture",
        "FirstName": "Trish",
        "LastName": "Rawlings",
        "Phones": [
          {
            "PhoneType": "DEFAULT",
            "PhoneNumber": "124578",
            "PhoneAreaCode": "800"
          }
        ],
        "UpdatedDateUTC": "\/Date(1488391422297+0000)\/",
        "DefaultCurrency": "NZD"
      },
      "BrandingThemeID": "7889a0ac-262a-40e3-8a63-9a769b1a18af",
      "Status": "BILLED",
      "LineAmountTypes": "Exclusive",
      "LineItems": [
        {
          "Description": "Coffee table for reception",
          "UnitAmount": 1000.0000,
          "TaxType": "INPUT2",
          "TaxAmount": 150.00,
          "LineAmount": 1000.00,
          "Quantity": 1.0000,
          "LineItemID": "1aa3bf00-a5fe-420f-b4b3-d64349a13108"
        }
      ],
      "SubTotal": 1000.00,
      "TotalTax": 150.00,
      "Total": 1150.00,
      "UpdatedDateUTC": "\/Date(1385147725247+0000)\/"
    },{
      "PurchaseOrderID": "9b0c56fc-7952-4906-aa5a-e6abb6f9bef8",
      "PurchaseOrderNumber": "PO-0002",
      "DateString": "2017-02-19T00:00:00",
      "Date": "\/Date(1487462400000+0000)\/",
      "DeliveryDateString": "2017-02-21T00:00:00",
      "DeliveryDate": "\/Date(1487635200000+0000)\/",
      "ExpectedArrivalDateString": "2017-02-28T00:00:00",
      "ExpectedArrivalDate": "\/Date(1488240000000+0000)\/",
      "DeliveryAddress": "Bayside Club\r\n148 Bay Harbour Road\r\nRidge Heights\r\nMadeupville 6001\r\nNew Zealand",
      "AttentionTo": "Club Secretary",
      "Telephone": "02-2024455",
      "DeliveryInstructions": "Urgent delivery - send directly to Doug (Club Secretary) at the Bayside Club",
      "IsDiscounted": false,
      "Reference": "GB1-White",
      "Type": "PURCHASEORDER",
      "CurrencyRate": 1.000000,
      "CurrencyCode": "NZD",
      "Contact": {
        "ContactID": "9954ba5c-0451-43b0-a9ea-89612622fe3f",
        "ContactStatus": "ACTIVE",
        "Name": "Dimples Warehouse",
        "UpdatedDateUTC": "\/Date(1488391422280+0000)\/",
        "DefaultCurrency": "NZD"
      },
      "BrandingThemeID": "7889a0ac-262a-40e3-8a63-9a769b1a18af",
      "Status": "AUTHORISED",
      "LineAmountTypes": "Inclusive",
      "LineItems": [
        {
          "Description": "Delivery charge",
          "UnitAmount": 50.0000,
          "TaxType": "INPUT2",
          "TaxAmount": 6.52,
          "LineAmount": 50.00,
          "Quantity": 1.0000,
          "LineItemID": "a0510037-5a97-42dd-ba66-4cc0a83c8c26"
        },{
          "ItemCode": "GB1-White",
          "Description": "Golf balls - white single",
          "UnitAmount": 4.2000,
          "TaxType": "INPUT2",
          "TaxAmount": 54.78,
          "LineAmount": 420.00,
          "AccountCode": "300",
          "Quantity": 100.0000,
          "LineItemID": "c0267cf8-5a5a-412d-8c1f-83e696e79088"
        }
      ],
      "SubTotal": 408.70,
      "TotalTax": 61.30,
      "Total": 470.00,
      "UpdatedDateUTC": "\/Date(1385147879753+0000)\/",
      "HasAttachments": false
    },{
      ...
    }
  ]
}
```


### High volume threshold limit

In order to make our platform more stable, we've added a high volume threshold limit for the GET Purchase Orders Endpoint.

- Requests that have more than 100k purchase orders being returned in the response will be denied
- Requests using unoptimised fields for filtering or ordering that result in more than 100k purchase orders will be denied with a 400 response code

Please continue reading to find out how you can use paging to ensure your requests are always successful. Be sure to check out the Efficient Data Retrieval page for tips on query optimisation.

### Paging purchase orders (recommended)

More information about retrieving paged resources.

## POST PurchaseOrders


Use this method to create or update purchase orders.

Amounts are in the purchase order's currency.

_The following are **required** to create a purchase order_

|  |  |
| --- | --- |
| Contact | The PurchaseOrders endpoint does not create new contacts. You need to provide the ContactID or ContactNumber of an existing contact. For more information on creating contacts see Contacts. |
| LineItems | The LineItems collection can contain any number of individual LineItem sub-elements. At least one LineItem is required to create a complete PurchaseOrder. |

_The following are **optional** for a PUT / POST request_

|  |  |
| --- | --- |
| Date | Date purchase order was issued – YYYY-MM-DD. If the Date element is not specified then it will default to the current date based on the timezone setting of the organisation |
| DeliveryDate | Date the goods are to be delivered – YYYY-MM-DD |
| LineAmountTypes | Line amounts are exclusive of tax by default if you don't specify this element. See Line Amount Types |
| PurchaseOrderNumber | Unique alpha numeric code identifying purchase order ( _when missing will auto-generate from your Organisation Invoice Settings_) |
| Reference | Additional reference number |
| BrandingThemeID | See BrandingThemes |
| CurrencyCode | The currency that purchase order has been raised in (see Currencies). Defaults to the organisation's base currency. |
| CurrencyRate | For how and when to set, see our multicurrency guide. |
| Status | See Purchase Order Status Codes |
| SentToContact | Boolean to set whether the purchase order should be marked as "sent". This can be set only on purchase orders that have been approved or billed |
| DeliveryAddress | The address the goods are to be delivered to |
| AttentionTo | The person that the delivery is going to |
| Telephone | The phone number for the person accepting the delivery |
| DeliveryInstructions | A free text field for instructions (500 characters max) |
| ExpectedArrivalDate | The date the goods are expected to arrive. |
| PurchaseOrderID | Xero generated unique identifier for purchase order |

Elements for Line Items

|  |  |
| --- | --- |
| Description | The description of the line item. A line item can be created with only a description (i.e no unit amount or quantity) |
| Quantity | LineItem Quantity. If Quantity is specified then a UnitAmount must be specified |
| UnitAmount | Lineitem unit amount. Will be rounded to four decimal places |
| ItemCode | See Items |
| AccountCode | See Accounts |
| TaxType | Used as an override if the default Tax Code for the selected AccountCode is not correct – see TaxTypes. |
| DiscountRate | Percentage discount being applied to a line item |
| Tracking | Optional Tracking Category – see Tracking. Any LineItem can have a maximum of 2 TrackingCategory elements. |
| LineItemID | The Xero generated identifier for a LineItem. If LineItemIDs are not included with line items in an update request then the line items are deleted and recreated. |

### Creating, updating and deleting line items when updating purchase orders

In an update (POST) request:

- Providing an existing LineItem with its LineItemID will update that line item.
- Providing a LineItem with no LineItemID will create a new line item.
- Not providing an existing LineItem with it's LineItemID will result in that line item being deleted.

Example request to create a simple draft purchase order

```
POST https://api.xero.com/api.xro/2.0/PurchaseOrders
```


```
{
  "Contact": { "ContactID": "eaa28f49-6028-4b6e-bb12-d8f6278073fc" },
  "Date": "2015-11-30",
  "DeliveryDate": "2015-12-20",
  "LineAmountTypes": "Exclusive",
  "LineItems": [
    {
      "Description": "Office Chairs",
      "Quantity": 5.0000,
      "UnitAmount": 120.00
    }
  ]
}
```


Example request to create a purchase order with all elements specified

```
POST https://api.xero.com/api.xro/2.0/PurchaseOrders
```


```
{
  "PurchaseOrderNumber": "PO-0292",
  "Date": "2015-11-12",
  "DeliveryDate": "2015-12-12",
  "Reference": "REF123",
  "Contact": { "ContactID": "d7b78c9c-b34a-4dad-b999-c3c2504c7877" },
  "BrandingThemeID": "4c82c365-35cb-467f-bb11-dce1f2f2f67c",
  "Status": "AUTHORISED",
  "LineAmountTypes": "Exclusive",
  "LineItems": [
    {
      "ItemCode": "GB1-White",
      "Description": "Golf balls - white single. Wholesale catalog item #020812-1",
      "UnitAmount": 4.2595,
      "TaxType": "INPUT2",
      "AccountCode": "300",
      "Tracking": [
        {
          "Name": "Region",
          "Option": "Eastside"
        },{
          "Name": "Salesperson",
          "Option": "Adam"
        }
      ],
      "Quantity": 1.0000,
      "DiscountRate": 10.00
    }
  ],
  "CurrencyRate": 0.615310,
  "CurrencyCode": "EUR",
  "DeliveryAddress": "23 Main Street, Central City, Marineville,1234",
  "AttentionTo": "Bob",
  "Telephone": "0800 1234 5678",
  "DeliveryInstructions": "Don't forget the secret knock",
  "ExpectedArrivalDate": "2015-12-12"
}
```


Example request to update a draft purchase order to a status of deleted.

```
POST https://api.xero.com/api.xro/2.0/PurchaseOrders/22b3fab4-ef56-4d70-a110-a7cc3c1a26cd
```


```
{
  "PurchaseOrderNumber": "PO-239",
  "Status": "DELETED"
}
```


Example request to update a purchase order to mark it as sent

```
POST https://api.xero.com/api.xro/2.0/PurchaseOrders/8694c9c5-7097-4449-a708-b8c1982921a4
```


```
{
  "PurchaseOrderID": "8694c9c5-7097-4449-a708-b8c1982921a4",
  "SentToContact": true
}
```


## PUT PurchaseOrders


The PUT method is similar to the POST PurchaseOrders method, however you can only create new purchase orders with this method.

### Summarize Errors

If you are entering many purchase orders in a single API call then we recommend you utilise the summarizeErrors parameter which provides a response format that shows validation errors for each purchase order. Note that each Purchase Order is returned with a status element which will either contain the value OK or ERROR. If a purchase order has an error then one or more validation errors will be returned.

Example of the altered response format using the SummarizeErrors=false parameter

```
POST https://api.xero.com/api.xro/2.0/PurchaseOrders?SummarizeErrors=false
```


```
{
  "PurchaseOrders": [
    {
      ...
      "StatusAttributeString": "OK"
    },{
      ...
      "StatusAttributeString": "ERROR",
      "ValidationErrors": [
        { "Message": "Organisation is not subscribed to currency EUR" },
        { "Message": "A Contact must be specified for this type of transaction" }
      ]
    },{
      ...
      "StatusAttributeString": "OK"
    }
  ]
}
```


### Retrieving History

View a summary of the actions made by all users to the purchase order. See the History and Notes page for more details.

Example of retrieving a purchase order's history

```
GET https://api.xero.com/api.xro/2.0/PurchaseOrders/{Guid}/History
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


### Add Notes to a Purchase Order

Add a note which will appear in the history against a purchase order. See the History and Notes page for more details.

Example of creating a note against a purchase order

```
PUT https://api.xero.com/api.xro/2.0/PurchaseOrders/{Guid}/History
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
