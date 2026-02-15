# Employee Opening Balances

## Overview


|  |  |
| --- | --- |
| URLs | `https://api.xero.com/payroll.xro/2.0/employees/{EmployeeID}/ukopeningbalances` |
| Methods Supported | GET, POST, PUT |
| Description | Allows you to create, update, or get current employee opening balances in Payroll |
| Limitations | Statutory payments are not supported for off-payroll workers |

## GET Employee Opening Balances


`GET https://api.xero.com/payroll.xro/2.0/employees/{EmployeeID}/ukopeningbalances`

Retrieves opening balances for an active employee

### Elements for Employee Opening Balances

|  |  |
| --- | --- |
| EmployeeID | The Xero identifier for payroll employee |

Example response for GET Employee Opening Balances – 200 OK Response

```
GET https://api.xero.com/payroll.xro/2.0/employees/35cdd697-c9fc-4931-b579-a18cb8b6fe14/ukopeningbalances
```


```
{
  "id": "907f0599-24cc-1aca-d24e-950ef7a9b249",
  "providerName": "!YLT5Y",
  "dateTimeUTC": "2019-02-13T01:26:05.2692663",
  "httpStatusCode": "OK",
  "pagination": null,
  "problem": null,
  "openingBalances": {
      "statutoryAdoptionPay": 0,
      "statutoryMaternityPay": 0,
      "statutoryPaternityPay": 0,
      "statutorySharedParentalPay": 25,
      "statutorySickPay": 20.5,
      "priorEmployeeNumber": "12345"
  }
}
```


## Create employee opening balances


`POST https://api.xero.com/payroll.xro/2.0/employees/{EmployeeID}/ukopeningbalances`

Use this method to create opening balances for an active employee. Statutory payments are not supported for off-payroll workers, so requests to set Opening Balances to a value other than 0.00 for any statutory payments will be rejected with a 400 bad request.

### Elements for Employee Opening Balances

_The following are **required** to create employee opening balances_

|  |  |
| --- | --- |
| EmployeeID | The Xero identifier for payroll employee |
| Employee Opening Balances | See Employee Opening Balances |

Example of minimum elements required to add employee opening balances – 200 OK Response

```
POST https://api.xero.com/payroll.xro/2.0/employees/35cdd697-c9fc-4931-b579-a18cb8b6fe14/ukopeningbalances
```


Request Body

```
{
  "PriorEmployeeNumber" : "12345",
  "StatutoryAdoptionPay" : 0.00,
  "StatutoryMaternityPay": 0.00,
  "StatutoryPaternityPay": 0.00,
  "StatutorySharedParentalPay": 0.00,
  "StatutorySickPay": 20.50
}
```


Response Body

```
{
  "id": "907f0599-24cc-1aca-d24e-950ef7a9b249",
  "providerName": "!1Fake",
  "dateTimeUTC": "2019-02-13T15:38:37.731248",
  "httpStatusCode": "OK",
  "pagination": null,
  "problem": null,
  "openingBalances": null
}
```


Example response of setting a statutory payment for an off-payroll worker – 400 Bad Request

```
POST https://api.xero.com/payroll.xro/2.0/employees/35483108-dbe5-48de-b0f5-ef3cd52e48de/ukopeningbalances
```


Request Body

```
{
  "statutoryAdoptionPay": 0.0000,
  "statutoryMaternityPay": 0.0000,
  "statutoryPaternityPay": 100.0000,
  "statutorySharedParentalPay": 0.0000,
  "statutorySickPay": 0.0000,
  "priorEmployeeNumber": null
}
```


Response Body

```
{
  "id": "cd625bfb-0187-421f-9474-9458668d7376",
  "providerName": "xero/api",
  "dateTimeUTC": "2021-03-12T03:24:45.10382",
  "httpStatusCode": "BadRequest",
  "pagination": null,
  "problem": {
      "type": "application/problem+json",
      "title": null,
      "status": 400,
      "detail": "Statutory payments are not supported for off-payroll workers.",
      "instance": null,
      "invalidFields": null,
      "invalidObjects": null
  },
  "openingBalances": null
}
```


## Update an Earnings Template


`PUT https://api.xero.com/payroll.xro/2.0/employees/{EmployeeID}/ukopeningbalances`

Use this method to update an employees opening balances

### Elements for employee opening balances

_The following are **required** to update employee opening balances_

|  |  |
| --- | --- |
| EmployeeID | The Xero identifier for payroll employee |
| Employee Opening Balances | See Employee Opening Balances |

Example of minimum elements required to update employee opening balances – 200 OK Response

```
PUT https://api.xero.com/payroll.xro/2.0/employees/35cdd697-c9fc-4931-b579-a18cb8b6fe14/ukopeningbalances
```


Request Body

```
{
  "PriorEmployeeNumber" : "12345",
  "StatutoryAdoptionPay" : 0.00,
  "StatutoryMaternityPay": 100.00,
  "StatutoryPaternityPay": 0.00,
  "StatutorySharedParentalPay": 0.00,
  "StatutorySickPay": 20.50
}
```


Response Body

```
{
  "id": "907f0599-24cc-1aca-d24e-950ef7a9b249",
  "providerName": "!1Fake",
  "dateTimeUTC": "2019-02-13T15:38:37.731248",
  "httpStatusCode": "OK",
  "pagination": null,
  "problem": null,
  "openingBalances": null
}
```


Example response of setting a statutory payment for an off-payroll worker – 400 Bad Request

```
PUT https://api.xero.com/payroll.xro/2.0/employees/35483108-dbe5-48de-b0f5-ef3cd52e48de/ukopeningbalances
```


Request Body

```
{
  "statutoryAdoptionPay": 0.0000,
  "statutoryMaternityPay": 0.0000,
  "statutoryPaternityPay": 100.0000,
  "statutorySharedParentalPay": 0.0000,
  "statutorySickPay": 0.0000,
  "priorEmployeeNumber": null
}
```


Response Body

```
{
  "id": "cd625bfb-0187-421f-9474-9458668d7376",
  "providerName": "xero/api",
  "dateTimeUTC": "2021-03-12T03:24:45.10382",
  "httpStatusCode": "BadRequest",
  "pagination": null,
  "problem": {
      "type": "application/problem+json",
      "title": null,
      "status": 400,
      "detail": "Statutory payments are not supported for off-payroll workers.",
      "instance": null,
      "invalidFields": null,
      "invalidObjects": null
  },
  "openingBalances": null
}
```


### Elements for Employee Opening Balances

|  |  |
| --- | --- |
| StatutoryAdoptionPay | The total accumulated statutory adoption pay amount received by the employee for current fiscal year to date |
| StatutoryMaternityPay | The total accumulated statutory maternity pay amount received by the employee for current fiscal year to date |
| StatutoryPaternityPay | The total accumulated statutory paternity pay amount received by the employee for current fiscal year to date |
| StatutorySharedParentalPay | The total accumulated statutory shared parental pay amount received by the employee for current fiscal year to date |
| StatutorySickPay | The total accumulated statutory sick pay amount received by the employee for current fiscal year to date |
| PriorEmployeeNumber | The unique employee number issued by the employee's former employer |
