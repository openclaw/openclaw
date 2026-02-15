# Salary and Wages

## Overview


|  |  |
| --- | --- |
| URLs | `https://api.xero.com/payroll.xro/2.0/employees/{EmployeeID}/salaryAndWages`<br>`https://api.xero.com/payroll.xro/2.0/employees/{EmployeeID}/salaryAndWages/{salaryandwagesID}` |
| Supported Methods | GET, POST, PUT, DELETE |
| Description | Allows you to retrieve all the salary and wages in Payroll for an employee in a Xero organisation. <br>Allows you to retrieve salary and wages details for an employee in a Xero organisation. <br>Allows you to add a salary and wages record in Payroll for an employee in a Xero organisation. <br>Allows you to update a salary and wages record in Payroll for an employee in a Xero organisation. <br>Allows you to delete a salary and wages record in Payroll for an employee in a Xero organisation. |
| Limitations | Salary and wages are not applicable for off-payroll workers |

## GET Salary and wages


`GET https://api.xero.com/payroll.xro/2.0/employees/{EmployeeID}/salaryAndWages`

Retrieves all the salary and wages for an active employee

### Optional Parameters

|  |  |
| --- | --- |
| Page | Page number which specifies the set of records to retrieve. <br>By default the number of the records per set is 100. <br>Example: `https://api.xero.com/payroll.xro/2.0/employees/{EmployeeID}/salaryAndWages?page=2` to get the second set of the records. <br>When page value is not a number or a negative number, by default, the first set of records is returned. |

### Elements for salary and wages

| Element Name | Element Description |
| --- | --- |
| SalaryAndWagesID | Xero unique identifier for a salary and wages record |
| EarningsRateID | Xero unique identifier for an earnings rate |
| NumberOfUnitsPerWeek | The Number of Units per week for the corresponding salary and wages |
| RatePerUnit | The rate of each unit for the corresponding salary and wages |
| NumberOfUnitsPerDay (deprecated) | The Number of Units per day for the corresponding salary and wages (deprecated, use `working-pattern`) |
| EffectiveFrom | The effective date of the corresponding salary and wages |
| AnnualSalary | The annual salary |
| Status | The current status of the corresponding salary and wages |
| PaymentType | The type of the payment of the corresponding salary and wages |
| MinimumContractedHoursPerWeek | Only required if the linked earnings rate has a `typeOfUnit` of `hourly` and `NumberOfUnitsPerWeek` is `0`. The minimum number of hours per week an employee is contracted for |

Example response for GET all salary and wages of an employee – 200 OK Response

```
GET https://api.xero.com/payroll.xro/2.0/employees/35cdd697-c9fc-4931-b579-a18cb8b6fe14/salaryAndWages
```


```
{
    "id": "0172b72a-08ab-1349-d4b3-43af6fdfae06",
    "providerName": "!YLT5Y",
    "dateTimeUTC": "2017-11-08T02:51:16.7929843",
    "httpStatusCode": "OK",
    "pagination": {
        "page": 1,
        "pageSize": 100,
        "pageCount": 1,
        "itemCount": 5
    },
    "problem": null,
    "salaryAndWages": [
        {
            "salaryAndWagesID": "ceca84b6-82f7-4d5e-8ac4-865b5abceca0",
            "earningsRateID": "4b85f7f4-548c-4cd6-9902-ed77ea121053",
            "numberOfUnitsPerWeek": 0,
            "ratePerUnit": null,
            "daysPerWeek": 0,
            "effectiveFrom": null,
            "annualSalary": 0,
            "status": "Active",
            "paymentType": "Salary",
            "minimumContractedHoursPerWeek": null
        },
        {
            "salaryAndWagesID": "33872474-64ac-4369-a88a-d56ccb04df09",
            "earningsRateID": "4b85f7f4-548c-4cd6-9902-ed77ea121053",
            "numberOfUnitsPerWeek": 0,
            "ratePerUnit": null,
            "daysPerWeek": 0,
            "effectiveFrom": "2014-01-06T00:00:00",
            "annualSalary": 0,
            "status": "Active",
            "paymentType": "Salary",
            "minimumContractedHoursPerWeek": null
        },
        {
            "salaryAndWagesID": "4789b7f9-9347-4015-89fe-3bd351a69de1",
            "earningsRateID": "4b85f7f4-548c-4cd6-9902-ed77ea121053",
            "numberOfUnitsPerWeek": 0,
            "ratePerUnit": null,
            "daysPerWeek": 0,
            "effectiveFrom": "2014-01-06T00:00:00",
            "annualSalary": 0,
            "status": "Active",
            "paymentType": "Salary",
            "minimumContractedHoursPerWeek": null
        },
        {
            "salaryAndWagesID": "2ec7c840-9235-4631-a5a7-5c09df6edea0",
            "earningsRateID": "4b85f7f4-548c-4cd6-9902-ed77ea121053",
            "numberOfUnitsPerWeek": 0,
            "ratePerUnit": null,
            "daysPerWeek": 0,
            "effectiveFrom": "2014-01-06T00:00:00",
            "annualSalary": 0,
            "status": "Active",
            "paymentType": "Salary",
            "minimumContractedHoursPerWeek": null
        },
        {
            "salaryAndWagesID": "84bb57cf-3d96-4713-9588-fc178ace8be9",
            "earningsRateID": "4b85f7f4-548c-4cd6-9902-ed77ea121053",
            "numberOfUnitsPerWeek": 0,
            "ratePerUnit": null,
            "daysPerWeek": 0,
            "effectiveFrom": "2014-01-06T00:00:00",
            "annualSalary": 0,
            "status": "Active",
            "paymentType": "Salary",
            "minimumContractedHoursPerWeek": null
        }
    ]
}
```


