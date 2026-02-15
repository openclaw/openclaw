# Reimbursements

## Overview


|  |  |
| --- | --- |
| URLs | `https://api.xero.com/payroll.xro/2.0/reimbursements`<br>`https://api.xero.com/payroll.xro/2.0/reimbursements/{reimbursementID}` |
| Supported Methods | GET, POST |
| Description | Allows you to retrieve payroll all reimbursements in a Xero organisation <br>Allows you to retrieve details of a reimbursement in a Xero organisation <br>Allows you to add a reimbursement in a Xero organisation |

## GET Reimbursements


`GET https://api.xero.com/payroll.xro/2.0/reimbursements`

Retrieve all reimbursements

### Optional Parameters

|  |  |
| --- | --- |
| Page | Page number which specifies the set of records to retrieve. <br>By default the number of the records per set is 100. <br>Example: `https://api.xero.com/payroll.xro/2.0/reimbursements?page=2` to get the second set of the records. <br>When page value is not a number or a negative number, by default, the first set of records is returned. |

### Elements of Reimbursement

|  |  |
| --- | --- |
| ReimbursementID | Xero unique identifier for a reimbursement |
| Name | Name of the reimbursement |
| AccountID | Xero unique identifier for the account used for the reimbursement |
| CurrentRecord | True or False. Indicates that whether the reimbursement is active |

Example response for GET Reinbursements – 200 OK Response

```
GET https://api.xero.com/payroll.xro/2.0/reimbursements
```


```
{
    "id": "df851dbe-deae-4811-8eae-1b8a7070e028",
    "providerName": "Payroll Test",
    "dateTimeUTC": "2018-02-06T00:41:47.9853084",
    "httpStatusCode": "OK",
    "pagination": {
        "page": 1,
        "pageSize": 100,
        "pageCount": 1,
        "itemCount": 5
    },
    "problem": null,
    "reimbursements": [
        {
            "reimbursementID": "fb960860-5a5c-44ed-bfb5-67ad649417ab",
            "name": "Travel Allowance",
            "accountID": "3a60f925-98c1-4de2-8bbb-e236bc7eed29",
            "currentRecord": true
        },
        {
            "reimbursementID": "4c991494-5f9f-4e75-b788-492720b73507",
            "name": "Mileage",
            "accountID": "c8775516-b713-422d-89b3-ea8055d2e5cd",
            "currentRecord": true
        },
        {
            "reimbursementID": "060c0261-58a5-4b41-b8cf-09820c752650",
            "name": "Parking Expenses",
            "accountID": "c8775516-b713-422d-89b3-ea8055d2e5cd",
            "currentRecord": true
        },
        {
            "reimbursementID": "b6c47264-b69c-4f51-8197-fcc4a5e86206",
            "name": "Office Supplies",
            "accountID": "27be5af0-1d08-4819-aea2-130ff4493a28",
            "currentRecord": true
        },
        {
            "reimbursementID": "b08282f1-6143-4971-8d9e-482720cdc345",
            "name": "Other Reimbursable Costs",
            "accountID": "27be5af0-1d08-4819-aea2-130ff4493a28",
            "currentRecord": true
        }
    ]
}
```


## GET Reimbursement By ID


`GET https://api.xero.com/payroll.xro/2.0/reimbursements/{ReimbursementID}`

Retrieve the details of a reimbursement

### Elements of Reimbursement

|  |  |
| --- | --- |
| ReimbursementID | Xero unique identifier for a reimbursement |
| Name | Name of the reimbursement |
| AccountID | Xero unique identifier for the account used for the reimbursement |
| CurrentRecord | True or False. Indicates that whether the reimbursement is active |

Example response for GET Earning Rate by ID – 200 OK Response

```
GET https://api.xero.com/payroll.xro/2.0/reimbursements/e7348062-0d4c-4d40-9daa-43e92cbcd531
```


```
{
    "id": "77ba172e-058d-ab51-c34b-9f6d661835a8",
    "providerName": "Payroll Test",
    "dateTimeUTC": "2018-02-06T05:45:52.1214921",
    "httpStatusCode": "OK",
    "pagination": null,
    "problem": null,
    "reimbursement": {
        "reimbursementID": "e7348062-0d4c-4d40-9daa-43e92cbcd531",
        "name": "Travel Allowance",
        "accountID": "3a60f925-98c1-4de2-8bbb-e236bc7eed29",
        "currentRecord": true
    }
}
```


## POST Reimbursement


`POST https://api.xero.com/payroll.xro/2.0/reimbursements`

Add a reimbursement

### Elements of Reimbursement

|  |  |
| --- | --- |
| Name | Name of the reimbursement |
| AccountID | Xero unique identifier for the account used for the reimbursement |

Example response for POST a Reinbursement – 200 OK Response

```
POST https://api.xero.com/payroll.xro/2.0/reimbursements
```


Request Body

```
{
  "name": "Test Reimbursement",
  "accountID": "3a60f925-98c1-4de2-8bbb-e236bc7eed29"
}
```


Response Body

```
{
  "id": "86130206-a478-623d-26ea-e4edd54dd0a2",
  "providerName": "!YLT5Y",
  "dateTimeUTC": "2018-03-22T04:12:07.3947141",
  "httpStatusCode": "OK",
  "pagination": null,
  "problem": null,
  "reimbursement": {
      "reimbursementID": "1ed448da-41e4-4b24-a273-c39abe35ec83",
      "name": "Test Reimbursement",
      "accountID": "3a60f925-98c1-4de2-8bbb-e236bc7eed29",
      "currentRecord": true
  }
}
```


Example for POST a Reinbursement – 400 Bad Request

```
POST https://api.xero.com/payroll.xro/2.0/reimbursements
```


Request Body

```
{
  "name": "Test Reimbursement"
}
```


Response Body

```
{
  "id": "86130206-a478-623d-26ea-e4edd54dd0a2",
  "providerName": "!YLT5Y",
  "dateTimeUTC": "2018-03-22T04:15:48.4585951",
  "httpStatusCode": "BadRequest",
  "pagination": null,
  "problem": {
      "type": "application/problem+json",
      "title": "BadRequest",
      "status": 400,
      "detail": "Validation error occurred.",
      "instance": null,
      "invalidFields": [
          {
              "name": "AccountID",
              "reason": "The Account is required"
          }
      ]
  },
  "reimbursement": null
}
```
