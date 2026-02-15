# Repeating Invoices


## Overview


| Property | Description |
| --- | --- |
| URL | [https://api.xero.com/api.xro/2.0/RepeatingInvoices](https://api.xero.com/api.xro/2.0/RepeatingInvoices) |
| Methods Supported | GET |
| Description | Allows you to retrieve any repeating invoice templates <br>Allows you to retrieve history <br>Allows you to create repeating invoice templates <br>Allows you to delete repeating invoice templates |

Repeating invoices should be used when you need to create invoices on a regular basis.
For example, billing a subscription to a customer with a constant price every month.

If you want to create a draft invoice which is modified multiple times please use the Invoices endpoint. This can then be manually sent out at a prescribed date (either via the UI or your integration).

## GET RepeatingInvoices


Use this method to retrieve either one or many repeating invoices.

| Field | Description |
| --- | --- |
| Type | See Invoice Types |
| Contact | See Contacts |
| Schedule |  |
| LineItems | The LineItems collection can contain any number of individual LineItem sub-elements. |
| LineAmountTypes | Line amounts are exclusive of tax by default if you don't specify this element. See Line Amount Types |
| Reference | ACCREC only – additional reference number |
| BrandingThemeID | See BrandingThemes |
| CurrencyCode | The currency that invoice has been raised in (see Currencies) |
| Status | One of the following : DRAFT or AUTHORISED – See Invoice Status Codes |
| SubTotal | Total of invoice excluding taxes |
| TotalTax | Total tax on invoice |
| Total | Total of Invoice tax inclusive (i.e. SubTotal + TotalTax) |
| RepeatingInvoiceID | Xero generated identifier for repeating invoice template (unique within organisations) |
| HasAttachments | Boolean to indicate if an invoice has an attachment |
| ApprovedForSending | Boolean to indicate whether the invoice has been approved for sending |
| SendCopy | Boolean to indicate whether a copy is sent to sender's email |
| MarkAsSent | Boolean to indicate whether the invoice in the Xero app displays as "sent" |
| IncludePDF | Boolean to indicate whether to include PDF attachment |

Elements for Schedule

| Field | Description |
| --- | --- |
| Period | Integer used with the unit e.g. 1 (every 1 week), 2 (every 2 months) |
| Unit | One of the following : WEEKLY or MONTHLY |
| DueDate | Integer used with due date type e.g 20 (of following month), 31 (of current month) |
| DueDateType | See Payment Terms |
| StartDate | Date the first invoice of the current version of the repeating schedule was generated (changes when repeating invoice is edited) |
| NextScheduledDate | The calendar date of the next invoice in the schedule to be generated |
| EndDate | Invoice end date – only returned if the template has an end date set |

Elements for LineItems

| Field | Description |
| --- | --- |
| Description | Description needs to be at least 1 char long. A line item with just a description (i.e no unit amount or quantity) can be created by specifying just a Description element that contains at least 1 character |
| Quantity | LineItem Quantity |
| UnitAmount | LineItem Unit Amount |
| ItemCode | See Items |
| AccountCode | See Accounts |
| TaxType | Used as an override if the default Tax Code for the selected AccountCode is not correct – see TaxTypes. |
| TaxAmount | The tax amount is auto calculated as a percentage of the line amount (see below) based on the tax rate. This value can be overriden if the calculated TaxAmount is not correct. |
| LineAmount | If you wish to omit either of the Quantity or UnitAmount you can provide a LineAmount and Xero will calculate the missing amount for you. The line amount reflects the discounted price if a DiscountRate has been used . i.e LineAmount = Quantity \* Unit Amount \* ((100 – DiscountRate)/100) |
| Tracking | Optional Tracking Category – see Tracking. Any LineItem can have a maximum of 2 TrackingCategory elements. |
| DiscountRate | Percentage discount being applied to a line item (only supported on ACCREC invoices and quotes. ACCPAY invoices and credit notes in Xero do not support discounts |

### Optional parameters

| Field | Description |
| --- | --- |
| RepeatingInvoiceID | You can specify an individual record by appending the RepeatingInvoiceID to the url |
| Where | Filter by an any element ( _see Filters_ ) |
| order | Order by any element returned ( _see Order By_ ) |

Example response when retrieving a single RepeatingInvoice

```
GET https://api.xero.com/api.xro/2.0/RepeatingInvoices/666f8dbb-bc9a-476c-8ec4-4665d7f83190
```


```
{
  "RepeatingInvoices": [
    {
      "Schedule": {
        "Period": 1,
        "Unit": "MONTHLY",
        "DueDate": 31,
        "DueDateType": "OFCURRENTMONTH",
        "StartDate": "\/Date(1519776000000+0000)\/",
        "NextScheduledDate": "\/Date(1519776000000+0000)\/"
      },
      "RepeatingInvoiceID": "666f8dbb-bc9a-476c-8ec4-4665d7f83190",
      "Type": "ACCPAY",
      "Reference": "3203",
      "HasAttachments": false,
      "ApprovedForSending": false,
      "ID": "666f8dbb-bc9a-476c-8ec4-4665d7f83190",
      "Contact": {
        "ContactID": "d6851dc2-9ed9-4515-bc0b-810b09c06a6a",
        "Name": "PowerDirect",
        "Addresses": [],
        "Phones": [],
        "ContactGroups": [],
        "ContactPersons": [],
        "HasValidationErrors": false
      },
      "Status": "DRAFT",
      "LineAmountTypes": "Exclusive",
      "LineItems": [
        {
          "Description": "Power bill",
          "UnitAmount": 295,
          "TaxType": "INPUT",
          "TaxAmount": 29.5,
          "LineAmount": 295,
          "AccountCode": "445",
          "Tracking": [],
          "Quantity": 1,
          "LineItemID": "a8fa2ef8-8286-4e9b-b1f7-19420cd7c19c"
        }
      ],
      "SubTotal": 295,
      "TotalTax": 29.5,
      "Total": 324.5,
      "CurrencyCode": "AUD"
    }
  ]
}
```


Example response when retrieving a collection of RepeatingInvoices

```
GET https://api.xero.com/api.xro/2.0/RepeatingInvoices
```


```
{
  "RepeatingInvoices": [
    {
      "Schedule": {
        "Period": 1,
        "Unit": "MONTHLY",
        "DueDate": 31,
        "DueDateType": "OFCURRENTMONTH",
        "StartDate": "\/Date(1519776000000+0000)\/",
        "NextScheduledDate": "\/Date(1519776000000+0000)\/"
      },
      "RepeatingInvoiceID": "666f8dbb-bc9a-476c-8ec4-4665d7f83190",
      "Type": "ACCPAY",
      "Reference": "3203",
      "HasAttachments": false,
      "ApprovedForSending": false,
      "ID": "666f8dbb-bc9a-476c-8ec4-4665d7f83190",
      "Contact": {
        "ContactID": "d6851dc2-9ed9-4515-bc0b-810b09c06a6a",
        "Name": "PowerDirect",
        "Addresses": [],
        "Phones": [],
        "ContactGroups": [],
        "ContactPersons": [],
        "HasValidationErrors": false
      },
      "Status": "DRAFT",
      "LineAmountTypes": "Exclusive",
      "LineItems": [
        {
          "Description": "Power bill",
          "UnitAmount": 295,
          "TaxType": "INPUT",
          "TaxAmount": 29.5,
          "LineAmount": 295,
          "AccountCode": "445",
          "Tracking": [],
          "Quantity": 1,
          "LineItemID": "a8fa2ef8-8286-4e9b-b1f7-19420cd7c19c"
        }
      ],
      "SubTotal": 295,
      "TotalTax": 29.5,
      "Total": 324.5,
      "CurrencyCode": "AUD"
    },
    ...
  ]
}
```


### Retrieving History

View a summary of the actions made by all users to the repeating invoice. See the History and Notes page for more details.

Example of retrieving a repeating invoice's history

```
GET https://api.xero.com/api.xro/2.0/RepeatingInvoices/{Guid}/History
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


### Add Notes to a Repeating Invoice

Add a note which will appear in the history against a repeating invoice. See the History and Notes page for more details.

## POST RepeatingInvoices


Use this method to create or delete one or more repeating invoice templates.

_The following are **required** to create a repeating invoice template_

| Field | Description |
| --- | --- |
| Type | Type needs to be ACCREC (Accounts Receivable) |
| Contact | See Contacts |
| Schedule |  |
| LineItems | The LineItems collection can contain any number of individual LineItem sub-elements |
| LineAmountTypes | Line amounts are exclusive of tax by default if you don't specify this element. See Line Amount Types |
| CurrencyCode | The currency that the repeating invoice has been raised in. See Currencies. Defaults to the organisation's base currency. |
| Status | One of the following : DRAFT or AUTHORISED. See Invoice Status Code |

Element for Schedule

| Field | Description |
| --- | --- |
| Period | Integer used with the unit e.g. 1 (every 1 week), 2 (every 2 months) |
| Unit | One of the following : WEEKLY or MONTHLY |
| DueDate | Integer used with due date type e.g 20 (of following month), 31 (of current month) |
| DueDateType | See Payment Terms |
| StartDate | Date the first invoice of the current version of the repeating schedule was generated (changes when repeating invoice is edited) |
| EndDate | Optional field. Date of when the repeating invoice will end |

Elements for LineItems

| Field | Description |
| --- | --- |
| Description | Description needs to be at least 1 char long. A line item with just a description (i.e no unit amount or quantity) can be created by specifying just a Description element that contains at least 1 character |
| Quantity | LineItem Quantity |
| UnitAmount | LineItem Unit Amount |
| ItemCode | See Items |
| AccountCode | See Accounts |
| TaxType | Used as an override if the default Tax Code for the selected AccountCode is not correct – see TaxTypes |
| TaxAmount | The tax amount is auto calculated as a percentage of the line amount (see below) based on the tax rate. This value can be overriden if the calculated TaxAmount is not correct. |
| LineAmount | If you wish to omit either of the Quantity or UnitAmount you can provide a LineAmount and Xero will calculate the missing amount for you. The line amount reflects the discounted price if a DiscountRate has been used .i.e LineAmount = Quantity \* Unit Amount \* ((100 – DiscountRate)/100) |
| Tracking | Optional Tracking Category – see Tracking. Any LineItem can have a maximum of 2 TrackingCategory elements. |
| DiscountRate | Percentage discount being applied to a line item (only supported on ACCREC invoices – ACC PAY invoices and credit notes in Xero do not support discounts |

### Optional parameters

| Field | Description |
| --- | --- |
| Reference | ACCREC only – additional reference number |
| BrandingThemeID | See BrandingThemes |
| ApprovedForSending | Boolean to indicate whether the invoice has been approved for sending |
| SendCopy | Boolean to indicate whether a copy is sent to sender's email |
| MarkAsSent | Boolean to indicate whether the invoice in the Xero app displays as "sent" |
| IncludePDF | Boolean to indicate whether to include PDF attachment |

### Deleting RepeatingInvoices

You can delete a repeating invoice template by updating the Status to DELETED.

Example of deleting a repeating invoice template

```
POST https://api.xero.com/api.xro/2.0/RepeatingInvoices/666f8dbb-bc9a-476c-8ec4-4665d7f83190
```


```
{
  "Schedule": {
    "Period": 1,
    "Unit": "MONTHLY",
    "DueDate": 31,
    "DueDateType": "OFCURRENTMONTH",
    "StartDate": "\/Date(1519776000000+0000)\/",
    "NextScheduledDate": "\/Date(1519776000000+0000)\/"
  },
  "RepeatingInvoiceID": "666f8dbb-bc9a-476c-8ec4-4665d7f83190",
  "Type": "ACCPAY",
  "Reference": "3203",
  "HasAttachments": false,
  "ApprovedForSending": false,
  "ID": "666f8dbb-bc9a-476c-8ec4-4665d7f83190",
  "Contact": {
    "ContactID": "d6851dc2-9ed9-4515-bc0b-810b09c06a6a",
    "Name": "PowerDirect",
    "Addresses": [],
    "Phones": [],
    "ContactGroups": [],
    "ContactPersons": [],
    "HasValidationErrors": false
  },
  "Status": "DELETED",
  "LineAmountTypes": "Exclusive",
  "LineItems": [
    {
      "Description": "Power bill",
      "UnitAmount": 295,
      "TaxType": "INPUT",
      "TaxAmount": 29.5,
      "LineAmount": 295,
      "AccountCode": "445",
      "Tracking": [],
      "Quantity": 1,
      "LineItemID": "a8fa2ef8-8286-4e9b-b1f7-19420cd7c19c"
    }
  ],
  "SubTotal": 295,
  "TotalTax": 29.5,
  "Total": 324.5,
  "CurrencyCode": "AUD"
}
```


### Emailing a repeating invoice

You can use the API to trigger the email of an approved repeating sales invoice out of Xero by setting the ApprovedForSending to true and the status to AUTHORISED.

Please note: if the StartDate on the Schedule is in the past, emails will not be automatically sent for invoices generated with past dates.

## PUT RepeatingInvoices


The PUT method is similar to the POST RepeatingInvoices method, however you can only create new repeating invoices with this method.
