# Quotes

## Overview


| Property | Description |
| --- | --- |
| URL | [https://api.xero.com/api.xro/2.0/Quotes](https://api.xero.com/api.xro/2.0/Quotes) |
| Methods Supported | GET, PUT, POST |
| Description | Retrieve quotes <br>Create quotes |

## GET Quotes


Use this method to retrieve one or many quotes.

- By default responses are formatted as XML. You can also retrieve responses in JSON format.
- Individual quotes (e.g. Quotes/97c2dc5-cc47-4afd-8ec8-74990b8761e9) can also be returned as PDF's see our HTTP GET documentation

Amounts are in the quote's currency.

The following elements are returned in the quotes response:

| Property | Description |
| --- | --- |
| Contact | See Contacts |
| Date | Date quote was issued – YYYY-MM-DD |
| ExpiryDate | Date quote expires – YYYY-MM-DD |
| Status | See Quote Status Codes |
| LineAmountTypes | See Line Amount Types |
| LineItems | The LineItems collection can contain any number of individual LineItem sub-elements. |
| SubTotal | Total of quote excluding taxes |
| TotalTax | Total tax on quote |
| Total | Total of Quote tax inclusive (i.e. SubTotal + TotalTax) |
| TotalDiscount | Total of discounts applied on the quote line items |
| UpdatedDateUTC | Last modified date UTC format |
| CurrencyCode | The currency that quote has been raised in (see Currencies) |
| CurrencyRate | For base currency quotes, has a value of 1. For non-base-currency quotes, see CurrencyRate meaning. |
| QuoteID | Xero generated identifier for a quote (unique within organisations) |
| QuoteNumber | Unique alpha numeric code identifying a quote |
| Reference | Additional reference number |
| BrandingThemeID | See BrandingThemes |
| Title | The title of the quote |
| Summary | The summary of the quote |
| Terms | The terms of the quote |

Elements for LineItems

| Property | Description |
| --- | --- |
| Description | The description of the line item |
| Quantity | LineItem Quantity |
| UnitAmount | Lineitem unit amount. By default, unit amount will be rounded to four decimal places. |
| ItemCode | See Items |
| AccountCode | See Accounts |
| LineItemID | The Xero generated identifier for a LineItem |
| TaxType | Used as an override if the default Tax Code for the selected AccountCode is not correct – see TaxTypes. |
| TaxAmount | The tax amount is auto calculated as a percentage of the line amount based on the tax rate |
| LineAmount | The line amount reflects the discounted price if either a DiscountRate or DiscountAmount has been used i.e. LineAmount = Quantity \* Unit Amount \* ((100 – DiscountRate)/100) or LineAmount = (Quantity \* UnitAmount) – DiscountAmount |
| DiscountRate | Percentage discount being applied to a line item |
| DiscountAmount | Discount amount being applied to a line item |
| Tracking | Section for optional Tracking Category – see TrackingCategory. Any LineItem can have a maximum of 2 TrackingCategory elements. |

Elements for TrackingCategory

| Property | Description |
| --- | --- |
| TrackingCategoryID | Xero assigned unique ID for the category |
| TrackingOptionID | Xero assigned unique ID for the option |
| Name | Name of the tracking category |
| Option | Name of the option (required) |

Examples response when retrieving a collection of quotes

```
GET https://api.xero.com/api.xro/2.0/Quotes?page=1
```


```
{
  "Id": "a5325919-874c-4e7c-bcb0-5b149de392c8",
  "Status": "OK",
  "ProviderName": "Adam Public",
  "DateTimeUTC": "/Date(1574029615275)/",
  "Quotes": [
    {
      "QuoteID": "68e9965d-8d22-4e22-a01c-ee0a78fb3ea1",
      "QuoteNumber": "QU-0010",
      "Reference": "REF-123",
      "Terms": "Quote valid until the end of the month",
      "Contact": {
        "ContactID": "42771b60-19a7-4692-af81-dd9f9b9362d4",
        "Name": "ABC Furniture",
        "EmailAddress": "info@abfl.com",
        "FirstName": "Trish",
        "LastName": "Rawlings"
      },
      "LineItems": [
        {
          "LineItemID": "060f0936-5818-4b31-acbd-6c733dafbc1a",
          "AccountCode": "200",
          "Description": "Development work - developer onsite per day",
          "UnitAmount": 650.0000,
          "DiscountRate": 10.00,
          "LineAmount": 585.00,
          "ItemCode": "DevD",
          "Quantity": 1.0000,
          "TaxAmount": 58.50,
          "TaxType": "OUTPUT",
          "Tracking": [
            {
              "TrackingCategoryID": "093af706-c2aa-4d97-a4ce-2d205a017eac",
              "TrackingOptionID": "ae777a87-5ef3-4fa0-a4f0-d10e1f13073a",
              "Name": "Region",
              "Option": "Eastside"
            }
          ]
        }
      ],
      "Date": "/Date(1574035200000)/",
      "DateString": "2019-11-18T00:00:00",
      "ExpiryDate": "/Date(1575072000000)/",
      "ExpiryDateString": "2019-11-30T00:00:00",
      "Status": "DRAFT",
      "CurrencyRate": 0.901366,
      "CurrencyCode": "CAD",
      "SubTotal": 585.00,
      "TotalTax": 58.50,
      "Total": 643.50,
      "TotalDiscount": 65.00,
      "Title": "Quote for dev work",
      "Summary": "As discussed",
      "BrandingThemeID": "2ced98b8-3be9-42c4-ae79-fe3c8bca3490",
      "UpdatedDateUTC": "/Date(1574029509507)/",
      "LineAmountTypes": "EXCLUSIVE"
    }
    ...
  ]
}
```


### Optional parameters

| Property | Description |
| --- | --- |
| QuoteID | You can specify an individual record by appending the QuoteID to the endpoint, i.e. **GET [https://.../Quotes/{identifier](https://.../Quotes/%7Bidentifier)}** |
| Modified After | The ModifiedAfter filter is actually an HTTP header: ' **If-Modified-Since**'. A UTC timestamp (yyyy-mm-ddThh:mm:ss). Only quotes created or modified since this timestamp will be returned e.g. 2015-11-12T00:00:00 |
| QuoteNumber | Filter by quote number (e.g. GET [https://.../Quotes?QuoteNumber=QU-0001](https://.../Quotes?QuoteNumber=QU-0001)). (see filtering method) |
| Status | Filter by quote status (e.g. GET [https://.../Quotes?status=DRAFT](https://.../Quotes?status=DRAFT)) |
| DateFrom and DateTo | Filter by quote date (e.g. GET [https://.../Quotes?DateFrom=2018-12-01&DateTo=2018-12-31](https://.../Quotes?DateFrom=2018-12-01&DateTo=2018-12-31)) |
| ExpiryDateFrom and ExpiryDateTo | Filter by quote expiry dates (e.g. GET [https://.../Quotes?ExpiryDateFrom=2019-12-01&ExpiryDateTo=2019-12-31](https://.../Quotes?ExpiryDateFrom=2019-12-01&ExpiryDateTo=2019-12-31)) |
| ContactID | Filter by a Contact (e.g. GET [https://.../Quotes?ContactID=f5f1fcb0-2a57-4cb1-836d-3ec207bfa61f](https://.../Quotes?ContactID=f5f1fcb0-2a57-4cb1-836d-3ec207bfa61f)) |
| order | Order by any element returned ( _see Order By_ ) |
| page | 100 quotes will be returned per call as the default when the page parameter is used by itself e.g. page=1 |
| pageSize | Used with the page parameter. Up to 1000 quotes will be returned per call when the pageSize parameter is used e.g. page=1&pageSize=250. |
|  |  |

#### Filtering by quote number

For filtering via quote number a partial match approach is used.

**Example**

I have quotes with the following numbers

```
1. QU
2. QU-0001
3. QU-0002
```


A fetch request to `GET https://api.xero.com/api.xro/2.0/Quotes?QuoteNumber=QU` will result in the retrieval of all the quotes above. It will return results based on a partial match criteria of `QU` for the **QuoteNumber** parameter.

## POST Quotes


Use this method to create or update one or many quotes.

Amounts are in the quote's currency.

_The following are **required** to create a draft quote_

| Property | Description |
| --- | --- |
| Contact | See Contacts |
| Date | Date quote was issued – YYYY-MM-DD |
| LineItems | The LineItems collection can contain any number of individual LineItem sub-elements. At minimum, a _**description**_ is required to create a complete quote. |

_The following are **required** when updating one or many quotes_

| Property | Description |
| --- | --- |
| QuoteID | QuoteID GUID is automatically generated and is returned after create or GET. |

_The following are **optional** when creating or updating quotes._

_**NOTE:** Some fields cannot be updated when a quote is in a specific state. See editable fields for more information_

| Property | Description |
| --- | --- |
| LineAmountTypes | See Line Amount Types |
| Status | See Quote Status Codes |
| ExpiryDate | Date quote expires – YYYY-MM-DD |
| CurrencyCode | The currency that quote has been raised in (see Currencies). Defaults to the organisation's base currency. |
| CurrencyRate | For how and when to set, see our multicurrency guide. |
| QuoteNumber | Unique alpha numeric code identifying a quote (Max Length = 255) |
| Reference | Additional reference number |
| BrandingThemeID | See BrandingThemes |
| Title | The title of the quote (Max Length = 100) |
| Summary | The summary of the quote (Max Length = 3000) |
| Terms | The terms of the quote (Max Length = 4000) |

Elements for LineItems

| Property | Description |
| --- | --- |
| Description | Description needs to be at least 1 char long. A line item with just a description (i.e no unit amount or quantity) can be created by specifying just a Description element that contains at least 1 character (max length = 4000) |
| Quantity | LineItem Quantity |
| UnitAmount | Lineitem unit amount. By default, unit amount will be rounded to four decimal places. |
| ItemCode | See Items |
| AccountCode | See Accounts |
| TaxType | See TaxTypes. Please note, if this field is not included in the payload the tax rate field in the quote will not populate from the default account code unlike other endpoints. |
| DiscountRate or DiscountAmount | Percentage discount or discount amount being applied to a line item. |
| Tracking | Section for optional Tracking Category – see TrackingCategory. Any LineItem can have a maximum of 2 TrackingCategory elements. Tracking is limited to TrackingOptionID only for Quotes. |

Elements for TrackingCategory

| Property | Description |
| --- | --- |
| TrackingOptionID | Xero assigned unique ID for the option |

### Quote status changes

The following state changes are valid when updating quotes.

| Property | Description |
| --- | --- |
| **Existing status** | **New status** |
| DRAFT | SENT |
| DRAFT | DELETED |
| SENT | ACCEPTED |
| ACCEPTED | INVOICED |
| SENT | DECLINED |
| SENT | DELETED |
| DECLINED | SENT |
| DECLINED | DELETED |
| ACCEPTED | SENT |
| ACCEPTED | DELETED |
| INVOICED | SENT |
| INVOICED | DELETED |

### Status based editible fields

The following fields changes are valid when updating quotes in a specific status.

| Property | Description |
| --- | --- |
| **Existing status** | **Editable Fields** |
| DRAFT | All fields |
| SENT | All fields |
| DECLINED | Contact details <br>Notes |
| ACCEPTED | Contact details <br>Notes |
| INVOICED | Contact details <br>Notes |

Example of minimum elements required to create a single draft quote

```
POST https://api.xero.com/api.xro/2.0/Quotes
```


```
{
"Contact": {
  "ContactID": "6d42f03b-181f-43e3-93fb-2025c012de92"
},
"Date": "2019-11-29",
"LineItems": [
  {
    "Description": "Consulting services"
  }
]
}
```


Example to create a single draft quote with all possible elements

```
POST https://api.xero.com/api.xro/2.0/Quotes
```


```
{
 "QuoteNumber": "QU-1068",
 "Reference": "REF-90092",
 "Terms": "Quote is valid for 30 business days",
 "Contact": {
   "ContactID": "6d42f03b-181f-43e3-93fb-2025c012de92",
   "ContactName": "John Hammond"
 },
 "LineItems": [
   {
     "Description": "Jurassic Park Colouring Book",
     "UnitAmount": 12.50,
     "LineAmount": 12.50,
     "ItemCode": "BOOK",
     "Quantity": 1.0000
   }
 ],
 "Date": "2019-11-29",
 "ExpiryDate": "2019-12-29",
 "Status": "SENT",
 "CurrencyCode": "NZD",
 "SubTotal": 12.50,
 "TotalTax": 0.00,
 "Total": 12.50,
 "Title": "Quote for product sale",
 "Summary": "Sale of book",
 "Tracking": [],
 "LineAmountTypes": "EXCLUSIVE"
 }
```


Example of minimum elements required to update a single draft quote

```
POST https://api.xero.com/api.xro/2.0/Quotes
```


```
{
"QuoteID": "68e9965d-8d22-4e22-a01c-ee0a78fb3ea1",
"Contact": {
  "ContactID": "6d42f03b-181f-43e3-93fb-2025c012de92"
},
"Date": "2019-11-29",
"LineItems": [
  {
    "Description": "Consulting services"
  }
]
}
```


Example of maximum elements required to update a single draft quote

```
POST https://api.xero.com/api.xro/2.0/Quotes
```


```
{
 "QuoteID": "68e9965d-8d22-4e22-a01c-ee0a78fb3ea1",
 "QuoteNumber": "QU-1068",
 "Reference": "REF-90092",
 "Terms": "Quote is valid for 30 business days",
 "Contact": {
   "ContactID": "6d42f03b-181f-43e3-93fb-2025c012de92"
 },
 "LineItems": [
   {
     "LineItemID": "060f0936-5818-4b31-acbd-6c733dafbc1a",
     "Description": "Jurassic Park Colouring Book",
     "UnitAmount": 12.50,
     "LineAmount": 12.50,
     "ItemCode": "BOOK",
     "Quantity": 1.0000
   }
 ],
 "Date": "2019-11-29",
 "ExpiryDate": "2019-12-29",
 "Status": "SENT",
 "CurrencyCode": "NZD",
 "SubTotal": 12.50,
 "TotalTax": 0.00,
 "Total": 12.50,
 "Title": "Quote for product sale",
 "Summary": "Sale of book",
 "Tracking": [],
 "LineAmountTypes": "EXCLUSIVE"
 }
```


### Retrieving History

View a summary of the actions made by all users to the quote. See the History and Notes page for more details.

### Add Notes to a Quote

Add a note which will appear in the history against an quote. See the History and Notes page for more details.

## PUT Quotes


The PUT method is similar to the POST Quotes method, however you can only create new quotes with this method.
