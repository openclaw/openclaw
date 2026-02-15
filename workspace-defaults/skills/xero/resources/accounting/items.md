# Items


## Overview


|  |  |
| --- | --- |
| URL | [https://api.xero.com/api.xro/2.0/Items](https://api.xero.com/api.xro/2.0/Items) |
| Methods Supported | GET, PUT, POST, DELETE |
| Description | Allows you to retrieve any items <br>Allows you to add or update tracked items <br>Allows you to add or update untracked items <br>Allows you to delete items <br>Allows you to retrieve history <br>Allows you to add notes |

### Tracked vs Untracked Items

If an item is tracked it means Xero tracks the quantity on hand and value of the item. There are stricter business rules around tracked items to facilitate this e.g. you can't create a sales invoice for that item if you don't have sufficient quantity on hand.

Untracked items are goods or services you can specify on transactions but Xero does not track quantities on hand or total value.

Read more about tracked and untracked items in [Xero's help centre](https://help.xero.com/nz/InventoryOptions).

## GET Items


Use this method to retrieve either one or many items.

The following elements are returned in the Items response:

|  |  |
| --- | --- |
| ItemID | Xero generated identifier for an item (unique within organisations) |
| Code | User defined item code |
| Name | The name of the item |
| IsSold | Boolean value. When IsSold is true the item will be available on sales transactions in the Xero UI. |
| IsPurchased | Boolean value. When IsPurchased is true the item is available for purchase transactions in the Xero UI. |
| Description | The sales description of the item |
| PurchaseDescription | The purchase description of the item |
| PurchaseDetails | See Purchases & Sales. The PurchaseDetails element can contain a number of individual sub-elements. |
| SalesDetails | See Purchases & Sales. The SalesDetails element can contain a number of individual sub-elements. |
| IsTrackedAsInventory | True for items that are tracked as inventory. An item will be tracked as inventory if the `InventoryAssetAccountCode` and `COGSAccountCode` are set. |
| InventoryAssetAccountCode | The inventory asset account for the item. The account must be of type `INVENTORY`. The COGSAccountCode in PurchaseDetails is also required to create a tracked item |
| TotalCostPool | The value of the item on hand. Calculated using average cost accounting. |
| QuantityOnHand | The quantity of the item on hand |
| UpdatedDateUTC | Last modified date in UTC format |

Elements for Purchases and Sales

|  |  |
| --- | --- |
| UnitPrice | Unit Price of the item. By default UnitPrice is returned to two decimal places. You can use 4 decimal places by adding the unitdp=4 querystring parameter to your request. |
| AccountCode | Default account code to be used for purchased/sale. Not applicable to the purchase details of tracked items |
| COGSAccountCode | Cost of goods sold account. Only applicable to the purchase details of tracked items. |
| TaxType | Used as an override if the default Tax Code for the selected AccountCode is not correct – see TaxTypes. |

### Optional parameters

|  |  |
| --- | --- |
| Record filter | You can specify an individual record by appending the value to the endpoint, i.e. <br>`GET https://.../Items/{identifier}`<br>**ItemID** – The Xero identifier for an Item <br>e.g. 297c2dc5-cc47-4afd-8ec8-74990b8761e9 <br>**Code** – The Code e.g. ITEM-001 |
| Modified After | The ModifiedAfter filter is actually an HTTP header: ' **If-Modified-Since**'. <br>A UTC timestamp (yyyy-mm-ddThh:mm:ss). Only items created or modified since this timestamp will be returned e.g. 2009-11-12T00:00:00 |
| where | Filter by an any element ( _see Filters_ ) |
| order | Order by any element returned ( _see Order By_ ) |

Examples response when retrieving an individual item

```
GET https://api.xero.com/api.xro/2.0/Items/Merino-2011-LG
```


```
{
  "Items": [
    {
      "ItemID": "9a59ea90-942e-484d-9b71-d00ab607e03b",
      "Code": "Merino-2011-LG",
      "Description": "2011 Merino Sweater - LARGE",
      "UpdatedDateUTC": "\/Date(1488338552390+0000)\/",
      "PurchaseDetails": {
        "UnitPrice": 149.0000,
        "AccountCode": "300"
      },
      "SalesDetails": {
        "UnitPrice": 299.0000,
        "AccountCode": "200"
      }
    }
  ]
}
```


Examples response when retrieving a collection of items

```
GET https://api.xero.com/api.xro/2.0/Items
```


```
{
  "Items": [
    {
      "ItemID": "19b79d12-0ae1-496e-9649-cbd04b15c7c5",
      "Code": "UnTrackedThing",
      "Description": "I sell this untracked thing",
      "PurchaseDescription": "I buy this untracked thing",
      "UpdatedDateUTC": "\/Date(1488338552390+0000)\/",
      "PurchaseDetails": {
        "UnitPrice": 20.0000,
        "AccountCode": "400",
        "TaxType": "NONE"
      },
      "SalesDetails": {
        "UnitPrice": 40.0000,
        "AccountCode": "200",
        "TaxType": "OUTPUT2"
      },
      "Name": "An Untracked Item",
      "IsTrackedAsInventory": false,
      "IsSold": true,
      "IsPurchased": true
    },
    {
      "ItemID": "90a72d44-43e4-410d-a68b-1139ef0c0c07",
      "Code": "TrackedThing",
      "Description": "I sell this tracked thing",
      "PurchaseDescription": "I purchase this tracked thing",
      "UpdatedDateUTC": "\/Date(1488338552390+0000)\/",
      "PurchaseDetails": {
        "UnitPrice": 20.0000,
        "COGSAccountCode": "430",
        "TaxType": "NONE"
      },
      "SalesDetails": {
        "UnitPrice": 40.0000,
        "AccountCode": "200",
        "TaxType": "OUTPUT2"
      },
      "Name": "Tracked Thing",
      "IsTrackedAsInventory": true,
      "InventoryAssetAccountCode": "630",
      "TotalCostPool": 200.00,
      "QuantityOnHand": 10.0000,
      "IsSold": true,
      "IsPurchased": true
    }
  ]
}
```


## POST Items


Use this method to create or update items.

You can create or update a maximum of 500 items per request, although we recommend batches of 50-100 to optimise efficiency.

### Elements for Items

_The following is **required** for a PUT / POST_

|  |  |
| --- | --- |
| Code | User defined item code (max length = 30) |

_The following is **required** for a PUT / POST on a tracked inventory item_

|  |  |
| --- | --- |
| InventoryAssetAccountCode | The inventory asset account for the item. The account must be of type INVENTORY. The COGSAccountCode in PurchaseDetails is also required to create a tracked item |

_The following are **optional** for a PUT / POST_

|  |  |
| --- | --- |
| Name | The name of the item (max length = 50) |
| IsSold | Boolean value, defaults to true. When IsSold is true the item will be available on sales transactions in the Xero UI. If IsSold is updated to false then Description and SalesDetails values will be nulled. |
| IsPurchased | Boolean value, defaults to true. When IsPurchased is true the item is available for purchase transactions in the Xero UI. If IsPurchased is updated to false then PurchaseDescription and PurchaseDetails values will be nulled. |
| Description | The sales description of the item (max length = 4000) |
| PurchaseDescription | The purchase description of the item (max length = 4000) |
| PurchaseDetails | See Purchases & Sales. The PurchaseDetails element can contain a number of individual sub-elements. |
| SalesDetails | See Purchases & Sales. The SalesDetails element can contain a number of individual sub-elements. |

Elements for Purchases and Sales

|  |  |
| --- | --- |
| UnitPrice | Unit Price of the item. By default UnitPrice is rounded to two decimal places. You can use 4 decimal places by adding the unitdp=4 querystring parameter to your request. |
| AccountCode | Default account code to be used for purchased/sale. Not applicable to the purchase details of tracked items |
| COGSAccountCode | Cost of goods sold account. Only applicable to the purchase details of tracked items. |
| TaxType | Used as an override if the default Tax Code for the selected AccountCode is not correct – see TaxTypes. |

### Adjusting the quantity and value of tracked items

The Quantity and TotalCostPool elements are read-only. They cannot be explicitly set via the Items endpoint. The only way to change the quantity and value of tracked items is by creating accounting transactions.

Increase the value and quantity of a tracked item by creating purchase transactions (ACCPAY Invoices or SPEND BankTransactions) and decrease the value and quantity of tracked items by creating sales transactions (ACCREC Invoices or RECEIVE BankTransactions). Read more about inventory adjustments in our Tracked Inventory in Xero guide.

Example request with minimum elements to create an untracked item

```
POST https://api.xero.com/api.xro/2.0/Items
```


```
{
  "Code": "Item-1"
}
```


Example request to create an untracked item with sales and purchase details

```
POST https://api.xero.com/api.xro/2.0/Items
```


```
{
  "Code": "Merino-2011-LG",
  "Name": "Full Tracked Item",
  "Description": "2011 Merino Sweater - LARGE",
  "PurchaseDescription": "2011 Merino Sweater - LARGE",
  "PurchaseDetails": {
    "UnitPrice": 149.0000,
    "AccountCode": "300"
  },
  "SalesDetails": {
    "UnitPrice": 299.0000,
    "AccountCode": "200"
  }
}
```


Example request with minimum elements to create a tracked item

```
POST https://api.xero.com/api.xro/2.0/Items
```


```
{
  "Code": "TrackedItem",
  "PurchaseDetails": {
    "COGSAccountCode": "300"
  },
  "InventoryAssetAccountCode": "630"
}
```


Example request to create a tracked item with full details

```
POST https://api.xero.com/api.xro/2.0/Items
```


```
{
  "Code": "FullTracked",
  "Description": "Sell me",
  "PurchaseDescription": "Purchase me",
  "PurchaseDetails": {
    "UnitPrice": 75.5555,
    "COGSAccountCode": "300",
    "TaxType": "INPUT2"
  },
  "SalesDetails": {
    "UnitPrice": 1020.5555,
    "AccountCode": "260",
    "TaxType": "OUTPUT2"
  },
  "Name": "Full Tracked Item",
  "InventoryAssetAccountCode": "630",
  "IsSold": true,
  "IsPurchased": true
}
```


## PUT Items


The PUT method is similar to the POST Items method, however you can only create new items with this method.

## DELETE Items


Use the DELETE method to delete items

Example request to delete an item

```
DELETE https://api.xero.com/api.xro/2.0/Items/297c2dc5-cc47-4afd-8ec8-74990b8761e9
```


### Retrieving History

View a summary of the actions made by all users to the item. See the History and Notes page for more details.

Example of retrieving a item's history

```
GET https://api.xero.com/api.xro/2.0/Items/{Guid}/History
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


### Add Notes to a Item

Add a note which will appear in the history against an item. See the History and Notes page for more details.

Example of creating a note against a invoice

```
PUT https://api.xero.com/api.xro/2.0/Invoices/{Guid}/History
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
