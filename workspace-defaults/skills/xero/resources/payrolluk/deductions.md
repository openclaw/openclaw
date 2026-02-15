# Deductions

## Overview


|  |  |
| --- | --- |
| URLs | `https://api.xero.com/payroll.xro/2.0/deductions`<br>`https://api.xero.com/payroll.xro/2.0/deductions/{deductionID}` |
| Methods Supported | GET, POST |
| Description | Allows you to retrieve all the deductions in Payroll for a Xero organisation. <br>Allows you to retrieve details of a deduction in a Xero organisation |

## GET All Deductions


`GET https://api.xero.com/payroll.xro/2.0/deductions`

Retrieves all the deductions for an organisation

### Optional Parameters

|  |  |
| --- | --- |
| Page | Page number which specifies the set of records to retrieve. <br>By default the number of the records per set is 100. <br>Example: `https://api.xero.com/payroll.xro/2.0/deductions?page=2` to get the second set of the records. <br>When page value is not a number or a negative number, by default, the first set of records is returned. |

### Elements for Deductions

|  |  |
| --- | --- |
| DeductionId | The Xero identifier for Deduction |
| DeductionName | Name of the deduction |
| DeductionCategory | Deduction Category type, see Deduction Categories |
| LiabilityAccountId | Xero identifier for Liability Account |
| CurrentRecord | Identifier of a record is active or not. |
| StandardAmount | Standard amount of the deduction |
| ReducesSuperLiability | Standard amount of the deduction |
| ReducesTaxLiability | Standard amount of the deduction |
| CalculationType | determine the calculation type whether fixed amount ot percentage of gross |
| percentage | Percentage of gross |
| subjectToNIC | Identifier of subject To NIC |
| subjectToTax | Identifier of subject To Tax |
| isReducedByBasicRate | Identifier of reduced by basic rate applicable or not |
| applyToPensionCalculations | Identifier for apply to pension calculations |
| isCalculatingOnQualifyingEarnings | Identifier of calculating on qualifying earnings |
| IsPension | Identifier of applicable for pension or not |

Example for GET deductions – 200 OK Response

```
GET https://api.xero.com/payroll.xro/2.0/deductions
```


