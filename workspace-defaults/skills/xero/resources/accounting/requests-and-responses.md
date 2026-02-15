# HTTP Requests and Responses

## HTTP GET


### Retrieving individual resources

To retrieve a specific resource you can append its identifier to the end of the URL. The example below shows retrieving a specific contact using the HTTP GET method.

```
https://api.xero.com/api.xro/2.0/Contacts/fe61ead1-8afc-4f0b-beda-066620227aad
```


- Successful responses return with a HTTP 200 status code
- By default all successful responses on the accounting API are returned as XML. Responses on the other APIs will vary.
- Individual Invoices, Individual Quotes and Credit Notes can also be returned in PDF format by setting the “Accept” value in the http header to “application/pdf”.
- Some documents may have attachments. You can retrieve these via the API too. Learn More

### JSON responses and date formats

JSON formatted responses are also supported by setting the “Accept” value in the http header to “application/json” when making a request.

At Xero we use .NET, and used the Microsoft .NET JSON date format available at the time of original development. We know it's ugly but not something we can fix without a breaking change or a new version of the API. We're really sorry about this. To help you along, below we explain how to handle this date format. An example date/time in JSON is returned like this:

_"DateTimeUTC": "\\/Date(1439434356790)\\/"_ or _"PeriodLockDate": "\\/Date(1419937200000+0000)\\/"_

In both cases, the date/time value is a unix timestamp value, but in miliseconds rather than seconds (so divide by 1,000 for seconds). For some elements we also include a date string value on JSON responses to help with reading date values. e.g. DateString, DueDateString.

### All resources

With some endpoints you may need to retrieve a full list of resources e.g. TaxRates or BrandingThemes. You can do this by simply using a HTTP GET with the resource name.

```
GET https://api.xero.com/api.xro/2.0/TaxRates
```


We recommend all calls to any endpoints that have large result sets use the if-modified-since parameter.

### Retrieving modified resources

The easiest way to retrieve resources that have been created or modified since a previous request is to specify a UTC timestamp filter using the If-Modified-Since http parameter. Only items created or updated since the specified timestamp will be returned (accurate to the second).

**Please note:** Not all changes will trigger a change of the UpdatedDateUTC field. These include changes to partially paid transactions which don't generate a journal such as DueDate or SentToContact, and Contact fields pulled from other sources such as Balances, IsSupplier, and isCustomer. As a result, transactions with these changes may not be returned with an If-Modified-Since query.

### Retrieving paged resources

To ensure efficiency when retrieving multiple records, paging is recommended.

Paged results are available on the Invoices, Contacts, CreditNotes, BankTransactions, ManualJournals, Payments, PurchaseOrders, Prepayments and Overpayments endpoints. For endpoints with summarised unpaginated behaviour e.g. Contacts details on an invoice, paged results will have extra detail (e.g. line items) and may mean you don’t have to retrieve individual resources to get the information you need.

To utilise paging you must append a page query parameter to the URL e.g. `?page=1`.

In addition to paging, you can set the page size to determine the number of items returned per page. The default page size is 100, with a maximum of 1000 and a minimum of 1. If users set a value outside the supported range, we automatically adjust it to the nearest supported page size. For example, `?page=1&pageSize=5000` will return 1000 items. If users don't specify a value, the default is applied. For example, `?page=1` would return 100 items.

The example below shows the response users will receive if they use the query `https://.../BankTransactions?page=1&pageSize=10`. A `Pagination` object is returned as part of the HTTP response, containing the paging metadata.

```
{
  "Id": "...",
  "Status": "OK",
  "DateTimeUTC": "...",
  "pagination": {
    "page": 1,
    "pageSize": 10,
    "pageCount": 1,
    "itemCount": 1
  },
  "BankTransactions": [
    {
      "BankTransactionID": "...",
      "Type": "SPEND",
      "Reference": "BT-1",
      "IsReconciled": false,
      "HasAttachments": false,
      ...
    }
  ]
}
```


Sample HTTP response in XML

```
<Response xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Id>...</Id>
  <Status>OK</Status>
  <DateTimeUTC>...</DateTimeUTC>
  <pagination>
    <page>1</page>
    <pageSize>10</pageSize>
    <pageCount>1</pageCount>
    <itemCount>1</itemCount>
  </pagination>
  <BankTransactions>
    <BankTransaction>
      ...
    </BankTransaction>
  </BankTransactions>
</Response>
```


Previously, to fetch all pages, it was recommended to continue to fetch the next page until no more items are returned. e.g. If there are 100 records in the response you will need to check if there is any more items by fetching the next page e.g. `?page=2` and continuing this process until no more items are returned. This is superseded by the pagination object.

### Retrieving a filtered set of resources

The number of parameters is only limited by the maximum url length. To ensure you receive a timely response from the API, we recommend you look to retrieve in a batch of 40.

Our busiest endpoints ( Invoices and Contacts ) have explicit query parameters for commonly used filters. These parameters allow you to pass a comma-separated list of values in a single request. For faster response times we recommend using these where available.

**Example 1 :** Retrieve Invoices with specific InvoiceID(s)

```
GET https://.../Invoices?IDs=220ddca8-3144-4085-9a88-2d72c5133734,88192a99-cbc5-4a66-bf1a-2f9fea2d36d0
```


**Example 2 :** Retrieve all Invoices for a specific set of Contacts

```
GET https://.../Invoices?ContactIDs=3138017f-8ddc-420e-a159-e7e1cf9e643d,4b2df4a1-7aa5-4ce3-9e9c-3c55794c5283
```


**Example 3 :** Retrieve all unpaid Invoices against a particular Contact

