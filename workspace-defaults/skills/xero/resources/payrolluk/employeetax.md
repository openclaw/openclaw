# Employee Taxes

## Overview


|  |  |
| --- | --- |
| URL | `https://api.xero.com/payroll.xro/2.0/employees/{EmployeeID}/tax` |
| Methods Supported | GET |
| Description | Allows you to retrieve tax in Payroll for an employee in a Xero organisation. |

## GET Employee Tax


`GET https://api.xero.com/payroll.xro/2.0/employees/{EmployeeID}/tax/`

Retrieves tax details for an active employee

### Elements for Employee Tax

|  |  |
| --- | --- |
| StarterType | The Starter type. |
| StarterDeclaration | Starter declaration. |
| TaxCode | The Tax code. |
| W1M1 | Boolean – describes whether the tax settings is W1M1 |
| PreviousTaxablePay | The previous taxable pay |
| PreviousTaxPaid | The tax amount previously paid |
| StudentLoanDeduction | The employee's student loan deduction type |
| HasPostGraduateLoans | Boolean – describes whether the employee has post graduate loans |
| IsDirector | Boolean – describes whether the employee is director |
| DirectorshipStartDate | The directorship start date |
| NICCalculationMethod | NICs calculation method |

Example response for GET Employee tax – 200 OK Response

```
GET https://api.xero.com/payroll.xro/2.0/employees/35cdd697-c9fc-4931-b579-a18cb8b6fe14/tax
```


```
{
    "id": "0cd2414f-4549-f751-728a-10d4f89b5ab0",
    "providerName": "Test Provider",
    "dateTimeUTC": "2019-06-20T02:51:52.7749747",
    "httpStatusCode": "OK",
    "pagination": null,
    "problem": null,
    "employeeTax": {
          "starterType": "New Employee with P45",
          "starterDeclaration": "B.) This is currently their only job",
          "taxCode": "1185L",
          "w1M1": false,
          "previousTaxablePay": 1002,
          "previousTaxPaid": 1001,
          "studentLoanDeduction": "Plan Type 2",
          "hasPostGraduateLoans": false,
          "isDirector": true,
          "directorshipStartDate": "2019-06-27T00:00:00",
          "nicCalculationMethod": "Annualized"
    }
}
```


Example response for GET Employee tax – 404 Not Found Response

```
GET https://api.xero.com/payroll.xro/2.0/employees/35cdd697-c9fc-4931-b579-a18cb8b6fe14/tax
```


```
{
    "id": "0cd2414f-4549-f751-728a-10d4f89b5ab0",
    "providerName": "Test Provider",
    "dateTimeUTC": "2019-6-20T02:52:42.8608224",
    "httpStatusCode": "NotFound",
    "pagination": null,
    "problem": {
        "type": "about:blank",
        "title": "NotFound",
        "status": 404,
        "detail": "Resource was not found",
        "instance": null,
        "invalidFields": null
    }
}
```