Example response for GET all salary and wages of an employee – 404 Not Found Response

```
GET https://api.xero.com/payroll.xro/2.0/employees/35cdd697-c9fc-4931-b579-a18cb8b6fe14/salaryAndWages
```


```
{
    "id": "c4be24e5-e840-4c92-9eaa-2d86cd596314",
    "providerName": "!YLT5Y",
    "dateTimeUTC": "2017-09-15T03:51:43.3204368",
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
    "salaryAndWages": null
}
```


## GET Salary and Wages by Employee ID


`GET https://api.xero.com/payroll.xro/2.0/employees/{EmployeeID}/salaryAndWages/{salaryandwagesID}`

Retrieves detailed information of a salary and wages record for an employee by its unique identifier

### Elements for salary and wages

| Element Name | Element Description |
| --- | --- |
| SalaryAndWagesID | Xero unique identifier for the salary and wages |
| EarningsRateID | Xero unique identifier for an earnings rate |
| NumberOfUnitsPerWeek | The Number of Units per week for the corresponding salary and wages |
| RatePerUnit | The rate of each unit for the corresponding salary and wages |
| NumberOfUnitsPerDay (deprecated) | The Number of Units per day for the corresponding salary and wages (deprecated, use `working-pattern`) |
| EffectiveFrom | The effective date of the corresponding salary and wages |
| AnnualSalary | The annual salary. |
| Status | The current status of the corresponding salary and wages |
| PaymentType | The type of the payment of the corresponding salary and wages |
| MinimumContractedHoursPerWeek | Only required if the linked earnings rate has a `typeOfUnit` of `hourly` and `NumberOfUnitsPerWeek` is `0`. The minimum number of hours per week an employee is contracted for |

Example response for GET salary and wages by ID – 200 OK Response

```
GET https://api.xero.com/payroll.xro/2.0/employees/4b85f7f4-548c-4cd6-9902-ed77ea121053/salaryAndWages/ceca84b6-82f7-4d5e-8ac4-865b5abceca0
```


```
{
   "id": "a1dc55a8-4132-03c0-671c-2be7e0549770",
   "providerName": "Example Provider",
   "dateTimeUTC": "2017-09-05T04:46:40.9419275",
   "httpStatusCode": "OK",
   "pagination": null,
   "problem": null,
   "salaryAndWages":
    {
        "salaryAndWagesID": "ceca84b6-82f7-4d5e-8ac4-865b5abceca0",
        "earningsRateID": "4b85f7f4-548c-4cd6-9902-ed77ea121053",
        "numberOfUnitsPerWeek": 0,
        "ratePerUnit": null,
        "daysPerWeek": 0,
        "effectiveFrom": null,
        "annualSalary": 0,
        "status": "Active",
        "paymentType": "Salary",
		"minimumContractedHoursPerWeek": null
    }
}
```


Example response for GET salary and wages by ID – 404 Not Found Response

```
GET https://api.xero.com/payroll.xro/2.0/employees/ceca84b6-82f7-4d5e-8ac4-865b5abceca0/salaryAndWages/ceca84b6-82f7-4d5e-8ac4-865b5abceca0
```


```
{
   "id": "a1dc55a8-4132-03c0-671c-2be7e0549770",
   "providerName": "Example Provider",
   "dateTimeUTC": "2017-09-05T05:18:06.2263195",
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
   "salaryAndWages": null
}
```


## Post salary and wages


`POST https://api.xero.com/payroll.xro/2.0/employees/{EmployeeID}/salaryAndWages`

Adds a salary and wages record. Salary and wages are not applicable for off-payroll workers.

### Elements for salary and wages in the Request

_The following elements are **required** to add a new salary and wages for an employee_

