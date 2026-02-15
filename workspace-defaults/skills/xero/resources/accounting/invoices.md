# Invoices


## Overview


| Property | Description |
| --- | --- |
| URL | [https://api.xero.com/api.xro/2.0/Invoices](https://api.xero.com/api.xro/2.0/Invoices) |
| Methods Supported | GET, PUT, POST |
| Description | Retrieve sales invoices or purchase bills <br>Create sales invoices or purchase bills <br>Update draft or submitted sales invoices or purchase bills <br>Delete draft sales invoices or purchase bills <br>Void approved sales invoices or purchase bills <br>Retrieve the online invoice URL for sales invoices <br>Attach files to sales invoices or purchase bills <br>Email sales invoices <br>Retrieve history for invoices and purchase bills <br>Add notes to invoices and purchase bills |

## GET Invoices


Use this method to retrieve one or many invoices.

- By default responses are formatted as XML. You can also retrieve responses in JSON format.
- When you retrieve multiple invoices, only a summary of the contact is returned and no line details are returned – this is to keep the response more compact.
- The line item details will be returned when you retrieve an individual invoice, either by specifying _Invoice ID_, _Invoice Number_, querying by _Statuses_ or by using the optional paging parameter (below).
- When you retrieve invoices by querying by _Statuses_, pagination is enforced by default.
- Individual invoices (e.g. Invoices/97c2dc5-cc47-4afd-8ec8-74990b8761e9) can also be returned as PDF's see our HTTP GET documentation

Amounts are in the invoice's currency.

The following elements are returned in the Invoices response.

| Field | Description |
| --- | --- |
| Type | See Invoice Types |
| Contact | See Contacts |
| Date | Date invoice was issued – YYYY-MM-DD |
| DueDate | Date invoice is due – YYYY-MM-DD |
| Status | See Invoice Status Codes |
| LineAmountTypes | See Line Amount Types |
| LineItems | See LineItems. The LineItems collection can contain any number of individual LineItem sub-elements. |
| SubTotal | Total of invoice excluding taxes |
| TotalTax | Total tax on invoice |
| Total | Total of Invoice tax inclusive (i.e. SubTotal + TotalTax) |
| TotalDiscount | Total of discounts applied on the invoice line items |
| UpdatedDateUTC | Last modified date UTC format |
| CurrencyCode | The currency that invoice has been raised in (see Currencies) |
| CurrencyRate | For base currency invoices, has a value of 1. For non-base-currency invoices, see CurrencyRate meaning. |
| InvoiceID | Xero generated identifier for invoice (unique within organisations) |
| InvoiceNumber | ACCREC – Unique alpha numeric code identifying invoice (printable ASCII characters only) <br>ACCPAY – non-unique alpha numeric code identifying invoice (printable ASCII characters only). This value will also display as Reference in the UI. |
| Reference | ACCREC only – additional reference number |
| BrandingThemeID | See BrandingThemes |
| Url | URL link to a source document – shown as "Go to `[appName]`" in the Xero app |
| SentToContact | Boolean to indicate whether the invoice in the Xero app displays as "sent" |
| ExpectedPaymentDate | Shown on sales invoices (Accounts Receivable) when this has been set |
| PlannedPaymentDate | Shown on bills (Accounts Payable) when this has been set |
| HasAttachments | boolean to indicate if an invoice has an attachment |
| RepeatingInvoiceID | Xero generated identifier for repeating invoice template (unique within organisations). Present only if the invoice is created as part of a Repeating Invoice. |
| Payments | See Payments |
| CreditNotes | Details of credit notes that have been applied to an invoice |
| Prepayments | See Prepayments |
| Overpayments | See Overpayments |
| AmountDue | Amount remaining to be paid on invoice |
| AmountPaid | Sum of payments received for invoice |
| CISDeduction | CISDeduction withheld by the contractor to be paid to HMRC on behalf of subcontractor (Available for organisations under UK Construction Industry Scheme) |
| FullyPaidOnDate | The date the invoice was fully paid. Only returned on fully paid invoices |
| AmountCredited | Sum of all credit notes, [over-payments](http://help.xero.com/#BankAccounts_Overpayments) and [pre-payments](http://help.xero.com/#BankAccounts_Prepayments) applied to invoice |
| SalesTaxCalculationTypeCode | See Tax calculation type. Only applicable for organisations in the US - Invoices with an auto sales tax calculation type are read only. |
| InvoiceAddresses | Only applicable for organisations in the US - Invoices with an auto sales tax calculation type are read only. |

Elements for LineItems

| Field | Descripton |
| --- | --- |
| Description | The description of the line item |
| Quantity | LineItem Quantity |
| UnitAmount | Lineitem unit amount. By default, unit amount will be rounded to two decimal places. You can opt in to use four decimal places by adding the querystring parameter unitdp=4 to your query. See the Rounding in Xero guide for more information. |
| ItemCode | See Items |
| AccountCode | See Accounts |
| AccountId | See Accounts |
| Item | Details of the item. See Items |
| LineItemID | The Xero generated identifier for a LineItem |
| TaxType | Used as an override if the default Tax Code for the selected AccountCode is not correct – see TaxTypes. |
| TaxAmount | The tax amount is auto calculated as a percentage of the line amount based on the tax rate |
| LineAmount | The line amount reflects the discounted price if a DiscountRate has been used i.e LineAmount = Quantity \* Unit Amount \* ((100 – DiscountRate)/100) |
| DiscountRate | Percentage discount being applied to a line item. Only supported on ACCREC invoices and quotes. ACCPAY invoices and credit notes in Xero do not support discounts |
| DiscountAmount | Discount amount being applied to a line item. Only supported on ACCREC invoices and quotes. ACCPAY invoices and credit notes in Xero do not support discounts |
| Tracking | Section for optional Tracking Category – see TrackingCategory. Any LineItem can have a maximum of 2 TrackingCategory elements. |
| SalesTaxCodeID | Only applicable for organisations in the US - Invoices with an auto sales tax calculation type are read only. |
| Taxability | Only applicable for organisations in the US - Invoices with an auto sales tax calculation type are read only. |
| TaxBreakdown | Only applicable for organisations in the US - Invoices with an auto sales tax calculation type are read only. |

Elements for InvoiceAddresses

| Field | Description |
| --- | --- |
| InvoiceAddressType | Indicates whether the address is defined as origin (FROM) or destination (TO) |
| AddressLine1 | First line of a physical address |
| AddressLine2 | Second line of a physical address |
| AddressLine3 | Third line of a physical address |
| AddressLine4 | Fourth line of a physical address |
| City | City of a physical address |
| Region | Region or state of a physical address |
| PostalCode | Postal code of a physical address |
| Country | Country of a physical address |

Elements for Item

| Field | Description |
| --- | --- |
| ItemID | Xero generated identifier for an item |
| Name | User defined item code |
| Code | The name of the item |

Elements for TrackingCategory

| Field | Description |
| --- | --- |
| Name | Name of the tracking category |
| TrackingCategoryID | Xero assigned unique ID for the category |
| Option | Name of the option (required) |

Elements for TaxBreakdown

| Field | Description |
| --- | --- |
| TaxComponentId | The unique ID number of the component |
| Type | The type of the jurisdiction |
| Name | The name of the jurisdiction |
| TaxPercentage | The percentage of the tax |
| TaxAmount | The amount of the tax |
| TaxableAmount | The amount that is taxable |
| NonTaxableAmount | The amount that is not taxable |
| ExemptAmount | The amount that is exempt |
| StateAssignedNo | The state assigned number of the jurisdiction |
| JurisdictionRegion | Name identifying the region within the country |

Example response when retrieving a single invoice

```
GET https://api.xero.com/api.xro/2.0/Invoices/243216c5-369e-4056-ac67-05388f86dc81
```


```
{
  "Invoices": [
    {
      "Type": "ACCREC",
      "Contact": {
        "ContactID": "025867f1-d741-4d6b-b1af-9ac774b59ba7",
        "ContactStatus": "ACTIVE",
        "Name": "City Agency",
        "Addresses": [
            { "AddressType": "STREET" },
            {
              "AddressType": "POBOX",
              "AddressLine1": "L4, CA House",
              "AddressLine2": "14 Boulevard Quay",
              "City": "Wellington",
              "PostalCode": "6012"
            }
          ],
        "Phones": [
            { "PhoneType": "DEFAULT" },
            { "PhoneType": "DDI" },
            { "PhoneType": "MOBILE" },
            { "PhoneType": "FAX" }
          ],
        "UpdatedDateUTC": "\/Date(1518685950940+0000)\/",
        "IsSupplier": "false",
        "IsCustomer": "true"
      },
      "Date": "\/Date(1518685950940+0000)\/",
      "DateString": "2009-05-27T00:00:00",
      "DueDate": "\/Date(1518685950940+0000)\/",
      "DueDateString": "2009-06-06T00:00:00",
      "Status": "AUTHORISED",
      "LineAmountTypes": "Exclusive",
      "LineItems": [
        {
          "ItemCode": "12",
          "Description": "Onsite project management ",
          "Quantity": "1.0000",
          "UnitAmount": "1800.00",
          "TaxType": "OUTPUT",
          "TaxAmount": "225.00",
          "LineAmount": "1800.00",
          "AccountCode": "200",
          "AccountId": "4f2a3169-8454-4012-a642-05a88ef32982",
          "Item": {
                        "ItemID": "fed07c3f-ca77-4820-b4df-304048b3266f",
                        "Name": "Test item",
                        "Code": "12"
                    },
          "Tracking": [
            {
              "TrackingCategoryID": "e2f2f732-e92a-4f3a9c4d-ee4da0182a13",
              "Name": "Activity/Workstream",
              "Option": "Onsite consultancy"
            }
          ],
          "LineItemID": "52208ff9-528a-4985-a9ad-b2b1d4210e38"
        }
      ],
      "SubTotal": "1800.00",
      "TotalTax": "225.00",
      "Total": "2025.00",
      "UpdatedDateUTC": "\/Date(1518685950940+0000)\/",
      "CurrencyCode": "NZD",
      "InvoiceID": "243216c5-369e-4056-ac67-05388f86dc81",
      "InvoiceNumber": "OIT00546",
      "Payments": [
        {
          "Date": "\/Date(1518685950940+0000)\/",
          "Amount": "1000.00",
          "PaymentID": "0d666415-cf77-43fa-80c7-56775591d426"
        }
      ],
      "AmountDue": "1025.00",
      "AmountPaid": "1000.00",
      "AmountCredited": "0.00"
    }
  ]
}
```


Examples response when retrieving a collection of invoices without paging

```
GET https://api.xero.com/api.xro/2.0/Invoices
```


```
{
  "Invoices": [
    {
      "Type": "ACCREC",
      "Contact": {
        "ContactID": "025867f1-d741-4d6b-b1af-9ac774b59ba7",
        "Name": "City Agency"
      },
      "Date": "\/Date(1518685950940+0000)\/",
      "DateString": "2009-05-27T00:00:00",
      "DueDate": "\/Date(1518685950940+0000)\/",
      "DueDateString": "2009-06-06T00:00:00",
      "Status": "AUTHORISED",
      "LineAmountTypes": "Exclusive",
      "SubTotal": 1800.00,
      "TotalTax": "225.00",
      "Total": "2025.00",
      "UpdatedDateUTC": "\/Date(1518685950940+0000)\/",
      "CurrencyCode": "NZD",
      "InvoiceID": "243216c5-369e-4056-ac67-05388f86dc81",
      "InvoiceNumber": "OIT00546",
      "AmountDue": "2025.00",
      "AmountPaid": "0.00",
      "AmountCredited": "0.00"
    },
    {
      "Reference": "RPT-DD",
      "Type": "ACCREC",
      "Contact": {
        "ContactID": "06638157-fdfa-47f4-91d0-875b5f5c18c6",
        "Name": "Marine Systems"
      },
      "Date": "\/Date(1518685950940+0000)\/",
      "DateString": "2009-05-27T00:00:00",
      "DueDate": "\/Date(1518685950940+0000)\/",
      "DueDateString": "2009-06-06T00:00:00",
      "Status": "AUTHORISED",
      "LineAmountTypes": "Exclusive",
      "SubTotal": "28.50",
      "TotalTax": "3.56",
      "Total": "32.06",
      "UpdatedDateUTC": "\/Date(1518685950940+0000)\/",
      "CurrencyCode": "NZD",
      "InvoiceID": "03778e72-d541-404a-ab9b-2757aeda76a3",
      "InvoiceNumber": "OIT00542",
      "AmountDue": "32.06",
      "AmountPaid": "0.00",
      "AmountCredited": "0.00"
    }
  ]
}
```


### Optional parameters for GET Invoices

| Field | Description |
| --- | --- |
| **Record filter** | You can specify an individual record by appending the value to the endpoint, i.e. `GET https://.../Invoices/{identifier}`<br>**InvoiceID** \- The Xero identifier for an Invoice <br>e.g. 297c2dc5-cc47-4afd-8ec8-74990b8761e9 <br>**InvoiceNumber** \- The InvoiceNumber <br>e.g. INV-01514 |
| Modified After | The ModifiedAfter filter is actually an HTTP header: ' **If-Modified-Since**'. <br>A UTC timestamp (yyyy-mm-ddThh:mm:ss) . Only invoices created or modified since this timestamp will be returned e.g. 2009-11-12T00:00:00 |
| IDs, InvoiceNumbers, ContactIDs, Statuses | Filter by a comma-separated list of InvoicesIDs, InvoiceNumbers, ContactIDs or Statuses. See details. |
| Where | Filter using the _where_ parameter. We recommend you limit filtering to the optimised elements only. |
| createdByMyApp | When set to true you'll only retrieve Invoices created by your app |
| order | Order by any element returned ( _see Order By_ ) |
| page | 100 invoices will be returned per call as the default when the page parameter is used by itself e.g. page=1 |
| pageSize | Used with the page parameter. Sets the # of invoices to be returned per call when the pageSize parameter is used with the page parameter e.g. page=1&pageSize=250. |
| summaryOnly | When set to true, this returns lightweight fields, excluding computation-heavy fields from the response, making the API calls quick and efficient. |
| SearchTerm | Search parameter that performs a case-insensitive text search across the fields: `InvoiceNumber`, `Reference`.<br>Example: `GET https://.../Invoices?SearchTerm="REF12"` |

### High volume threshold limit

In order to make our platform more stable, we've added a high volume threshold limit for the GET Invoices Endpoint.

- Requests that have more than 100k invoices being returned in the response will be denied and receive a 400 response code
- Requests using unoptimised fields for filtering or ordering that result in more than 100k invoices will be denied with a 400 response code

Please continue reading to find out how you can use paging and optimise your filtering to ensure your requests are always successful. Be sure to check out the Efficient Data Retrieval page for tips on query optimisation.

### Paging invoices (recommended)

By using paging all the line item details for each invoice are returned which may avoid the need to retrieve each individual invoice.

More information about retrieving paged resources.

### Optimised use of the where filter

The most common filters have been optimised to ensure performance across organisations of all sizes. We recommend you restrict your filtering to the following optimised parameters.

#### Range Operators in Where clauses

Indicated fields also support the range operators: greater than, greater than or equals, less than, less than or equals (>, >=, <, <=).

Range operators can be combined with the AND operator to query a date or numerical range. eg where=Date>=DateTime(2020, 01, 01) AND Date<DateTime(2020, 02, 01), where=AmountDue>=5000 AND AmountDue<6000

_When using individually or combined with the AND operator:_

| Field | Operator | Query |
| --- | --- | --- |
| Status | equals | where=Status="AUTHORISED" |
| Contact.ContactID | equals | where=Contact.ContactID=guid("96988e67-ecf9-466d-bfbf-0afa1725a649") |
| Contact.Name | equals | where=Contact.Name="ABC limited" |
| Contact.ContactNumber | equals | where=Contact.ContactNumber="ID001" |
| Reference | equals | where=Reference="REF12" |
| InvoiceNumber | equals | where=InvoiceNumber="INV-001" |
| InvoiceId | equals | where=InvoiceId=guid("220ddca8-3144-4085-9a88-2d72c5133734") |
| Date | equals, range | where=Date=DateTime(2020, 01, 01)<br>where=Date>DateTime(2020, 01, 01) |
| Type | equals | where=Type="ACCREC" |
| AmountDue | equals, range | where=AmountDue=1000<br>where=AmountDue<=5 |
| AmountPaid | equals | where=AmountPaid=1000 |
| DueDate | equals, range | where=DueDate=DateTime(2023,11,25)<br>where=Date<DateTime(2024, 01, 01) |

**Example:** Retrieve all ACCPAY Invoices (bills) with an AUTHORISED status

```
?where=Type=="ACCPAY" AND Status=="AUTHORISED"
```


This would translate to the following URL once encoded.

```
https://api.xero.com/api.xro/2.0/invoices?where=Type%3d%3d%22ACCPAY%22+AND+Status%3d%3d%22AUTHORISED%22
```


_When using with the OR operator:_

| Field | Operator | Query |
| --- | --- | --- |
| InvoiceId | equals | where=InvoiceId=guid("220ddca8-3144-4085-9a88-2d72c5133734") or InvoiceId=guid("88192a99-cbc5-4a66-bf1a-2f9fea2d36d0") |

Although `where=InvoiceId=guid("220ddca8-3144-4085-9a88-2d72c5133734") or InvoiceId=guid("88192a99-cbc5-4a66-bf1a-2f9fea2d36d0")` and `?IDs=220ddca8-3144-4085-9a88-2d72c5133734,88192a99-cbc5-4a66-bf1a-2f9fea2d36d0` are functionally equivalent, using `?IDs=` can reduce the size of the request. Additionally, the optimisation of the `or` operator is restricted to `InvoiceId` field only. Using `or` with other fields is not optimised and may lead to exceeding the threshold limit.

For optimal performance when querying multiple values for a field, please refer to the next section.

### Optimised filtering on a list of values

The following query parameters allow you to filter on a comma separated list of values:

| Field | Query Parameter |
| --- | --- |
| Statuses | ?Statuses=AUTHORISED,DRAFT |
| IDs | ?IDs=220ddca8-3144-4085-9a88-2d72c5133734,88192a99-cbc5-4a66-bf1a-2f9fea2d36d0 |
| InvoiceNumbers | ?InvoiceNumbers=INV-001,INV-002,INV-003 |
| ContactIDs | ?ContactIDs=3138017f-8ddc-420e-a159-e7e1cf9e643d,4b2df4a1-7aa5-4ce3-9e9c-3c55794c5283 |

**Example:** Retrieve all AUTHORISED and PAID Invoices belonging to two specific contacts

```
https://api.xero.com/api.xro/2.0/invoices?Statuses=AUTHORISED,PAID&ContactIDs=3138017f-8ddc-420e-a159-e7e1cf9e643d,4b2df4a1-7aa5-4ce3-9e9c-3c55794c5283
```


### Optimised ordering:

The following parameters are optimised for ordering:

- InvoiceId
- UpdatedDateUTC
- Date

The default order is _UpdatedDateUTC ASC, InvoiceId ASC_. Secondary ordering is applied by default using the InvoiceId. This ensures consistency across pages.

### Retrieving a smaller lightweight response using the _summaryOnly_ parameter

Use _summaryOnly=true_ in GET Invoices endpoint to retrieve a smaller version of the response object. This returns only lightweight fields, excluding computation-heavy fields from the response, making the API calls quick and efficient. The following fields will be **excluded** from the response:

- Payments
- HasAttachments
- LineItems
- CISDeduction

```
https://api.xero.com/api.xro/2.0/invoices?summaryOnly=True
```


The _summaryOnly_ parameter works with other filters, but not when filtering on the excluded fields. And when this parameter is used, pagination is enforced by default.

Examples response when retrieving a collection of invoices using paging

```
GET https://api.xero.com/api.xro/2.0/Invoices?page=1
```


```
{
  "Invoices": [
      {
        "Contact": {
          "ContactID": "9b9ba9e5-e907-4b4e-8210-54d82b0aa479",
          "Name": "PowerDirect"
        },
        "Date": "\/Date(1518685950940+0000)\/",
        "DueDate": "\/Date(1518685950940+0000)\/",
        "DateString": "2009-05-27T00:00:00",
        "DueDateString": "2009-06-06T00:00:00",
        "Status": "VOIDED",
        "LineAmountTypes": "Inclusive",
        "LineItems": [
          {
            "Description": "Monthly electricity",
            "UnitAmount": "77.39",
            "TaxType": "INPUT2",
            "TaxAmount": "11.61",
            "LineAmount": "77.39",
            "AccountCode": "445",
            "AccountId": "c2fdf2a1-d76e-4f8e-a901-27a2f46ae897",
            "Quantity": "1.0000",
            "LineItemID": "9361c7b9-7f85-44f6-9ce0-1225d63a36bd"
          }
        ],
        "SubTotal": "77.39",
        "TotalTax": "11.61",
        "Total": "89.00",
        "UpdatedDateUTC": "\/Date(1518685950940+0000)\/",
        "CurrencyCode": "NZD",
        "Type": "ACCPAY",
        "InvoiceID": "22b3fab4-ef56-4d70-a110-a7cc3c1a26cd",
        "InvoiceNumber": "Elec.",
        "AmountDue": "0.00",
        "AmountPaid": "0.00",
        "AmountCredited": "0.00",
        "CurrencyRate": "1.000000"
      },
      {
        "Contact": {
          "ContactID": "9b9ba9e5-e907-4b4e-8210-54d82b0aa479",
          "Name": "PowerDirect"
        },
        "Date": "\/Date(1518685950940+0000)\/",
        "DueDate": "\/Date(1518685950940+0000)\/",
        "DateString": "2009-05-27T00:00:00",
        "DueDateString": "2009-06-06T00:00:00",
        "Status": "PAID",
        "LineAmountTypes": "Inclusive",
        "LineItems": [
          {
            "Description": "Monthly electricity",
            "UnitAmount": "78.26",
            "TaxType": "INPUT2",
            "TaxAmount": "11.74",
            "LineAmount": "78.26",
            "AccountCode": "445",
            "AccountId": "98bfb606-a55e-4c02-ae20-2f553d3d6fd7",
            "Quantity": "1.0000",
            "LineItemID": "ba9d40de-2da8-4288-80ed-a7ececa5a343"
          }
        ],
        "SubTotal": "78.26",
        "TotalTax": "11.74",
        "Total": "90.00",
        "UpdatedDateUTC": "\/Date(1518685950940+0000)\/",
        "CurrencyCode": "NZD",
        "FullyPaidOnDate": "\/Date(1518685950940+0000)\/",
        "Type": "ACCPAY",
        "InvoiceID": "96988e67-ecf9-466d-bfbf-0afa1725a649",
        "InvoiceNumber": "RPT445-1",
        "Payments": [
          {
            "BatchPaymentID": "0a0ef7ee-7b91-46fa-8136-c4cc6287273a",
            "PaymentID": "0a0ef7ee-7b91-46fa-8136-c4cc6287273a",
            "Date": "\/Date(1518685950940+0000)\/",
            "Amount": "90.00",
            "CurrencyRate": "1.000000"
          }
        ],
        "AmountDue": "0.00",
        "AmountPaid": "90.00",
        "AmountCredited": "0.00",
        "CurrencyRate": "1.000000"
      }
    ]
    ...
}
```


## Retrieving the online invoice url


To integrate your application with Xero's online invoicing, you can retrieve the online invoice url for sales (ACCREC) invoices. Note: you cannot retrieve an online invoice url for DRAFT invoices.

Example for retrieving an online invoice url

```
GET https://api.xero.com/api.xro/2.0/Invoices/9b9ba9e5-e907-4b4e-8210-54d82b0aa479/OnlineInvoice
```


```
{
  "OnlineInvoices": [
    {
      "OnlineInvoiceUrl": "https://in.xero.com/iztKMjyAEJT7MVnmruxgCdIJUDStfRgmtdQSIW13"
    }
  ]
}
```


## POST Invoices


Use this method to create or update an invoice.

Amounts are in the invoice's currency.

**Note:** Be sure to check Organisation Actions to verify you can create invoices for the user.

_The following are **required** to create a draft invoice_

| Field | Description |
| --- | --- |
| Type | See Invoice Types |
| Contact | See Contacts |
| LineItems | See LineItems. The LineItems collection can contain any number of individual LineItem sub-elements. At least _**one**_ is required to create a complete Invoice. |

_The following are **optional** when creating or updating invoices_

| Field | Description |
| --- | --- |
| Date | Date invoice was issued – YYYY-MM-DD. If the Date element is not specified it will default to the current date based on the timezone setting of the organisation |
| DueDate | Date invoice is due – YYYY-MM-DD |
| LineAmountTypes | Line amounts are exclusive of tax by default if you don't specify this element. See Line Amount Types |
| InvoiceNumber | ACCREC – Unique alpha numeric code identifying invoice ( _when missing will auto-generate from your Organisation Invoice Settings_) (max length = 255) <br>ACCPAY – non-unique alpha numeric code identifying invoice. This value will also display as Reference in the UI. (max length = 255) |
| Reference | ACCREC only – additional reference number (max length = 255) |
| BrandingThemeID | See BrandingThemes |
| Url | URL link to a source document – shown as "Go to `[appName]`" in the Xero app |
| CurrencyCode | The currency that invoice has been raised in (see Currencies). Defaults to the organisation's base currency. |
| CurrencyRate | For how and when to set, see our multicurrency guide. |
| Status | See Invoice Status Codes |
| SentToContact | Boolean to set whether the invoice in the Xero app should be marked as "sent". This can be set only on invoices that have been approved |
| ExpectedPaymentDate | Shown on sales invoices (Accounts Receivable) when this has been set |
| PlannedPaymentDate | Shown on bills (Accounts Payable) when this has been set |

Elements for LineItems

| Field | Description |
| --- | --- |
| Description | Description needs to be at least 1 char long. A line item with just a description (i.e no unit amount or quantity) can be created by specifying just a Description element that contains at least 1 character (max length = 4000) |
| Quantity | LineItem Quantity (max length = 13) |
| UnitAmount | Lineitem unit amount. By default, unit amount will be rounded to two decimal places. You can opt in to use four decimal places by adding the querystring parameter unitdp=4 to your query. See the Rounding in Xero guide for more information. |
| ItemCode | See Items |
| AccountCode | See Accounts |
| LineItemID | The Xero generated identifier for a LineItem. It is recommended that you include LineItemIDs on update requests. If LineItemIDs are not included with line items in an update request then the line items are deleted and recreated. |
| TaxType | Used as an override if the default Tax Code for the selected AccountCode is not correct – see TaxTypes. |
| TaxAmount | The tax amount is auto calculated as a percentage of the line amount (see below) based on the tax rate. This value can be overriden if the calculated TaxAmount is not correct. |
| LineAmount | The line amount reflects the discounted price if a DiscountRate has been used i.e LineAmount = Quantity \* Unit Amount \* ((100 – DiscountRate)/100) (can't exceed 9,999,999,999.99 ) |
| DiscountRate or DiscountAmount | Percentage discount or discount amount being applied to a line item. Only supported on ACCREC invoices and quotes. ACCPAY invoices and credit notes in Xero do not support discounts |
| Tracking | Section for optional Tracking Category – see TrackingCategory. Any LineItem can have a maximum of 2 TrackingCategory elements. |

Elements for TrackingCategory

| Field | Description |
| --- | --- |
| Name | Name of the tracking category (required) |
| Option | Name of the option (required) |

### Creating, updating and deleting line items when updating invoices

In an update (POST) request:

- Providing an existing LineItem with its LineItemID will update that line item.
- Providing a LineItem with no LineItemID will create a new line item.
- Not providing an existing LineItem with it's LineItemID will result in that line item being deleted.

### Addresses on Invoices

By default, the address applied to an invoice will use the postal (POBOX) address of the Contact. However, This can be changed in Xero by applying a [custom invoice template](https://help.xero.com/nz/Q_InvoiceContact). It is not possible to manually override the address on a per-invoice basis.

### Invoice Status Codes

When creating new invoices or modifying existing invoices you can optionally specify a "Status" element. New invoices can have either one of the following three status codes :

| Field | Description |
| --- | --- |
| **Status** | **Description** |
| DRAFT | \- The default status if this element is not provided with your API call<br>\- Can contain incomplete line items (e.g. missing account codes)<br>\- No journals are created so the details will not be used in any reports |
| SUBMITTED | \- Useful if there is an approval process required<br>\- No journals are created so the details will not be used in any reports |
| AUTHORISED | \- The "approved" state of an invoice ready for sending to a customer<br>\- Journals are created in Xero so all details will be used in reports<br>\- You can now apply payments to the invoice<br>\- Once an invoice is fully paid invoice the status will change to PAID |

### Invoice status changes

The following state changes are valid when updating invoices.

| **Existing status** | **New status** |
| --- | --- |
| DRAFT | DRAFT |
| DRAFT | SUBMITTED |
| DRAFT | AUTHORISED |
| DRAFT | DELETED |
| SUBMITTED | SUBMITTED |
| SUBMITTED | AUTHORISED |
| SUBMITTED | DRAFT |
| SUBMITTED | DELETED |
| AUTHORISED | AUTHORISED |
| AUTHORISED | VOIDED |

### Updating Invoices

You can only update an invoice depending on the type of invoice, and its payment status.

|  | **ACCREC** | **ACCPAY** |
| --- | --- | --- |
| Unpaid | Yes | Yes |
| Paid (in part, or in full) | Yes – with exceptions below | No |
| In a locked period | No | No |

If an invoice is paid in part or in full, you can only update the following fields:

- `Reference`
- `DueDate`
- `InvoiceNumber`
- `BrandingThemeID`
- `Contact`, unless the payment is made with a Credit Note
- `URL`
- `LineItems`
  - `Description`
  - `AccountCode`, except for Construction Industry Scheme (CIS) account codes
  - `Tracking`

### Creating a PAID Invoice

Creating a PAID invoice is a two step process:

- First an AUTHORISED invoice needs to be made using the Invoices endpoint.
- Second a payment for the outstanding amount needs to be applied using the payments endpoint.

Once the invoice has been fully paid the system will move it to the PAID status.

Example of a draft sales ( ACCREC) invoice with enough detail to be approved once it’s been created.

```
POST https://api.xero.com/api.xro/2.0/Invoices
```


```
{
  "Type": "ACCREC",
  "Contact": {
    "ContactID": "eaa28f49-6028-4b6e-bb12-d8f6278073fc"
  },
  "Date": "\/Date(1518685950940+0000)\/",
  "DateString": "2009-05-27T00:00:00",
  "DueDate": "\/Date(1518685950940+0000)\/",
  "DueDateString": "2009-06-06T00:00:00",
  "LineAmountTypes": "Exclusive",
  "LineItems": [
    {
      "Description": "Consulting services as agreed (20% off standard rate)",
      "Quantity": "10",
      "UnitAmount": "100.00",
      "AccountCode": "200",
      "DiscountRate": "20"
    }
  ]
}
```


Example of minimum elements required to add an approved sales (ACCREC) invoice to ABC Limited

```
POST https://api.xero.com/api.xro/2.0/Invoices
```


```
{
  "Type": "ACCREC",
  "Contact": {
    "ContactID": "eaa28f49-6028-4b6e-bb12-d8f6278073fc"
  },
  "DueDate": "\/Date(1518685950940+0000)\/",
  "LineItems": [
    {
      "Description": "Services as agreed",
      "Quantity": "4",
      "UnitAmount": "100.00",
      "AccountCode": "200"
    }
  ],
  "Status": "AUTHORISED"
}
```


Example of creating a draft sales (ACCREC) invoice with a 20% discount on a line item

```
POST https://api.xero.com/api.xro/2.0/Invoices
```


```
{
  "Type": "ACCREC",
  "Contact": {
    "ContactID": "eaa28f49-6028-4b6e-bb12-d8f6278073fc"
  },
  "Date": "\/Date(1518685950940+0000)\/",
  "DateString": "2009-05-27T00:00:00",
  "DueDate": "\/Date(1518685950940+0000)\/",
  "DueDateString": "2009-06-06T00:00:00",
  "LineAmountTypes": "Exclusive",
  "LineItems": [
    {
      "Description": "Consulting services as agreed (20% off standard rate)",
      "Quantity": "10",
      "UnitAmount": "100.00",
      "AccountCode": "200",
      "DiscountRate": "20"
    }
  ]
}
```


Example of a sales (ACCREC) invoice inclusive of Tax in USD when the base currency of the org is NZD. This example also assigns a tracking category to a line item

```
POST https://api.xero.com/api.xro/2.0/Invoices
```


```
{
  "Type": "ACCREC",
  "CurrencyCode": "USD",
  "Contact": {
    "ContactID": "eaa28f49-6028-4b6e-bb12-d8f6278073fc"
  },
  "Date": "\/Date(1518685950940+0000)\/",
  "DateString": "2009-05-27T00:00:00",
  "DueDate": "\/Date(1518685950940+0000)\/",
  "DueDateString": "2009-06-06T00:00:00",
  "LineAmountTypes": "Inclusive",
  "LineItems": [
    {
      "Description": "Consulting services as agreed",
      "Quantity": "5.0000",
      "UnitAmount": "99",
      "AccountCode": "200",
      "Tracking": [
        {
          "Name": "Activity/Workstream",
          "Option": "Onsite consultancy"
        }
      ]
    }
  ]
}
```


Example of a draft sales (ACCREC) invoice **using an item code** of 2010-SWEATER-RED. NB The price and account code of the item are not given so the default sales price and account code on the item list will be used. If the UnitAmount and AccountCode element is specified then this will overide the UnitPrice value defined for the item in the item list.

```
POST https://api.xero.com/api.xro/2.0/Invoices
```


```
{
  "Type": "ACCREC",
  "Contact": {
    "ContactID": "eaa28f49-6028-4b6e-bb12-d8f6278073fc"
  },
  "Date": "\/Date(1518685950940+0000)\/",
  "DateString": "2009-05-27T00:00:00",
  "DueDate": "\/Date(1518685950940+0000)\/",
  "DueDateString": "2009-06-06T00:00:00",
  "LineAmountTypes": "Exclusive",
  "LineItems": [
    {
      "Description": "Red Sweater",
      "Quantity": "5",
      "ItemCode": "2010-SWEATER-RED"
    }
  ]
}
```


Example of a sales (ACCREC) invoice with every single element being specified:

```
POST https://api.xero.com/api.xro/2.0/Invoices
```


```
{
  "Invoices": [
    {
      "Type": "ACCREC",
      "Contact": {
        "ContactID": "eaa28f49-6028-4b6e-bb12-d8f6278073fc"
      },
      "DateString": "2009-09-08T00:00:00",
      "DueDateString": "2009-10-20T00:00:00",
      "ExpectedPaymentDate": "2009-10-20T00:00:00",
      "InvoiceNumber": "OIT:01065",
      "Reference": "Ref:SMITHK",
      "BrandingThemeID": "3b148ee0-adfa-442c-a98b-9059a73e8ef5",
      "Url": "http://www.accounting20.com",
      "CurrencyCode": "NZD",
      "Status": "SUBMITTED",
      "LineAmountTypes": "Inclusive",
      "SubTotal": "87.11",
      "TotalTax": "10.89",
      "Total": "98.00",
      "LineItems": [
        {
          "ItemCode": "Test 01",
          "Description": "3 copies of OS X 10.6 Snow Leopard",
          "Quantity": "3.0000",
          "UnitAmount": "59.00",
          "TaxType": "OUTPUT",
          "TaxAmount": "19.67",
          "LineAmount": "177.00",
          "AccountCode": "200",
          "Tracking": [
            {
              "TrackingCategoryID": "e2f2f732-e92a-4f3a-9c4d-ee4da0182a13",
              "Name": "Region",
              "Option": "North"
            }
          ]
        },
        {
          "ItemCode": "Test 02",
          "Description": "Returned Apple Keyboard with Numeric Keypad (faulty)",
          "Quantity": "1.0000",
          "UnitAmount": "-79.00",
          "TaxType": "OUTPUT",
          "TaxAmount": "-8.78",
          "LineAmount": "-79.00",
          "AccountCode": "200"
        }
      ]
    }
  ]
}
```


### Deleting and Voiding Invoices

You can delete a DRAFT or SUBMITTED invoice by updating the Status to DELETED.

If an invoice has been AUTHORISED it cannot be deleted but you can set it's status to VOIDED

If you send invoices from your app you can mark them as sent in Xero by setting SentToContact as true

Example of deleting a draft invoice

```
POST https://api.xero.com/api.xro/2.0/Invoices/INV-239
```


```
{
    "InvoiceNumber": "INV-239",
    "Status": "DELETED"
}
```


Example of voiding an approved invoice that has no payments applied to it

```
POST https://api.xero.com/api.xro/2.0/Invoices/INV-123
```


```
{
    "InvoiceNumber": "INV-123",
    "Status": "VOIDED"
}
```


Example of updating an invoice to mark it as sent

```
POST https://api.xero.com/api.xro/2.0/Invoices/8694c9c5-7097-4449-a708-b8c1982921a4
```


```
{
    "InvoiceID": "8694c9c5-7097-4449-a708-b8c1982921a4",
    "SentToContact": "true"
}
```


### SummarizeErrors

If you are entering many invoices in a single API call then we recommend you utilise our response format that shows validation errors for each invoice. Each Invoice will be returned with a status element that contains the value OK or ERROR. If an invoice has a error then one or more validation errors will be returned.

Example of the altered response format using the SummarizeErrors=false parameter

```
POST https://api.xero.com/api.xro/2.0/Invoices?SummarizeErrors=false
```


```
{
  "Invoices": [
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


### Uploading an Attachment

You can upload up to 10 attachments (each up to 25mb in size) per invoice, once the invoice has been created in Xero. To do this you'll need to know the ID of the invoice which you'll use to construct the URL when POST/PUTing a byte stream containing the attachment file. e.g. [https://api.xero.com/api.xro/2.0/Invoices/](https://api.xero.com/api.xro/2.0/Invoices/) _f0ec0d8c-6fce-4330-bb3b-8306278c6fd8_/Attachments/ _image.png_. See the Attachments page for more details.

Example of uploading an attachment

```
POST /api.xro/2.0/Invoices/f0ec0d8c-4330-bb3b-83062c6fd8/Attachments/Image002932.png
```


```
    Headers:
    Authorization: Bearer...
    Content Type: image/png
    Content-Length: 10293
    Body:
    {RAW-IMAGE-CONTENT}
```


## Emailing an invoice


You can use the API to trigger the email of a sales invoice out of Xero. The invoice must be of Type ACCREC and a valid Status for sending (SUBMITTED,AUTHORISED or PAID).

The email will be sent to the primary email address of the contact on the invoice and any additional contact persons that have IncludeInEmails flag set to true. The sender will be the user who authorised the app connection.

The subject and body of the email will generated from the organisation’s default template. You can read more about email templates [here](https://help.xero.com/EmailTemplates).

There is a daily limit per Xero organisation for sending invoices. This includes emails sent via the app and the API:

- 1,000 per day for paying organisations
- 20 per day for trial organisations
- 0 per day for demo organisations

We recommend that you monitor the number of emails sent per organisation to avoid hitting these limits. Xero monitors the emails it sends to detect potential spam and protect our email reputation. It's important to us that our customers’ email gets through. If your application receives a 400 rate limit error prior to exceeding the email limits above this is a result of the organisation being restricted due to suspicious activity. We suggest you either try again later or direct the customer to make contact with [Xero Support](https://central.xero.com/s/contact-support).

Please note: The response code returned for a successful request is a 204 (no content). Bad requests, including rate limit hits, will be returned as a 400 (e.g. if the invoice is an invalid status); this includes trying to send invoice emails from organisations who are not allowed to send emails, such as those on Xero’s Partner Edition Plans.

An example request to trigger an email

```
POST https://api.xero.com/api.xro/2.0/Invoices/aa682059-c8ec-44b9-bc7f-344c94e1ffae/Email
```


```
Request Body: <Empty>
```


## PUT Invoices


The PUT method is similar to the POST Invoices method, however you can only create new invoices with this method.

## Webhooks


You can create a subscription to get invoice events. Create and update events are available (incuding when invoices are archived). See the Webhooks page for more details.

### Retrieving History

View a summary of the actions made by all users to the invoice. See the History and Notes page for more details.

Example of retrieving a invoice's history

```
GET https://api.xero.com/api.xro/2.0/Invoices/{Guid}/History
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


### Add Notes to a Invoice

Add a note which will appear in the history against an invoice. See the History and Notes page for more details.

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
