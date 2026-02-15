# Employer Pensions

## Overview


|  |  |
| --- | --- |
| URLs | `https://api.xero.com/payroll.xro/2.0/benefits`<br>`https://api.xero.com/payroll.xro/2.0/benefits/{employerPensionID}` |
| Methods Supported | GET, POST |
| Description | Allows you to retrieve all the employer pensions in Payroll for a Xero organisation. <br>Allows you to retrieve details of an employer pension in a Xero organisation |

## GET All Employer Pensions


`GET https://api.xero.com/payroll.xro/2.0/benefits`

Retrieves all the employer pensions for an organisation

### Optional Parameters

|  |  |
| --- | --- |
| Page | Page number which specifies the set of records to retrieve. <br>By default the number of the records per set is 100. <br>Example: `https://api.xero.com/payroll.xro/2.0/benefits?page=2` to get the second set of the records. <br>When page value is not a number or a negative number, by default, the first set of records is returned. |

### Elements for employer pensions

|  |  |
| --- | --- |
| Id | The Xero identifier for the employer pension |
| Name | Name of the employer pension |
| Category | Category type of the employer pension |
| LiabilityAccountId | Xero identifier for Liability Account |
| ExpenseAccountId | Xero identifier for Expense Account |
| StandardAmount | Standard amount of the employer pension |
| Percentage | Percentage of gross of the employer pension |
| CalculationType | Calculation Type of the employer pension (FixedAmount or PercentageOfGross). |
| CurrentRecord | Identifier of a record is active or not. |
| SubjectToNIC | Identifier of subject To NIC |
| SubjectToPension | Identifier of subject To pension |
| SubjectToTax | Identifier of subject To Tax |
| IsCalculatingOnQualifyingEarnings | Identifier of calculating on qualifying earnings |

Example for GET employer pensions – 200 OK Response

```
GET https://api.xero.com/payroll.xro/2.0/benefits
```


```
{
    "id": "91696cef-095e-95f3-6a34-941f1c0c5f7f",
    "providerName": "!YLT5Y",
    "dateTimeUTC": "2018-02-08T22:55:33.0126735",
    "httpStatusCode": "OK",
    "pagination": {
        "page": 1,
        "pageSize": 100,
        "pageCount": 1,
        "itemCount": 3
    },
    "problem": null,
    "benefits": [
        {
            "id": "c1d53440-8759-4243-b996-eed4bc57cde0",
            "name": "Pension – Employer Contribution",
            "category": "StakeholderPension",
            "liabilityAccountId": "b60ab41d-1388-4f82-85e1-462df91015d3",
            "expenseAccountId": "2725818f-5d44-4c48-a6df-0459f78652d4",
            "standardAmount": null,
            "percentage": 2,
            "calculationType": "PercentageOfGross",
            "showBalanceToEmployee": false,
            "currentRecord": true,
            "subjectToNIC": null,
            "subjectToPension": null,
            "subjectToTax": null,
            "isCalculatingOnQualifyingEarnings": null
        },
        {
            "id": "406298e8-102a-45c6-b570-eb0eaa82ec5d",
            "name": "Test",
            "category": "StakeholderPension",
            "liabilityAccountId": "ae4404d2-c148-4eaf-a9c9-f749b2b9f461",
            "expenseAccountId": "2725818f-5d44-4c48-a6df-0459f78652d4",
            "standardAmount": null,
            "percentage": 1,
            "calculationType": "PercentageOfGross",
            "showBalanceToEmployee": false,
            "currentRecord": true,
            "subjectToNIC": null,
            "subjectToPension": null,
            "subjectToTax": null,
            "isCalculatingOnQualifyingEarnings": false
        },
        {
            "id": "2b805fda-9530-4180-af73-eaadbe921802",
            "name": "Test",
            "category": "StakeholderPension",
            "liabilityAccountId": "ae4404d2-c148-4eaf-a9c9-f749b2b9f461",
            "expenseAccountId": "2725818f-5d44-4c48-a6df-0459f78652d4",
            "standardAmount": null,
            "percentage": 1,
            "calculationType": "PercentageOfGross",
            "showBalanceToEmployee": false,
            "currentRecord": true,
            "subjectToNIC": null,
            "subjectToPension": null,
            "subjectToTax": null,
            "isCalculatingOnQualifyingEarnings": false
        }
    ]
}
```


## GET Employer Pension By ID


`GET https://api.xero.com/payroll.xro/2.0/benefits/{employerPensionID}`

Retrieves detailed information for an employer pension by its unique identifier

### Elements for employer pension

|  |  |
| --- | --- |
| Id | The Xero identifier for the employer pension |
| Name | Name of the employer pension |
| Category | Category type of the employer pension |
| LiabilityAccountId | Xero identifier for Liability Account |
| ExpenseAccountId | Xero identifier for Expense Account |
| StandardAmount | Standard amount of the employer pension |
| Percentage | Percentage of gross of the employer pension |
| CalculationType | Calculation Type of the employer pension (FixedAmount or PercentageOfGross). |
| CurrentRecord | Identifier of a record is active or not. |
| SubjectToNIC | Identifier of subject To NIC |
| SubjectToPension | Identifier of subject To pension |
| SubjectToTax | Identifier of subject To Tax |
| IsCalculatingOnQualifyingEarnings | Identifier of calculating on qualifying earnings |