| Element Name | Element Description |
| --- | --- |
| EarningsRateID | Xero unique identifier for an earnings rate |
| NumberOfUnitsPerWeek | The Number of Units per week for the corresponding salary and wages |
| RatePerUnit | The rate of each unit for the corresponding salary and wages |
| NumberOfUnitsPerDay (deprecated) | The Number of Units per day for the corresponding salary and wages (deprecated, use `working-pattern`) |
| EffectiveFrom | The effective date of the corresponding salary and wages |
| AnnualSalary | The annual salary |
| Status | The current status of the corresponding salary and wages |
| PaymentType | The type of the payment of the corresponding salary and wages |
| MinimumContractedHoursPerWeek | Only required if the linked earnings rate has a `typeOfUnit` of `hourly` and `NumberOfUnitsPerWeek` is `0`. The minimum number of hours per week an employee is contracted for |

Example for POST salary and wages for an Employee with minimum elements required – 200 OK Response

```
POST https://api.xero.com/payroll.xro/2.0/employees/0172b72a-08ab-1349-d4b3-43af6fdfae06/salaryAndWages
```


Request Body

```
{
    "earningsRateID": "4b85f7f4-548c-4cd6-9902-ed77ea121053",
    "numberOfUnitsPerDay": 0,
    "daysPerWeek": 0,
    "paymentType": "Salary"
}
```


Response Body

```
{
    "id": "0172b72a-08ab-1349-d4b3-43af6fdfae06",
    "providerName": "!YLT5Y",
    "dateTimeUTC": "2017-11-07T22:48:20.9309159",
    "httpStatusCode": "OK",
    "pagination": null,
    "problem": null,
    "salaryAndWages": {
        "salaryAndWagesID": "84bb57cf-3d96-4713-9588-fc178ace8be9",
        "earningsRateID": "4b85f7f4-548c-4cd6-9902-ed77ea121053",
        "numberOfUnitsPerWeek": 0,
        "ratePerUnit": null,
        "daysPerWeek": 0,
        "effectiveFrom": "2014-01-06T00:00:00",
        "annualSalary": 0,
        "status": "Active",
        "paymentType": "Salary",
		"minimumContractedHoursPerWeek": null
    }
}
```


Example POST for a salary and wages record for an off-payroll worker – 400 Bad Request Response

```
POST https://api.xero.com/payroll.xro/2.0/cd625bfb-0187-421f-9474-9458668d7376/salaryAndWages
```


Request Body

```
{
    "earningsRateID": "4b85f7f4-548c-4cd6-9902-ed77ea121053",
    "numberOfUnitsPerDay": 0,
    "daysPerWeek": 0,
    "paymentType": "Salary"
}
```


Response Body

```
{
    "id": "cd625bfb-0187-421f-9474-9458668d7376",
    "providerName": "xero/api",
    "dateTimeUTC": "2021-03-11T05:10:50.9814337",
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
                "name": "_default",
                "reason": "Assigning a salary & wage is not supported for an off-payroll worker."
            }
        ],
        "invalidObjects": null
    },
    "salaryAndWages": null
}
```


Example POST for a salary and wages record for an Employee – 400 Bad Request Response

```
POST https://api.xero.com/payroll.xro/2.0/0172b72a-08ab-1349-d4b3-43af6fdfae06/salaryAndWages
```


```
Empty Request Body
```


Response Body

```
{
    "id": "0172b72a-08ab-1349-d4b3-43af6fdfae06",
    "providerName": "!YLT5Y",
    "dateTimeUTC": "2017-11-08T04:50:29.0273151",
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
                "name": "PaymentType",
                "reason": "The Salary and Wages Type is required"
            }
        ]
    },
    "salaryAndWages": null
}
```


Example POST for a salary and wages record for an Employee with a duplicate `EffectiveFrom` – 400 Bad Request Response

```
POST https://api.xero.com/payroll.xro/2.0/0172b72a-08ab-1349-d4b3-43af6fdfae06/salaryAndWages
```


```
{
    "earningsRateID": "4b85f7f4-548c-4cd6-9902-ed77ea121053",
    "numberOfUnitsPerDay": 0,
    "daysPerWeek": 0,
    "paymentType": "Salary",
    "effectiveFrom": "2023-12-12"
}
```


Response Body

```
{
    "id": "0172b72a-08ab-1349-d4b3-43af6fdfae06",
    "providerName": "!YLT5Y",
    "dateTimeUTC": "2017-11-08T04:50:29.0273151",
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
                "name": "EffectiveFrom",
                "reason": "EffectiveFrom date cannot be before an existing salary and wage effective from"
            }
        ]
    },
    "salaryAndWages": null
}
```


## Put salary and wages


`PUT https://api.xero.com/payroll.xro/2.0/employees/{EmployeeID}/salaryAndWages`