```
{
    "id": "3e3d46ec-6aef-ddaf-3489-83c8ce4ea290",
    "providerName": "!YLT5Y",
    "dateTimeUTC": "2018-02-05T00:37:06.7040779",
    "httpStatusCode": "OK",
    "pagination": {
        "page": 1,
        "pageSize": 100,
        "pageCount": 1,
        "itemCount": 5
    },
    "problem": null,
    "deductions": [
        {
            "deductionId": "44e61eaa-d1c8-4a16-a18b-0688f9b3db7f",
            "deductionName": "Pension - Employee Contribution",
            "deductionCategory": "StakeholderPension",
            "liabilityAccountId": "b60ab41d-1388-4f82-85e1-462df91015d3",
            "currentRecord": true,
            "standardAmount": null,
            "reducesSuperLiability": null,
            "reducesTaxLiability": null,
            "calculationType": null,
            "percentage": null,
            "subjectToNIC": null,
            "subjectToTax": null,
            "isReducedByBasicRate": null,
            "applyToPensionCalculations": null,
            "isCalculatingOnQualifyingEarnings": null,
            "isPension": null
        },
        {
            "deductionId": "be9ded58-45f5-4903-808b-f666d1a4e6f9",
            "deductionName": "Test (NPA)",
            "deductionCategory": "StakeholderPension",
            "liabilityAccountId": "ae4404d2-c148-4eaf-a9c9-f749b2b9f461",
            "currentRecord": true,
            "standardAmount": null,
            "reducesSuperLiability": null,
            "reducesTaxLiability": null,
            "calculationType": "PercentageOfPreTax",
            "percentage": 1,
            "subjectToNIC": null,
            "subjectToTax": null,
            "isReducedByBasicRate": null,
            "applyToPensionCalculations": false,
            "isCalculatingOnQualifyingEarnings": false,
            "isPension": true
        },
        {
            "deductionId": "f2791242-0145-497a-a322-ebab78b547e2",
            "deductionName": "Post Tax 10%",
            "deductionCategory": "StakeholderPensionPostTax",
            "liabilityAccountId": "44b497f7-cdee-487f-b7af-d34a14232fa2",
            "currentRecord": true,
            "standardAmount": null,
            "reducesSuperLiability": null,
            "reducesTaxLiability": null,
            "calculationType": "PercentageOfPreTax",
            "percentage": 10,
            "subjectToNIC": null,
            "subjectToTax": null,
            "isReducedByBasicRate": true,
            "applyToPensionCalculations": null,
            "isCalculatingOnQualifyingEarnings": true,
            "isPension": true
        },
        {
            "deductionId": "4849ecd6-5ccf-40ce-8f0c-613018faf419",
            "deductionName": "Student Loan Deductions",
            "deductionCategory": "StudentLoanDeductions",
            "liabilityAccountId": "44b497f7-cdee-487f-b7af-d34a14232fa2",
            "currentRecord": true,
            "standardAmount": null,
            "reducesSuperLiability": null,
            "reducesTaxLiability": null,
            "calculationType": null,
            "percentage": null,
            "subjectToNIC": null,
            "subjectToTax": null,
            "isReducedByBasicRate": null,
            "applyToPensionCalculations": null,
            "isCalculatingOnQualifyingEarnings": null,
            "isPension": null
        },
        {
            "deductionId": "8f77af9f-249f-4bcd-81d1-da81517631ef",
            "deductionName": "Test (NPA)",
            "deductionCategory": "StakeholderPension",
            "liabilityAccountId": "ae4404d2-c148-4eaf-a9c9-f749b2b9f461",
            "currentRecord": true,
            "standardAmount": null,
            "reducesSuperLiability": null,
            "reducesTaxLiability": null,
            "calculationType": "PercentageOfPreTax",
            "percentage": 1,
            "subjectToNIC": null,
            "subjectToTax": null,
            "isReducedByBasicRate": null,
            "applyToPensionCalculations": false,
            "isCalculatingOnQualifyingEarnings": false,
            "isPension": true
        }
    ]
}
```


## GET Deduction By ID


`GET https://api.xero.com/payroll.xro/2.0/Deductions/{deductionID}`

Retrieves detailed information for a deduction by its unique identifier

### Elements for Deduction

|  |  |
| --- | --- |
| DeductionId | The Xero identifier for Deduction |
| DeductionName | Name of the deduction |
| DeductionCategory | Deduction Category type, see Deduction Categories |
| LiabilityAccountId | Xero identifier for Liability Account |
| CurrentRecord | Identifier of a record is active or not. |
| StandardAmount | Standard amount of the deduction |
| ReducesSuperLiability | Standard amount of the deduction |
| ReducesTaxLiability | Standard amount of the deduction |
| CalculationType | determine the calculation type whether fixed amount ot percentage of gross |
| percentage | Percentage of gross |
| subjectToNIC | Identifier of subject To NIC |
| subjectToTax | Identifier of subject To Tax |
| isReducedByBasicRate | Identifier of reduced by basic rate applicable or not |
| applyToPensionCalculations | Identifier for apply to pension calculations |
| isCalculatingOnQualifyingEarnings | Identifier of calculating on qualifying earnings |
| IsPension | Identifier of applicable for pension or not |

Example response for GET Deduction by ID – 200 OK Response

```
GET https://api.xero.com/payroll.xro/2.0/deductions/7011a9c9-7d49-4c36-beae-9b159d775316
```


