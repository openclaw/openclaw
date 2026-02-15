# Manual Journals


## Overview


|  |  |
| --- | --- |
| URL | [https://api.xero.com/api.xro/2.0/ManualJournals](https://api.xero.com/api.xro/2.0/ManualJournals) |
| Methods Supported | GET, PUT, POST |
| Description | Allows you to retrieve any manual journals <br>Allows you to add or update draft or posted manual journals <br>Allows you to attach files to a manual journal |

## GET ManualJournals


Use this method to retrieve either one or many manual journals.

|  |  |
| --- | --- |
| Date | Date journal was posted – YYYY-MM-DD |
| LineAmountTypes | See Line Amount Types |
| Status | See Manual Journal Status Codes |
| Narration | Description of journal being posted |
| JournalLines |  |
| Url | Url link to a source document – shown as "Go to `[appName]`" in the Xero app |
| ShowOnCashBasisReports | Boolean – default is true if not specified |
| HasAttachments | Boolean to indicate if a manual journal has an attachment |
| UpdatedDateUTC | Last modified date UTC format |

Elements for Journal Lines. These elements are returned if they contain a value.

|  |  |
| --- | --- |
| LineAmount | total for line. Debits are positive, credits are negative value |
| AccountCode | See Accounts |
| Description | Description for journal line |
| TaxType | Used as an override if the default Tax Code for the selected AccountCode is not correct – see TaxTypes. |
| Tracking | Optional Tracking Category – see Tracking. Any JournalLine can have a maximum of 2 TrackingCategory elements. |
| TaxAmount | The calculated tax amount based on the TaxType and LineAmount |

### Optional parameters

|  |  |
| --- | --- |
| ManualJournalID | You can specify an individual record by appending the ManualJournalID to the endpoint, i.e. `GET https://.../ManualJournals/{identifier}` |
| Modified After | The ModifiedAfter filter is actually an HTTP header: ' **If-Modified-Since**'. A UTC timestamp (yyyy-mm-ddThh:mm:ss) . Only manual journals created or modified since this timestamp will be returned e.g. 2009-11-12T00:00:00 |
| Where | Filter by an any element ( _see Filters_ ) |
| order | Order by any element returned ( _see Order By_ ) |
| page | 100 manual journals will be returned per call as the default when the page parameter is used by itself e.g. page=1 |
| pageSize | Used with the page parameter. Sets the # of manual journals to be returned per call when the pageSize parameter is used with the page parameter e.g. page=1&pageSize=250. |

### High volume threshold limit

In order to make our platform more stable, we've added a high volume threshold limit for the GET Manual Journals Endpoint.

- Requests that have more than 100k manual journals being returned in the response will be denied
- Requests using unoptimised fields for filtering or ordering that result in more than 100k manual journals will be denied with a 400 response code

Please continue reading to find out how you can use paging and optimise your filtering to ensure your requests are always successful. Be sure to check out the Efficient Data Retrieval page for tips on query optimisation.

### Paging ManualJournals (recommended)

By using paging all the journal line details for each manual journal are returned which may avoid the need to retrieve each individual manual journal.

More information about retrieving paged resources.

Example response for retrieving a collection of ManualJournals without paging

```
GET https://api.xero.com/api.xro/2.0/ManualJournals
```


```
{
  "ManualJournals": [
    {
      "Date": "\/Date(1486166400000+0000)\/",
      "Status": "DRAFT",
      "LineAmountTypes": "NoTax",
      "UpdatedDateUTC": "\/Date(1291226902527+0000)\/",
      "ManualJournalID": "99ff1108-2d9a-4955-ac7e-e705aa1b9547",
      "Narration": "Prepaid our insurance a year in advance",
      "ShowOnCashBasisReports": true
    },{
      "Date": "\/Date(1488240000000+0000)\/",
      "Status": "POSTED",
      "LineAmountTypes": "NoTax",
      "UpdatedDateUTC": "\/Date(1291227505357+0000)\/",
      "ManualJournalID": "e5f09a63-62db-4739-af7c-1deda351ed5a",
      "Narration": "Prepaid our phone a year in advance",
      "ShowOnCashBasisReports": true
    }
  ]
}
```


Example response when retrieving a single manual journal

```
GET https://api.xero.com/api.xro/2.0/ManualJournals/c53ebb10-c046-471b-9919-29ac6b9fb977
```


```
{
  "ManualJournals": [
    {
      "Date": "\/Date(1486166400000+0000)\/",
      "Status": "POSTED",
      "LineAmountTypes": "NoTax",
      "UpdatedDateUTC": "\/Date(1291226902527+0000)\/",
      "ManualJournalID": "c53ebb10-c046-471b-9919-29ac6b9fb977",
      "Narration": "Coded incorrectly Office Equipment should be Computer Equipment",
      "JournalLines": [
        {
          "Description": "Coded incorrectly Office Equipment should be Computer Equipment",
          "TaxType": "NONE",
          "TaxAmount": 0.00,
          "LineAmount": -2569.00,
          "AccountCode": "720",
          "Tracking": [],
          "IsBlank": false
        },
        {
          "Description": "Coded incorrectly Computer Equipment should be Office Equipment",
          "TaxType": "NONE",
          "TaxAmount": 0.00,
          "LineAmount": 2569.00,
          "AccountCode": "710",
          "Tracking": [],
          "IsBlank": false
        }
      ],
      "ShowOnCashBasisReports": true,
      "HasAttachments": false
    }
  ]
}
```


### Optimised use of the where filter

The most common filters have been optimised to ensure performance across organisations of all sizes. We recommend you restrict your filtering to the following optimised parameters.

| Field | Operator | Query |
| --- | --- | --- |
| Narration | equals | where=Narration="narrationtext" |

**Example:** Retrieve all ManualJournals where the narration field is "mynarration":

```
?where=Narration=="mynarration"
```


This would translate to the following URL once encoded.

```
https://api.xero.com/api.xro/2.0/ManualJournals?where=Narration%3D%3D%22mynarration%22
```


### Optimised ordering

The following parameters are optimised for ordering:

- ManualJournalID
- UpdatedDateUTC
- Date

The default order is _UpdatedDateUTC ASC_.

## POST ManualJournals


Use this method to create or update a manual journal.

_The following are **mandatory** for a PUT / POST request_

|  |  |
| --- | --- |
| Narration | Description of journal being posted |
| JournalLines | The JournalLines element must contain at least two individual JournalLine sub-elements. |

_The following are **recommended** for a PUT / POST request_

|  |  |
| --- | --- |
| Date | Date journal was posted – YYYY-MM-DD. Defaults to the current date if not provided. |

_The following are **optional** for a PUT / POST request_

|  |  |
| --- | --- |
| LineAmountTypes | NoTax by default if you don't specify this element. See Line Amount Types |
| Status | See Manual Journal Status Codes |
| Url | Url link to a source document – shown as "Go to `[appName]`" in the Xero app |
| ShowOnCashBasisReports | Boolean – default is true if not specified |

Elements for Journal Lines

_The following are **mandatory** for a PUT / POST request_

|  |  |
| --- | --- |
| LineAmount | total for line. Debits are positive, credits are negative value |
| AccountCode | See Accounts |

_The following are **optional** for a PUT / POST request_

|  |  |
| --- | --- |
| Description | Description for journal line |
| TaxType | Used as an override if the default Tax Code for the selected AccountCode is not correct – see TaxTypes. |
| Tracking | Optional Tracking Category – see Tracking. Any JournalLine can have a maximum of 2 TrackingCategory elements. |

There are a few accounts that you can't use when entering manual journals in Xero. These include system accounts (accounts receivable, accounts payable & retained earnings) and bank accounts. You will receive a 400 validation error if you try and use these reserved accounts. Consider setting up one or more clearing accounts if you need to journal to a bank account.

```
POST https://api.xero.com/api.xro/2.0/ManualJournals
```


```
{
  "Narration": "Accrued expenses – prepaid insurance adjustment for January 2011",
  "JournalLines": [
    {
      "LineAmount": 55.00,
      "AccountCode": "433"
    },
    {
      "LineAmount": -55.00,
      "AccountCode": "620"
    }
  ]
}
```


Example of a new draft manual journal with optional elements

```
POST https://api.xero.com/api.xro/2.0/ManualJournals
```


```
{
  "Date": "2014-08-13",
  "Status": "DRAFT",
  "Narration": "Prepaid our phone a year in advance",
  "LineAmountTypes": "NoTax",
  "JournalLines": [
    {
      "Description": "Prepaid Annual Phone",
      "LineAmount": -1000,
      "AccountCode": "489",
      "TaxType": "NONE",
      "Tracking": [
        {
          "Name": "Region",
          "Option": "South"
        }
      ]
    },
    {
      "Description": "Prepayment",
      "LineAmount": 1000,
      "AccountCode": "620",
      "TaxType": "NONE",
      "Tracking": [
        {
          "Name": "Region",
          "Option": "South"
        }
      ]
    }
  ],
  "ShowOnCashBasisReports": "false"
}
```


## PUT ManualJournals


The PUT method is similar to the POST ManualJournals method, however you can only create new manual journals with this method.

Example request with minimum elements to add a new draft manual journal

### Uploading an Attachment

You can upload up to 10 attachments (each up to 25mb in size) per manual journal, once the manual journal has been created in Xero. To do this you'll need to know the ID of the manual journal which you'll use to construct the URL when POST/PUTing a byte stream containing the attachment file. e.g. [https://api.xero.com/api.xro/2.0/ManualJournals/](https://api.xero.com/api.xro/2.0/ManualJournals/) _f0ec0d8c-6fce-4330-bb3b-8306278c6fd8_/Attachments/ _image.png_. See the Attachments page for more details.

Example of uploading an attachment

```
POST /api.xro/2.0/ManualJournals/f0ec0d8c-4330-bb3b-83062c6fd8/Attachments/Image002932.png
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

View a summary of the actions made by all users to the Manual Journal. See the History and Notes page for more details.

### Add Notes to a Manual Journal

Add a note which will appear in the history against a Manual Journal. See the History and Notes page for more details.