Updates a salary and wages record

### Elements for salary and wages in the Request

_The following elements are **required** to add a new salary and wages for an employee_

| Element Name | Element Description |
| --- | --- |
| EarningsRateID | Xero unique identifier for an earnings rate |
| NumberOfUnitsPerWeek | The Number of Units per week for the corresponding salary and wages |
| RatePerUnit | The rate of each unit for the corresponding salary and wages |
| NumberOfUnitsPerDay (deprecated) | The Number of Units per day for the corresponding salary and wages (deprecated, use `working-pattern`) |
| EffectiveFrom | The effective date of the corresponding salary and wages |
| AnnualSalary | The annual salary. |
| Status | The current status of the corresponding salary and wages |
| PaymentType | The type of the payment of the corresponding salary and wages |
| MinimumContractedHoursPerWeek | Only required if the linked earnings rate has a `typeOfUnit` of `hourly` and `NumberOfUnitsPerWeek` is `0`. The minimum number of hours per week an employee is contracted for |

Example PUT for a salary and wages record with minimum elements required – 200 OK Response

```
PUT https://api.xero.com/payroll.xro/2.0/employees/0172b72a-08ab-1349-d4b3-43af6fdfae06/salaryAndWages
```


Request Body

```
{
    "earningsRateID": "4b85f7f4-548c-4cd6-9902-ed77ea121053",
    "daysPerWeek": 2,
    "paymentType": "Salary",
    "effectiveFrom": "2018-03-24T00:00:00"
}
```


Response Body

```
{
    "id": "0172b72a-08ab-1349-d4b3-43af6fdfae06",
    "providerName": "!YLT5Y",
    "dateTimeUTC": "2017-11-07T22:48:20.9309159",
    "httpStatusCode": "OK",
    "pagination": null,
    "problem": null,
    "salaryAndWages": {
        "salaryAndWagesID": "84bb57cf-3d96-4713-9588-fc178ace8be9",
        "earningsRateID": "4b85f7f4-548c-4cd6-9902-ed77ea121053",
        "numberOfUnitsPerWeek": 0,
        "ratePerUnit": null,
        "daysPerWeek": 2,
        "effectiveFrom": "2018-03-24T00:00:00",
        "annualSalary": 0,
        "status": "Active",
        "paymentType": "Salary",
		"minimumContractedHoursPerWeek": null
    }
}
```


Example for PUT salary and wages for an Employee – 400 Bad Request Response

```
PUT https://api.xero.com/payroll.xro/2.0/0172b72a-08ab-1349-d4b3-43af6fdfae06/salaryAndWages
```


```
Empty Request Body
```


Response Body

```
{
    "id": "0172b72a-08ab-1349-d4b3-43af6fdfae06",
    "providerName": "!YLT5Y",
    "dateTimeUTC": "2017-11-08T04:50:29.0273151",
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
                "name": "PaymentType",
                "reason": "The Salary and Wages Type is required"
            }
        ]
    },
    "salaryAndWages": null
}
```


## Delete salary and wages


```
DELETE https://api.xero.com/payroll.xro/2.0/employees/{EmployeeID}/salaryAndWages/{salaryandwagesID}`
```


Deletes a salary and wages record

### Elements for salary and wages in the Request

_The following elements are **required** to delete a salary and wages record for an employee_

| Element Name | Element Description |
| --- | --- |
| EarningsRateID | Xero unique identifier for an earnings rate |
| EmployeeID | Xero unique identifier for an employee |
| SalaryAndWagesID | Xero unique identifier for a salary and wages record |

Example DELETE for a salary and wages record with minimum elements required – 200 OK Response

```
DELETE https://api.xero.com/payroll.xro/2.0/employees/a85d5d67-7fc4-36c4-794f-c236260d5aa5/adf4f866-bb65-48b0-b586-621a0d4969db
```


```
Empty Request Body
```


Response Body

```
{
    "id": "0172b72a-08ab-1349-d4b3-43af6fdfae06",
    "providerName": "!YLT5Y",
    "dateTimeUTC": "2017-11-07T22:48:20.9309159",
    "httpStatusCode": "OK",
    "pagination": null,
    "problem": null,
    "salaryAndWages": null
}
```


Example for DELETE salary and wages for an Employee – 404 Not Found Response

```
DELETE https://api.xero.com/payroll.xro/2.0/employees/00000000-0000-0000-0000-000000000000/00000000-0000-0000-0000-000000000000
```


```
Empty Request Body
```


Response Body

```
{
    "id": "c4be24e5-e840-4c92-9eaa-2d86cd596314",
    "providerName": "!YLT5Y",
    "dateTimeUTC": "2017-09-15T03:51:43.3204368",
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
    "salaryAndWages": null
}
```