```
GET https://.../Invoices?ContactIDs=3138017f-8ddc-420e-a159-e7e1cf9e643d&Statuses=AUTHORISED
```


**Example 4 :** Retrieve all DELETED or VOIDED Invoices

```
GET https://.../Invoices?Statuses=DELETED,VOIDED
```


### Retrieving a filtered set of resources using the “where” parameter

The where parameter allows you to filter on endpoints and elements that don't have explicit parameters.

- it can reference most elements on the resource.
- it must be encoded using percent encoding before it is appended to the URL.

**Please note:** even though the where filter supports complex queries we recommend you keep them as simple as possible. Long, complex where queries can cause time outs. To ensure your calls run efficiently against larger organisations it's a good idea to restrict your queries to simple == operations. For more information on optimised queries, please refer to tips to efficient data retrieval.

**Example 1 :** Retrieve all Bank Accounts using the Accounts endpoint

```
Type=="BANK"
```


This would translate to the following URL once percent encoded.

```
https://api.xero.com/api.xro/2.0/Accounts?where=Type%3D%3D%22BANK%22
```


**Example 2:** Retrieve all invoices with AmountDue amount greater than a specific amount, and DueDate after a date using the Invoices endpoint (use `and` or `&&` to connect conditions)

```
AmountDue > 5000 and DueDate > DateTime(2015, 01, 01)
```


**Example 3:** Retrieve invoices with an invoice date between a date range

```
Date >= DateTime(2015, 01, 01) && Date < DateTime(2015, 12, 31)
```


### Retrieving a smaller lightweight response using the “SummaryOnly” parameter

Use _summaryOnly=true_ in GET Contacts and Invoices endpoint to retrieve a smaller version of the response object. This returns only lightweight fields, excluding computation-heavy fields from the response, making the API calls quick and efficient.

**Please note:** This query parameter works with other filters, but not when filtering on the fields that are exluded in the response.

To get more details around what fields are excluded, please refer to the Contacts and Invoices documentation.

**Example 1 :** Retrieve smaller lightweight response for Get Invoices

```
https://api.xero.com/api.xro/2.0/invoices?summaryOnly=True
```


**Example 2 :** Retrieve smaller lightweight response for Get Contacts

```
https://api.xero.com/api.xro/2.0/contacts?summaryOnly=True
```


### Ordering of results

A list of items can be returned in a specific order. To specify the ordering, append an order query string to the endpoint URL.

Example : To order contacts by email address the following url could be used

```
https://api.xero.com/api.xro/2.0/Contacts?order=EmailAddress
```


You can get results in descending order by using DESC parameter.

```
https://api.xero.com/api.xro/2.0/Contacts?order=EmailAddress%20DESC
```


Secondary ordering, using the ID field, is now applied by default across a range of endpoints – Contacts, Payments, Batch Payments, Credit Notes, Invoices and Bank Transactions. This will ensure consistency in ordering across pages. The default order is `UpdatedDateUTC ASC`, `[ID] ASC`.

## HTTP POST and PUT


### Creating resources

The HTTP PUT and POST methods are used for sending information to the API.

- A PUT method will create new data in Xero, whereas a POST will either create new data or update existing data in Xero.
- XML or JSON formatted requests are accepted.
- Supported Content-Types include:
– application/x-www-form-urlencoded
  - application/xml
  - application/json
- The Encoding type should be set as “UTF-8”

You should check the response from each API call and not assume that it will be completed successfully. This includes

- checking that you get a HTTP 200 response and a status of OK. Learn more
- checking that you have received an identifier (e.g. InvoiceID) for the new object created.

### Creating many resources

It is possible to submit more than one invoice, credit note, contact, item or other entities of the same type in a single API call. If you plan to submit more than one entity per API call, we recommend that you append the summarizeErrors=false querystring to your API call. This ensures that every entity is returned back to you, each having their own status attribute.

```
POST /api.xro/2.0/Invoices?summarizeErrors=false
```


**Note:** The summarizeErrors option is only available for the Accounting API. The summarizeErrors option will not affect AU Payroll API calls.

The following xml is a sample response of a bulk upload to the Invoices endpoint.

- A status attribute is included for each Invoice can be OK, WARNING or ERROR.
- If you have a validation error in any of your objects you will receive a HTTP 200 status code (rather than HTTP 400) if you are using the summarizeErrors parameter

```
{
  "Invoices": [{
    "InvoiceID": "5ceffde5-6786-4987-b03a-bf88d262c286",
    ...
    "StatusAttributeString": "OK"
  },{
    "InvoiceID": "5ceffde5-6786-4987-b03a-bf88d262c286",
    ...
    "StatusAttributeString": "OK"
  },{
    "InvoiceID": "5ceffde5-6786-4987-b03a-bf88d262c286",
    ...
    "StatusAttributeString": "WARNING",
    "Warnings": [{
      "Message": "Only AUTHORISED invoices may have SentToContact updated."
      }]
  },{
    "InvoiceID": "5ceffde5-6786-4987-b03a-bf88d262c286",
    ...
    "StatusAttributeString": "ERROR",
    "ValidationErrors": [{
      "Description": "Invoice not of valid type for creation"
      }]
  }]
}
```


- A WARNING status indicated that the entity was successfully processed, but there are additional warnings added to the response.
- An ERROR status indicates that the entity could not be saved to Xero due to a validation error.

### Updating resources

When using POST to update an invoice or contact, you can specify the id of the object being updated in the url: e.g

```
https://api.xero.com/api.xro/2.0/Invoices/INV-000394
```


### Debugging requests and responses

If you receive a HTTP 400 response this is due to a validation error. The response will include an "APIException" element that contains a useful summary of the reason for the validation error. Learn more
