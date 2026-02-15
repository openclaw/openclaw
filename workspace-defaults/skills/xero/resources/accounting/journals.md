# Journals


## Overview


| Property | Description |
| --- | --- |
| URL | [https://api.xero.com/api.xro/2.0/Journals](https://api.xero.com/api.xro/2.0/Journals) |
| Methods Supported | GET |
| Description | Allows you to retrieve any journals. <br>See Manual Journals if you need to create journals in Xero |

## GET Journals


Use this method to retrieve either one or many journals. A maximum of 100 journals will be returned in any response. Use the offset filter (see below) with multiple API calls to retrieve larger sets of journals. To ensure complete and accurate data extraction, we recommend clients use offset instead of Modified-Since. Journals are ordered oldest to newest.

**Note:** A partial page (fewer than 100 results) does not necessarily indicate the end of the dataset.

Response elements returned for GET Journals:

| Field | Description |
| --- | --- |
| JournalID | Xero identifier (unique within organisations) |
| JournalDate | Date the journal was posted |
| JournalNumber | Xero generated journal number |
| CreatedDateUTC | Created date UTC format |
| Reference |  |
| SourceID | The identifier for the source transaction (e.g. InvoiceID). Note: not returned when calling an individual journal by JournalID or JournalNumber. |
| SourceType | The journal source type. The type of transaction that created the journal. Note: not returned when calling an individual journal by JournalID or JournalNumber. |
| JournalLines | See JournalLines) |

Elements for Journal Lines

| Field | Description |
| --- | --- |
| JournalLineID | Xero identifier |
| AccountID | See Accounts |
| AccountCode | See Accounts |
| AccountType | See Account Types |
| AccountName | See AccountCodes |
| Description | The description from the source transaction line item. Only returned if populated. |
| NetAmount | Net amount of journal line in the organisation's base currency. This will be a positive value for a debit and negative for a credit |
| GrossAmount | Gross amount of journal line (NetAmount + TaxAmount) in the organisation's base currency. |
| TaxAmount | Total tax on a journal line in the organisation's base currency |
| TaxType | see TaxTypes |
| TaxName | see TaxRates |
| TrackingCategories | see Tracking |

### Optional parameters

| Field | Description |
| --- | --- |
| Record filter | You can specify an individual journal by appending the value to the endpoint, i.e. <br>`GET https://.../Journals/{identifier}`<br>**JournalID** – The Xero identifier for an Journal <br>e.g. 297c2dc5-cc47-4afd-8ec8-74990b8761e9 <br>**JournalNumber** – The JournalNumber <br>e.g. 100 |
| Modified After | **Not recommended.** The Modified After filter is actually an HTTP header: ' **If-Modified-Since**'. <br>A UTC timestamp (yyyy-MM-ddTHH:mm:ss). Only journals created on or after this timestamp will be returned e.g. 2009-11-12T00:00:00<br>The If-Modified-Since header may cause missing journals. Recommendation: use **offset** instead. |
| offset | Offset by a specified journal number. e.g. journals with a JournalNumber greater than the offset will be returned. |
| paymentsOnly | Set to true if you want to retrieve journals on a cash basis. Journals are returned on an accrual basis by default. |

An example response for GET Journals

```
GET https://api.xero.com/api.xro/2.0/Journals
```


```
{
  "Journals": [
    {
      "JournalID": "23ff0b88-a141-4770-8537-0dd505873b1e",
      "JournalDate": "\/Date(1475625600000+0000)\/",
      "JournalNumber": 281,
      "CreatedDateUTC": "\/Date(1510091180510+0000)\/",
      "JournalLines": [
        {
          "JournalLineID": "2e38d2d7-d2e4-4894-89e4-bb25737cb677",
          "AccountID": "dd517756-1b24-4db3-8aee-51d331039012",
          "AccountCode": "255",
          "AccountType": "CURRLIAB",
          "AccountName": "Historical Adjustment",
          "Description": "",
          "NetAmount": -4130.98,
          "GrossAmount": -4130.98,
          "TaxAmount": 0.00,
          "TaxType": "NONE",
          "TaxName": "Tax Exempt",
          "TrackingCategories": []
        },
        {
          "JournalLineID": "7be9db36-3598-4755-ba5c-c2dbc8c4a7a2",
          "AccountID": "ceef66a5-a545-413b-9312-78a53caadbc4",
          "AccountCode": "090",
          "AccountType": "BANK",
          "AccountName": "Checking Account",
          "Description": "",
          "NetAmount": 4130.98,
          "GrossAmount": 4130.98,
          "TaxAmount": 0.00,
          "TaxType": "NONE",
          "TaxName": "Tax Exempt",
          "TrackingCategories": []
        }
      ]
    }
  ...
  ]
}
```


An example of retrieving the first 100 journals, starting from the beginning of the journal list.

```
GET https://api.xero.com/api.xro/2.0/Journals?offset=0
```


```
{
  "Journals": [
    {
      "JournalID": "ee19e139-aeee-48ec-8053-35100715670d",
      "JournalDate": "\/Date(1744502400000+0000)\/",
      "JournalNumber": 1,
      "CreatedDateUTC": "\/Date(1744585658313+0000)\/",
      "JournalLines": [
        {
          "JournalLineID": "f9c93874-d1c3-4bb8-8abf-1293f7b928df",
          "AccountID": "4705a5b7-3882-438b-8bdb-7a09ca13bc82",
          "AccountCode": "800",
          "AccountType": "CURRLIAB",
          "AccountName": "Accounts Payable",
          "Description": "",
          "NetAmount": -112.70,
          "GrossAmount": -112.70,
          "TaxAmount": 0.00,
          "TrackingCategories": []
        },
        // ... more JournalLines for JournalNumber 1 ...
      ]
    },
    // ... more Journal objects (JournalNumber 2 to 99) ...
    {
      "JournalID": "51e744b9-d9c3-43ce-8228-80a19611c321",
      "JournalDate": "\/Date(1744502400000+0000)\/",
      "JournalNumber": 100,
      "CreatedDateUTC": "\/Date(1744585660103+0000)\/",
      "JournalLines": [
        {
          "JournalLineID": "604c7955-2114-40f8-99a3-f3bbed235ca1",
          "AccountID": "4705a5b7-3882-438b-8bdb-7a09ca13bc82",
          "AccountCode": "800",
          "AccountType": "CURRLIAB",
          "AccountName": "Accounts Payable",
          "Description": "",
          "NetAmount": -48.30,
          "GrossAmount": -48.30,
          "TaxAmount": 0.00,
          "TrackingCategories": []
        },
        // ... more JournalLines for JournalNumber 100 ...
      ]
    }
  ]
}
```


Next Query (if there are more journals):

As a maximum of 100 journals will be returned in any response. To retrieve the next batch of journals, the client can use the JournalNumber of the last journal in the previous response (100 in this example) as the new offset. Repeat this process until empty response received, indicating all journals have been retrieved.

```
GET https://api.xero.com/api.xro/2.0/Journals?offset=100
```


An example of syncing new journals, Assuming the highest JournalNumber currently synced and stored in your local datastore is 37.

Use this value as the offset. Continue querying the API using the latest journal number until an empty response is received, indicating all journals have been retrieved.

```
GET https://api.xero.com/api.xro/2.0/Journals?offset=37
```


If the number of new journals is less than 100, this request will return journals from JournalNumber 38 up to the newest. If there are more than 100 journals to sync, refer to the last example.

### High volume threshold limit

In order to make our platform more stable, we've added a high volume threshold limit for the GET Journals Endpoint.

The maximum journals being returned will be 100.
