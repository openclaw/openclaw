# Contacts


## Overview


| Property | Description |
| --- | --- |
| URL | [https://api.xero.com/api.xro/2.0/Contacts](https://api.xero.com/api.xro/2.0/Contacts) |
| Methods Supported | POST, PUT, GET |
| Description | Allows you to retrieve, add and update contacts in a Xero organisation <br>Allows you to attach files to a contact <br>Allows you to retrieve history <br>Allows you to add notes |

### Important Update

The business rules around contacts in Xero may be changing in the future and 'Contact Name' may no longer be a unique field.

_We recommend all developers use ContactID to uniquely reference contacts in Xero and do not rely on ContactName as a way to reference contact data uniquely in Xero._

## GET Contacts


The following elements are returned in the Contacts response

| field | description |
| --- | --- |
| ContactID | Xero identifier (unique within organisations) |
| ContactNumber | This field is read only in the Xero UI, used to identify contacts in external systems. It is displayed as Contact Code in the Contacts UI in Xero. |
| AccountNumber | A user defined account number. This can be updated via the API and [the Xero UI](https://help.xero.com/ContactsAccountNumber) |
| ContactStatus | Current status of a contact – see contact status types |
| Name | Full name of contact/organisation |
| FirstName | First name of contact person |
| LastName | Last name of contact person |
| EmailAddress | Email address of contact person |
| SkypeUserName | \*\*This field is no longer supported\*\*. |
| BankAccountDetails | Bank account number of contact |
| CompanyNumber | Company registration number. Max 50 char. |
| TaxNumber | Tax number of contact – this is also known as the ABN (Australia), GST Number (New Zealand), VAT Number (UK) or Tax ID Number (US and global) in the Xero UI depending on which regionalized version of Xero you are using |
| TaxNumberType | Identifier of the regional type of tax number, such as US, UK, or other regional tax identifiers |
| AccountsReceivableTaxType | Default tax type used for contact on AR invoices |
| AccountsPayableTaxType | Default tax type used for contact on AP invoices |
| Addresses | Store certain address types for a contact – see address types |
| Phones | Store certain phone types for a contact – see phone types |
| IsSupplier | true or false – Boolean that describes if a contact that has any AP invoices entered against them |
| IsCustomer | true or false – Boolean that describes if a contact has any AR invoices entered against them |
| DefaultCurrency | Default currency for raising invoices against contact |
| UpdatedDateUTC | UTC timestamp of last update to contact |

The following are only retrieved on GET requests for a single contact or when pagination is used

| Field | Description |
| --- | --- |
| ContactPersons | See contact persons. A contact can have a maximum of 5 ContactPersons |
| XeroNetworkKey | Store XeroNetworkKey for contacts. |
| MergedToContactID | ID for the destination of a merged contact |
| SalesDefaultAccountCode | The default sales account code for contacts |
| PurchasesDefaultAccountCode | The default purchases account code for contacts |
| SalesTrackingCategories | The default sales tracking categories for contacts |
| PurchasesTrackingCategories | The default purchases tracking categories for contacts |
| SalesDefaultLineAmountType | The default sales line amount types for contact. Possible values INCLUSIVE, EXCLUSIVE or NONE |
| PurchasesDefaultLineAmountType | The default purchases line amount types for contact. Possible values INCLUSIVE, EXCLUSIVE or NONE |
| TrackingCategoryName | The name of the Tracking Category assigned to the contact under SalesTrackingCategories and PurchasesTrackingCategories |
| TrackingOptionName | The name of the Tracking Option assigned to the contact under SalesTrackingCategories and PurchasesTrackingCategories |
| PaymentTerms | The default payment terms for the contact – see Payment Terms |
| ContactGroups | Displays which contact groups a contact is included in |
| Website | Website address for contact |
| BrandingTheme | Default branding theme for contact – see Branding Themes |
| BatchPayments | batch payment details for contact |
| Discount | The default discount rate for the contact |
| Balances | The raw AccountsReceivable(sales invoices) and AccountsPayable(bills) outstanding and overdue amounts, converted to base currency |
| HasAttachments | A boolean to indicate if a contact has an attachment |

Elements for ContactPerson

| Field | Description |
| --- | --- |
| FirstName | First name of person |
| LastName | Last name of person |
| EmailAddress | Email address of person |
| IncludeInEmails | boolean to indicate whether contact should be included on emails with invoices etc. |

### Optional parameters for GET Contacts

| Field | Description |
| --- | --- |
| **Record filter** | You can specify an individual record by appending the value to the endpoint, i.e. `GET https://.../Contacts/{identifier}`<br>* * *<br>**ContactID** – The Xero identifier for a contact e.g. 297c2dc5-cc47-4afd-8ec8-74990b8761e9<br>* * *<br>**ContactNumber** – A custom identifier specified from another system e.g. a CRM system has a contact number of CUST100 |
| Modified After | The ModifiedAfter filter is actually an HTTP header: ' **If-Modified-Since**'. A UTC timestamp (yyyy-mm-ddThh:mm:ss) . Only contacts created or modified since this timestamp will be returned e.g. 2009-11-12T00:00:00 **Note:** changes to the Balances, IsCustomer or IsSupplier values will not trigger a contact to be returned with the Modified-After filter |
| IDs | Filter by a comma-separated list of ContactIDs. Allows you to retrieve a specific set of contacts in a single call. See details. |
| Where | Filter using the _where_ parameter. We recommend you limit filtering to the optimised elements only. |
| order | Order by any element returned ( _see Order By_ ) |
| page | 100 contacts will be returned per call as the default when the page parameter is used by itself e.g. page=1 |
| pageSize | Used with the page parameter. Sets the # of contacts to be returned per call when the pageSize parameter is used with the page parameter e.g. page=1&pageSize=250. |
| includeArchived | e.g. includeArchived=true – Contacts with a status of ARCHIVED will be included in the response |
| summaryOnly | When set to true, this returns lightweight fields, excluding computation-heavy fields from the response, making the API calls quick and efficient. More details here. |
| searchTerm | Search parameter that performs a case-insensitive text search across the fields: Name, FirstName, LastName, ContactNumber, CompanyNumber, EmailAddress. |

### High volume threshold limit

In order to make our platform more stable, we've added a high volume threshold limit for the GET Contacts Endpoint.

- Requests that have more than 100k contacts being returned in the response will be denied
- Requests using unoptimised fields for filtering or ordering that result in more than 100k contacts will be denied with a 400 response code

Please continue reading to find out how you can use paging and optimise your filtering to ensure your requests are always successful. Be sure to check out the Efficient Data Retrieval page for tips on query optimisation.

### Paging contacts (recommended)

By using paging all the elements in each individual contact are returned in the response which avoids the need to retrieve each individual contact to get all the details (GET Contacts without paging only returns a subset of elements)

More information about retrieving paged resources.

### Optimised use of the where filter

The most common filters have been optimised to ensure performance across organisations of all sizes. We recommend you restrict your filtering to the following optimised parameters. These parameters are case- and accent-insensitive and should not be appended with `ToLower()` or `ToUpper()`.

_When using individually or combined with the AND operator:_

| Field | Operator | Query |
| --- | --- | --- |
| Name | equals | where=Name="ABC limited" |
| EmailAddress | equals | where=EmailAddress=" [email@example.com](mailto:email@example.com)" |
| AccountNumber | equals | where=AccountNumber="ABC-100" |

### Optimised filtering on a list of values

The IDs query parameter allows you to filter based on a list of ContactIDs:

| field | query parameter |
| --- | --- |
| IDs | ?IDs=220ddca8-3144-4085-9a88-2d72c5133734,88192a99-cbc5-4a66-bf1a-2f9fea2d36d0 |

### Optimised ordering:

The following parameters are optimised for ordering:

- ContactID
- UpdatedDateUTC
- Name

The default order is _UpdatedDateUTC ASC, ContactID ASC_. Secondary ordering is applied by default using the ContactID. This ensures consistency across pages.

### Avoid unoptimised filtering:

For large organisations, unoptimised queries can result in request rejections and hitting system thresholds. The following examples of unoptimised queries are quite common, but there are more efficient alternatives available.

**Example 1:** Retrieve all contacts with specific text in the contact name

Unoptimised queries:

```
Contacts?where=Name.Contains("Peter")
Contacts?where=Name.StartsWith("P")
Contacts?where=Name.EndsWith("r")
```


Optimised query:

```
Contacts?SearchTerm=peter
Contacts?SearchTerm=p
Contacts?SearchTerm=r
```


**Example 2:** Retrieve all contacts whose email address starts with specific text

Unoptimised query:

```
EmailAddress!=null&&EmailAddress.StartsWith("boom")
```


Optimised query:

```
Contacts?SearchTerm=boom
```


For both examples, using an exact match on the `Name` or `EmailAddress` field with the `=` operator will have the best performance.

### Retrieving a smaller lightweight response using the 'summaryOnly' parameter

Use _summaryOnly=true_ in GET Contacts endpoint to retrieve a smaller version of the response object. This returns only lightweight fields, excluding computation-heavy fields from the response, making the API calls quick and efficient. The following fields will be **excluded** from the response:

- Addresses
- Balances
- ContactGroups
- ContactPersons
- IsCustomer
- IsSupplier
- PurchasesDefaultAccountCode
- PurchasesTrackingCategories
- SalesDefaultAccountCode
- SalesTrackingCategories

```
https://api.xero.com/api.xro/2.0/contacts?summaryOnly=True
```


The _summaryOnly_ parameter works with other filters, but not when filtering on the excluded fields. And when this parameter is used, pagination is enforced by default.

Example response for GET Contacts

```
{
  "Contacts": [
    {
      "ContactID": "bd2270c3-8706-4c11-9cfb-000b551c3f51",
      "ContactStatus": "ACTIVE",
      "Name": "ABC Limited",
      "FirstName": "Andrea",
      "LastName": "Dutchess",
      "CompanyNumber": "NumberBusiness1234",
      "EmailAddress": "a.dutchess@abclimited.com",
      "BankAccountDetails": "45465844",
      "TaxNumber": "415465456454",
      "AccountsReceivableTaxType": "INPUT2",
      "AccountsPayableTaxType": "OUTPUT2",
      "Addresses": [
        {
          "AddressType": "POBOX",
          "AddressLine1": "P O Box 123",
          "City": "Wellington",
          "PostalCode": "6011",
          "AttentionTo": "Andrea"
        },{
          "AddressType": "STREET"
        }
      ],
      "Phones": [
        {
          "PhoneType": "DEFAULT",
          "PhoneNumber": "1111111",
          "PhoneAreaCode": "04",
          "PhoneCountryCode": "64"
        },{
          "PhoneType": "FAX"
        },{
          "PhoneType": "MOBILE"
        },{
          "PhoneType": "DDI"
        }
      ],
      "UpdatedDateUTC": "\/Date(1488391422280+0000)\/",
      "IsSupplier": false,
      "IsCustomer": true,
      "DefaultCurrency": "NZD"
    },{
      "ContactID": "6d42f03b-181f-43e3-93fb-2025c012de92"
      ...
    }
  ]
}
```


Example response for an individual contact

```
{
  "Contacts": [
    {
      "ContactID": "bd2270c3-8706-4c11-9cfb-000b551c3f51",
      "ContactStatus": "ACTIVE",
      "Name": "ABC Limited",
      "FirstName": "Andrea",
      "LastName": "Dutchess",
      "CompanyNumber": "NumberBusiness1234",
      "EmailAddress": "a.dutchess@abclimited.com",
      "BankAccountDetails": "45465844",
      "TaxNumber": "415465456454",
      "AccountsReceivableTaxType": "INPUT2",
      "AccountsPayableTaxType": "OUTPUT2",
      "Addresses": [
        {
          "AddressType": "POBOX",
          "AddressLine1": "P O Box 123",
          "City": "Wellington",
          "PostalCode": "6011",
          "AttentionTo": "Andrea"
        },{
          "AddressType": "STREET"
        }
      ],
      "Phones": [
        {
          "PhoneType": "DEFAULT",
          "PhoneNumber": "1111111",
          "PhoneAreaCode": "04",
          "PhoneCountryCode": "64"
        },{
          "PhoneType": "FAX"
        },{
          "PhoneType": "MOBILE"
        },{
          "PhoneType": "DDI"
        }
      ],
      "UpdatedDateUTC": "\/Date(1488391422280+0000)\/",
      "IsSupplier": false,
      "IsCustomer": true,
      "DefaultCurrency": "NZD"
    }
  ]
}
```


## CIS Settings (UK)


If you are a UK organisation or contractor registered under Construction Industry Scheme, you can retrieve CIS settings for your contacts to identify if it is a CIS subcontractor and also get the CIS deduction rate.

If the contact has never been enabled as a CIS subcontractor then this endpoint will return a 404.

The following is returned for the CIS settings of a contact

| Field | Description |
| --- | --- |
| CISEnabled | true or false – Boolean that describes if the contact is a CIS Subcontractor |
| Rate | CIS Deduction rate for the contact if he is a subcontractor. If the contact is not CISEnabled, then the rate is not returned |

Example of retrieving CIS settings for a contact

```
{
  "CISSettings": [
    {
      "CISEnabled": true,
      "Rate": 20
    }
  ]
}
```


## POST Contacts


Use this method to create or update one or more contact records

When you are updating a contact you don’t need to specify every element. If you exclude an element then the existing value will be preserved.

The following is required to create a contact

| Field | Description |
| --- | --- |
| Name | Full name of contact/organisation (max length = 255). Does not support: angle brackets, white space at the start or end, or repeating spaces. |

The following are optional when creating/updating contacts

| Field | Description |
| --- | --- |
| ContactID | Xero identifier |
| ContactNumber | This can be updated via the API only i.e. This field is read only on the Xero contact screen, used to identify contacts in external systems (max length = 50). If the Contact Number is used, this is displayed as Contact Code in the Contacts UI in Xero. |
| AccountNumber | A user defined account number. This can be updated via the API and [the Xero UI](https://help.xero.com/ContactsAccountNumber) (max length = 50) |
| ContactStatus | Current status of a contact – see contact status types |
| FirstName | First name of contact person (max length = 255) |
| LastName | Last name of contact person (max length = 255) |
| CompanyNumber | Company registration number. Max 50 char. |
| EmailAddress | Email address of contact person (umlauts not supported) (max length = 255) |
| SkypeUserName | \*\*This field is no longer supported\*\*. |
| ContactPersons |  |
| BankAccountDetails | Bank account number of contact |
| TaxNumber | Tax number of contact – this is also known as the ABN (Australia), GST Number (New Zealand), VAT Number (UK) or Tax ID Number (US and global) in the Xero UI depending on which regionalized version of Xero you are using (max length = 50) |
| AccountsReceivableTaxType | Default tax type used for contact on AR invoices |
| AccountsPayableTaxType | Default tax type used for contact on AP invoices |
| Addresses | Store certain address types for a contact – see address types |
| Phones | Store certain phone types for a contact – see phone types |
| IsSupplier | true or false – Boolean that describes if a contact that has any AP invoices entered against them. Cannot be set via PUT or POST – it is automatically set when an accounts payable invoice is generated against this contact. |
| IsCustomer | true or false – Boolean that describes if a contact has any AR invoices entered against them. Cannot be set via PUT or POST – it is automatically set when an accounts receivable invoice is generated against this contact. |
| DefaultCurrency | Default currency for raising invoices against contact |
| XeroNetworkKey | Store XeroNetworkKey for contacts. |
| SalesDefaultAccountCode | The default sales account code for contacts |
| PurchasesDefaultAccountCode | The default purchases account code for contacts |
| SalesTrackingCategories | The default sales tracking categories for contacts |
| PurchasesTrackingCategories | The default purchases tracking categories for contacts |
| TrackingCategoryName | The name of the Tracking Category assigned to the contact under SalesTrackingCategories and PurchasesTrackingCategories |
| TrackingOptionName | The name of the Tracking Option assigned to the contact under SalesTrackingCategories and PurchasesTrackingCategories |
| PaymentTerms | The default payment terms for the contact – see Payment Terms |

Example of minimum elements required to add a new contact

```
{
  "Name": "ABC Limited"
}
```


Example of minimum elements required to add many contacts

```
{
  "Contacts": [
    {
      "Name": "ABC Limited"
    },{
      "Name": "DEF Limited"
    }
  ]
}
```


Example of creating a contact record with additional contact people

```
{
  "Contacts": [
    {
      "Name": "24 locks",
      "FirstName": "Ben",
      "LastName": "Bowden",
      "EmailAddress": "ben.bowden@24locks.com",
      "ContactPersons": [
        {
          "FirstName": "John",
          "LastName": "Smith",
          "EmailAddress": "john.smith@24locks.com",
          "IncludeInEmails": "true"
        }
      ]
    }
  ]
}
```


Example of updating a contact

```
{
  "ContactID": "eaa28f49-6028-4b6e-bb12-d8f6278073fc",
  "ContactNumber": "ID001",
  "Name": "ABC Limited",
  "FirstName": "John",
  "LastName": "Smith",
  "EmailAddress": "john.smith@gmail.com",
  "Addresses": [
    {
      "AddressType": "POBOX",
      "AddressLine1": "P O Box 123",
      "City": "Wellington",
      "PostalCode": "6011"
    }
  ],
  "BankAccountDetails": "01-0123-0123456-00",
  "TaxNumber": "12-345-678",
  "AccountsReceivableTaxType": "OUTPUT",
  "AccountsPayableTaxType": "INPUT",
  "DefaultCurrency": "NZD"
}
```


Example of archiving a contact

```
{
  "ContactID": "9b9ba7f9-7eab-465d-8d10-d74d4f8a9ab7",
  "ContactStatus": "ARCHIVED"
}
```


### Uploading an Attachment

You can upload up to 10 attachments (each up to 25mb in size) per contact, once the contact has been created in Xero. To do this you'll need to know the ID of the contact which you'll use to construct the URL when POST/PUTing a byte stream containing the attachment file. e.g. [https://api.xero.com/api.xro/2.0/Contacts/](https://api.xero.com/api.xro/2.0/Contacts/) _f0ec0d8c-6fce-4330-bb3b-8306278c6fd8_/Attachments/ _image.png_. See the Attachments page for more details.

Example of uploading an attachment to a contact

```
POST https://api.xero.com/api.xro/2.0/Contacts/f0ec0d8c-4330-bb3b-83062c6fd8/Attachments/Image002932.png
```


```
Headers:
Authorization: Bearer...
Content Type: image/png
Content-Length: 10293
Body:
{RAW-IMAGE-CONTENT}
```


## PUT Contacts


Use this method to create one or more contact records. This method works very similar to POST Contacts but if an existing contact matches your ContactName or ContactNumber then you will receive an error.

## Webhooks


You can create a subscription to get contact events. Create and update events are available (incuding when contacts are archived). See the Webhooks page for more details.

### Retrieving History

View a summary of the actions made by all users to the contact. See the History and Notes page for more details.

Example of retrieving a contact's history

```
GET https://api.xero.com/api.xro/2.0/Contacts/{Guid}/History
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


### Add Notes to a Contact

Add a note which will appear in the history against a contact. See the History and Notes page for more details.

Example of creating a note against a contact

```
PUT https://api.xero.com/api.xro/2.0/Contacts/{Guid}/History
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