```
{
    "id": "dce1f2c8-bde7-767d-92fc-f7af1d485a6a",
    "providerName": "!YLT5Y",
    "dateTimeUTC": "2018-02-06T00:24:24.8073952",
    "httpStatusCode": "OK",
    "pagination": null,
    "problem": null,
    "deduction": {
        "deductionId": "7011a9c9-7d49-4c36-beae-9b159d775316",
        "deductionName": "Pension - Employee Contribution",
        "deductionCategory": "StakeholderPension",
        "liabilityAccountId": "b60ab41d-1388-4f82-85e1-462df91015d3",
        "currentRecord": true,
        "standardAmount": null,
        "reducesSuperLiability": null,
        "reducesTaxLiability": null,
        "calculationType": null,
        "percentage": null,
        "subjectToNIC": null,
        "subjectToTax": null,
        "isReducedByBasicRate": null,
        "applyToPensionCalculations": null,
        "isCalculatingOnQualifyingEarnings": null,
        "isPension": null
    }
}
```


Example response for GET Deduction by ID – 404 Not Found Response

```
GET https://api.xero.com/payroll.xro/2.0/deductions/7011a9c9-7d49-4c36-beae-9b159d775317
```


```
{
    "id": "dce1f2c8-bde7-767d-92fc-f7af1d485a6a",
    "providerName": "!YLT5Y",
    "dateTimeUTC": "2018-02-06T00:25:04.4855257",
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
    "deduction": null
}
```


## Post a Deduction


`POST https://api.xero.com/payroll.xro/2.0/deductions`

Adds a deduction

### Required elements for posting a deduction in the Request

_The following elements are **required** to add a new deduction_

|  |  |
| --- | --- |
| DeductionName | Name of the deduction |
| DeductionCategory | Deduction Category type, see Deduction Categories |
| LiabilityAccountId | The Xero identifier for Liability Account for the deduction |
| CalculationType | Calculation type for the deduction (either fixed amount ot percentage of gross) |

Example for POST a deduction with minimum elements required – 200 OK Response

```
POST https://api.xero.com/payroll.xro/2.0/deductions
```


Request Body

```
{
    "deductionName": "Test deduction",
    "deductionCategory": "StakeholderPension",
    "liabilityAccountId": "b60ab41d-1388-4f82-85e1-462df91015d3",
    "calculationType": "PercentageOfGross"
}
```


Response Body

```
{
    "id": "775323a4-cabd-0a4b-fad5-fd56eab875b7",
    "providerName": "!YLT5Y",
    "dateTimeUTC": "2018-03-27T04:40:11.3249959",
    "httpStatusCode": "OK",
    "pagination": null,
    "problem": null,
    "deduction": {
        "deductionId": "cf6d4ae9-ad80-447c-9ec2-f658fa98d6a1",
        "deductionName": "Test deduction",
        "deductionCategory": "StakeholderPension",
        "liabilityAccountId": "b60ab41d-1388-4f82-85e1-462df91015d3",
        "currentRecord": true,
        "standardAmount": null,
        "reducesSuperLiability": null,
        "reducesTaxLiability": null,
        "calculationType": "PercentageOfGross",
        "percentage": null,
        "subjectToNIC": null,
        "subjectToTax": null,
        "isReducedByBasicRate": null,
        "applyToPensionCalculations": null,
        "isCalculatingOnQualifyingEarnings": null,
        "isPension": true
    }
}
```


Example for POST a deduction – 400 Bad Request Response

```
POST https://api.xero.com/payroll.xro/2.0/deductions
```


```
Empty Request Body
```


Response Body

```
{
    "id": "775323a4-cabd-0a4b-fad5-fd56eab875b7",
    "providerName": "!YLT5Y",
    "dateTimeUTC": "2018-03-27T04:45:18.9726126",
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
                "name": "LiabilityAccountID",
                "reason": "The Liability Account is required"
            },
            {
                "name": "DeductionCategory",
                "reason": "The Deduction Category is required"
            },
            {
                "name": "DeductionName",
                "reason": "The Deduction Name is required"
            },
            {
                "name": "CalculationType",
                "reason": "Calculation Type is required"
            }
        ]
    },
    "deduction": null
}
```