Example response for GET employer pension by ID – 200 OK Response

```
GET https://api.xero.com/payroll.xro/2.0/benefits/3c14c245-8131-41df-b5f6-c433aabe51e9
```


```
{
    "id": "b9cbdef1-21c7-4b87-0fa4-cf3d6d522d03",
    "providerName": "!YLT5Y",
    "dateTimeUTC": "2018-02-12T00:55:28.2348482",
    "httpStatusCode": "OK",
    "pagination": null,
    "problem": null,
    "benefit": {
        "id": "f0fc7f8a-0580-4a38-9824-22fbc0e7bc7a",
        "name": "Pension – Employer Contribution",
        "category": "StakeholderPension",
        "liabilityAccountId": "b60ab41d-1388-4f82-85e1-462df91015d3",
        "expenseAccountId": "2725818f-5d44-4c48-a6df-0459f78652d4",
        "standardAmount": null,
        "percentage": 2,
        "calculationType": "PercentageOfGross",
        "showBalanceToEmployee": false,
        "currentRecord": true,
        "subjectToNIC": null,
        "subjectToPension": null,
        "subjectToTax": null,
        "isCalculatingOnQualifyingEarnings": null
    }
}
```


Example response for GET employer pension by ID – 404 Not Found Response

```
GET https://api.xero.com/payroll.xro/2.0/benefits/08afa2e2-3710-4a2b-9009-189e64d6acf8
```


```
{
    "id": "b9cbdef1-21c7-4b87-0fa4-cf3d6d522d03",
    "providerName": "!YLT5Y",
    "dateTimeUTC": "2018-02-12T00:55:57.2774932",
    "httpStatusCode": "NotFound",
    "pagination": null,
    "problem": {
        "type": "about:blank",
        "title": "NotFound",
        "status": 404,
        "detail": "Resource was not found",
        "instance": null,
        "invalidFields": null
    },
    "benefit": null
}
```


## Post an Employer Pension


`POST https://api.xero.com/payroll.xro/2.0/benefits`

Adds an employer pension

### Required elements for posting an employer pension in the Request

_The following elements are **required** to add a new employer pension_

|  |  |
| --- | --- |
| Name | Name of the employer pension |
| Category | Category type of the employer pension (StakeholderPension or Other) |
| LiabilityAccountId | The Xero identifier for Liability Account for the employer pension |
| ExpenseAccountId | The Xero identifier for Expense Account for the employer pension |
| CalculationType | Calculation Type of the employer pension either FixedAmount or PercentageOfGross |
| Percentage | Percentage of gross for the employer pension (required for PercentageOfGross calculation type) |
| StandardAmount | Standard Amount for the employer pension (required for FixedAmount calculation type) |

Example for POST an employer pension with minimum elements required – 200 OK Response

```
POST https://api.xero.com/payroll.xro/2.0/benefits
```


Request Body

```
{
    "name": "Test Benefit",
    "category": "StakeholderPension",
    "liabilityAccountId": "b60ab41d-1388-4f82-85e1-462df91015d3",
    "expenseAccountId": "2725818f-5d44-4c48-a6df-0459f78652d4",
    "percentage": 2,
    "calculationType": "PercentageOfGross"
}
```


Response Body

```
{
    "id": "2ed44f73-29c8-c6e8-91f4-81c9fed21ce3",
    "providerName": "!YLT5Y",
    "dateTimeUTC": "2018-03-28T03:51:35.6686748",
    "httpStatusCode": "OK",
    "pagination": null,
    "problem": null,
    "benefit": {
        "id": "3414c09b-619c-450f-acc5-3b19ee4f413e",
        "name": "Test Benefit",
        "category": "StakeholderPension",
        "liabilityAccountId": "b60ab41d-1388-4f82-85e1-462df91015d3",
        "expenseAccountId": "2725818f-5d44-4c48-a6df-0459f78652d4",
        "standardAmount": null,
        "percentage": 2,
        "calculationType": "PercentageOfGross",
        "currentRecord": true,
        "showBalanceToEmployee": true,
        "subjectToNIC": null,
        "subjectToPension": null,
        "subjectToTax": null,
        "isCalculatingOnQualifyingEarnings": null
    }
}
```


Example for POST an employer pension – 400 Bad Request Response

```
POST https://api.xero.com/payroll.xro/2.0/benefits
```


```
Empty Request Body
```


Response Body

```
{
    "id": "2ed44f73-29c8-c6e8-91f4-81c9fed21ce3",
    "providerName": "!YLT5Y",
    "dateTimeUTC": "2018-03-28T03:52:48.1040596",
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
                "name": "Category",
                "reason": "The Benefit Category is required"
            },
            {
                "name": "LiabilityAccountID",
                "reason": "The Liability Account is required"
            },
            {
                "name": "ExpenseAccountID",
                "reason": "The Expense Account is required"
            },
            {
                "name": "Name",
                "reason": "The Benefit Name is required"
            }
        ]
    },
    "benefit": null
}
```
