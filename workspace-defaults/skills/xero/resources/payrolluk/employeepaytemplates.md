# Pay Templates

## Overview


|  |  |
| --- | --- |
| URLs | `https://api.xero.com/payroll.xro/2.0/employees/{EmployeeID}/paytemplates`<br>`https://api.xero.com/payroll.xro/2.0/employees/{EmployeeID}/paytemplateearnings`<br>`https://api.xero.com/payroll.xro/2.0/employees/{EmployeeID}/paytemplates/earnings/{PayTemplateEarningID}` |
| Methods Supported | GET, POST, POST Multiple, PUT, DELETE |
| Description | Allows you to retrieve the collection of pay templates in Payroll <br>for an employee in a Xero organisation. <br>Allows you to create, update or delete pay template earnings items in Payroll <br>for an employee in a Xero organisation. <br>Allows you to create multiple pay template earnings items in Payroll <br>for an employee in a Xero organisation. |
| Limitations | The POST request of multiple pay template earnings allows up to 50 items <br>per request. <br>Statutory payments on opening balances are not supported for off-payroll workers, so any requests <br>to create earnings templates against them will be rejected |

## GET All Pay Templates


`GET https://api.xero.com/payroll.xro/2.0/employees/{EmployeeID}/paytemplates`

Retrieves all the pay template items for an active employee

### Elements for a Pay Templates

|  |  |
| --- | --- |
| EmployeeID | The Xero identifier for payroll employee |
| EarningsTemplates | See EarningsTemplate |
| DeductionTemplates | _future_ |
| BenefitTemplates | _future_ |
| ReimbursementTemplates | _future_ |

Example response for GET All Employee Pay Templates – 200 OK Response

```
GET https://api.xero.com/payroll.xro/2.0/employees/35cdd697-c9fc-4931-b579-a18cb8b6fe14/paytemplates
```


```
{
  "employeeID": "35cdd697-c9fc-4931-b579-a18cb8b6fe14",
  "providerName": "!YLT5Y",
  "dateTimeUTC": "2017-09-06T05:16:25.5262207",
  "httpStatusCode": "OK",
  "pagination": null,
  "problem": null,
  "earningTemplates":
    [{
      "payTemplateEarningID": "20788ab2-b2ed-4c4d-bccf-0a6a835ddbb0",
      "ratePerUnit": 10.50,
      "numberOfUnits": 40.0,
      "earningsRateID": "3c5495a4-9301-32a4-b071-15d67c62ba2",
      "name": "Overtime Hours"
    },
    {
      "payTemplateEarningID": "20788ab2-b2ed-4c4d-bccf-0a6a835ddbb0",
      "fixedAmount": 5000.00,
      "earningsRateID": "25674a22-d9e3-41ed-943a-df1d98ea5991",
      "name": "Statutory Shared Parental Pay"
    }],
  "deductionTemplates": null,
  "benefitTemplates": null,
  "reimbursementTemplates": null
}
```


## Create an Earnings Template


`POST https://api.xero.com/payroll.xro/2.0/employees/{EmployeeID}/paytemplates/earnings`

Use this method to create a pay template earnings item for an active employee. Statutory payments on opening balances are not supported for off-payroll workers, so any requests to create earnings templates against them will be rejected.

### Elements for Earnings Template

_The following are **required** to create a new earnings template_

|  |  |
| --- | --- |
| EmployeeID | The Xero identifier for payroll employee |
| EarningsTemplate | See EarningsTemplate |

Example of minimum elements required to add a new Earnings Template – 200 OK Response

```
POST https://api.xero.com/payroll.xro/2.0/employees/35cdd697-c9fc-4931-b579-a18cb8b6fe14/paytemplates/earnings
```


Request Body

```
{
    "ratePerUnit": 10.50,
    "numberOfUnits": 40.50,
    "earningsRateID": "3c5495a4-9301-32a4-b071-15d67c62ba2"
}
```


Response Body

```
{
  "id": "54a1f6aa-eee7-d860-f44b-ffc6e10ded5a",
  "providerName": "!YLT5Y",
  "dateTimeUTC": "2017-09-18T06:02:29.816809",
  "httpStatusCode": "OK",
  "pagination": null,
  "problem": null,
  "earningTemplate": {
      "payTemplateEarningID":"ad66073f-2dde-4825-9741-a3886e90ca61",
      "ratePerUnit": 10.50,
      "numberOfUnits": 40.50,
      "earningsRateID": "3c5495a4-9301-32a4-b071-15d67c62ba2",
      "name": "Overtime Hours"
  }
}
```


Example of adding an unsupported Earnings Template to an off-payroll worker – 400 Bad Request

```
POST https://api.xero.com/payroll.xro/2.0/employees/35483108-dbe5-48de-b0f5-ef3cd52e48de/paytemplates/earnings
```


Request Body

```
{
  "ratePerUnit": 10.50,
  "numberOfUnits": 40.50,
  "earningsRateID": "ea29c000-3026-4e1e-a3cf-3bb8048fbf1a"
}
```


Response Body

```
{
  "id": "cd625bfb-0187-421f-9474-9458668d7376",
  "providerName": "xero/api",
  "dateTimeUTC": "2021-03-12T04:22:14.7338693",
  "httpStatusCode": "BadRequest",
  "pagination": null,
  "problem": {
      "type": "application/problem+json",
      "title": "BadRequest",
      "status": 400,
      "detail": "The earning rate is not supported for off-payroll workers",
      "instance": null,
      "invalidFields": null,
      "invalidObjects": null
  },
  "earningTemplate": null
}
```


## Create Multiple Earnings Template


`POST https://api.xero.com/payroll.xro/2.0/employees/{EmployeeID}/paytemplateearnings`

Use this method to create multiple pay template earnings items for an active employee. Statutory payments on opening balances are not supported for off-payroll workers, so any requests to create earnings templates against them will be rejected.

### Elements for Earnings Template

_The following are **required** to create a new earnings template_

|  |  |
| --- | --- |
| EmployeeID | The Xero identifier for payroll employee |
| EarningsTemplates | See EarningsTemplate |

Example of minimum elements required to add a new Earnings Template – 200 OK Response

```
POST https://api.xero.com/payroll.xro/2.0/employees/35cdd697-c9fc-4931-b579-a18cb8b6fe14/paytemplateearnings
```


Request Body

```
[
  {
    "ratePerUnit": 10.50,
    "numberOfUnits": 40.50,
    "earningsRateID": "3c5495a4-9301-32a4-b071-15d67c62ba2"
  },
  {
    "ratePerUnit": 12.30,
    "numberOfUnits": 45.20,
    "earningsRateID": "1d8239ab-9301-32a4-b071-15d67c62ac3"
  }
]
```


Response Body

```
{
  "id": "54a1f6aa-eee7-d860-f44b-ffc6e10ded5a",
  "providerName": "!YLT5Y",
  "dateTimeUTC": "2017-09-18T06:02:29.816809",
  "httpStatusCode": "OK",
  "pagination": null,
  "problem": null,
  "earningTemplates": [
    {
      "payTemplateEarningID":"ad66073f-2dde-4825-9741-a3886e90ca61",
      "ratePerUnit": 10.50,
      "numberOfUnits": 40.50,
      "earningsRateID": "3c5495a4-9301-32a4-b071-15d67c62ba2",
      "name": "Overtime Hours"
    },
    {
      "payTemplateEarningID":"bc77123a-2dde-4825-9741-b2196e90ca62",
      "ratePerUnit": 12.30,
      "numberOfUnits": 45.20,
      "earningsRateID": "1d8239ab-9301-32a4-b071-15d67c62ac3",
      "name": "Overtime Hours"
    }
  ]
}
```


Example for POST unsupported Earnings Template for an off-payroll worker – 400 Bad Request Response

```
POST https://api.xero.com/payroll.xro/2.0/employees/35483108-dbe5-48de-b0f5-ef3cd52e48de/paytemplateearnings
```


Request Body with invalid earningsRateIds

```
[
  {
    "ratePerUnit": 12.50,
    "numberOfUnits": 50.40,
    "earningsRateID": "ea29c000-3026-4e1e-a3cf-3bb8048fbf1a"
  },
  {
    "ratePerUnit": 15.20,
    "numberOfUnits": 61.30,
    "earningsRateID": "ea29c000-3026-4e1e-a3cf-3bb8048fbf1a"
  }
]
```


Response Body

```
{
  "id": "cd625bfb-0187-421f-9474-9458668d7376",
  "providerName": "xero/api",
  "dateTimeUTC": "2021-03-12T04:23:12.8843999",
  "httpStatusCode": "BadRequest",
  "pagination": null,
  "problem": {
      "type": "application/problem+json",
      "title": "BadRequest",
      "status": 400,
      "detail": "One or more errors have occurred",
      "instance": null,
      "invalidFields": null,
      "invalidObjects": [
          {
              "payTemplateEarningID": null,
              "ratePerUnit": 33.0,
              "numberOfUnits": 44.0,
              "fixedAmount": null,
              "earningsRateID": "ea29c000-3026-4e1e-a3cf-3bb8048fbf1a",
              "name": null,
              "errorMessage": "The earning rate is not supported for off-payroll workers"
          },
          {
              "payTemplateEarningID": null,
              "ratePerUnit": 66.0,
              "numberOfUnits": 55.0,
              "fixedAmount": null,
              "earningsRateID": "ea29c000-3026-4e1e-a3cf-3bb8048fbf1a",
              "name": null,
              "errorMessage": "The earning rate is not supported for off-payroll workers"
          }
      ]
  },
  "earningTemplates": null
}
```


Example for POST Earnings Template – 400 Bad Request Response

```
POST https://api.xero.com/payroll.xro/2.0/employees/35cdd697-c9fc-4931-b579-a18cb8b6fe14/paytemplateearnings
```


Request Body with invalid earningsRateIds

```
[
  {
    "ratePerUnit": 12.50,
    "numberOfUnits": 50.40,
    "earningsRateID": "dd1a6197-09b9-44fe-82c7-a15d72d13f4d"
  },
  {
    "ratePerUnit": 15.20,
    "numberOfUnits": 61.30,
    "earningsRateID": "0b0daa99-7657-495c-8a5a-10a4ccc0fc39"
  }
]
```


Response Body

```
{
  "id": "54a1f6aa-eee7-d860-f44b-ffc6e10ded5a",
  "providerName": "Test Provider",
  "dateTimeUTC": "2019-04-24T18:41:30.0221548",
  "httpStatusCode": "BadRequest",
  "pagination": null,
  "problem": {
      "type": "application/problem+json",
      "title": "BadRequest",
      "status": 400,
      "detail": "One or more errors have occurred",
      "instance": null,
      "invalidFields": null,
      "invalidObjects": [
          {
              "payTemplateEarningID": null,
              "ratePerUnit": 12.50,
              "numberOfUnits": 50.40,
              "fixedAmount": null,
              "earningsRateID": "dd1a6197-09b9-44fe-82c7-a15d72d13f4d",
              "name": null,
              "errorMessage": "Invalid earning rate"
          },
          {
              "payTemplateEarningID": null,
              "ratePerUnit": 15.20,
              "numberOfUnits": 61.30,
              "fixedAmount": null,
              "earningsRateID": "0b0daa99-7657-495c-8a5a-10a4ccc0fc39",
              "name": null,
              "errorMessage": "Invalid earning rate"
          }
      ]
  },
  "earningTemplates": null
}
```


## Update an Earnings Template


`PUT https://api.xero.com/payroll.xro/2.0/employees/{EmployeeID}/paytemplates/earnings/{PayTemplateEarningID}`

Use this method to update a pay template earnings item for an active employee. Statutory payments on opening balances are not supported for off-payroll workers, so any requests to create earnings templates against them will be rejected.

### Elements for Earnings Template

_The following are **required** to update an earning template_

|  |  |
| --- | --- |
| EmployeeID | The Xero identifier for payroll employee |
| PayTemplateEarningID | The Xero identifier for payroll earnings template |
| EarningsTemplate | See EarningsTemplate |

Example of minimum elements required to add a new Earnings Template – 200 OK Response

```
PUT https://api.xero.com/payroll.xro/2.0/employees/35cdd697-c9fc-4931-b579-a18cb8b6fe14/paytemplates/earnings/ad66073f-2dde-4825-9741-a3886e90ca61
```


Request Body

```
{
  "payTemplateEarningID":"ad66073f-2dde-4825-9741-a3886e90ca61",
  "ratePerUnit": 14.25,
  "numberOfUnits": 35.50,
  "earningsRateID": "3c5495a4-9301-32a4-b071-15d67c62ba2"
}
```


Response Body

```
{
  "id": "b461118e-5f3e-464e-9ced-3e9721448447",
  "providerName": "!YLT5Y",
  "dateTimeUTC": "2017-09-18T06:02:29.816809",
  "httpStatusCode": "OK",
  "pagination": null,
  "problem": null,
  "earningTemplate": {
      "payTemplateEarningID":"ad66073f-2dde-4825-9741-a3886e90ca61",
      "ratePerUnit": 14.25,
      "numberOfUnits": 35.50,
      "earningsRateID": "3c5495a4-9301-32a4-b071-15d67c62ba2",
      "name": "Overtime Hours"
  }
}
```


Example of adding an unsupported Earnings Template to an off-payroll worker – 400 Bad Request

```
PUT https://api.xero.com/payroll.xro/2.0/employees/35483108-dbe5-48de-b0f5-ef3cd52e48de/paytemplates/earnings
```


Request Body

```
{
    "ratePerUnit": 10.50,
    "numberOfUnits": 40.50,
    "earningsRateID": "ea29c000-3026-4e1e-a3cf-3bb8048fbf1a"
}
```


Response Body

```
{
  "id": "cd625bfb-0187-421f-9474-9458668d7376",
  "providerName": "xero/api",
  "dateTimeUTC": "2021-03-12T04:22:14.7338693",
  "httpStatusCode": "BadRequest",
  "pagination": null,
  "problem": {
      "type": "application/problem+json",
      "title": "BadRequest",
      "status": 400,
      "detail": "The earning rate is not supported for off-payroll workers",
      "instance": null,
      "invalidFields": null,
      "invalidObjects": null
  },
  "earningTemplate": null
}
```


## Delete an Earning Template


`DELETE https://api.xero.com/payroll.xro/2.0/employees/{EmployeeID}/paytemplates/earnings/{payTemplateEarningID}`

Use this method to delete a pay template earnings item for an active employee

### Elements for Earnings Template

_The following are **required** to delete an earnings template_

|  |  |
| --- | --- |
| EmployeeID | The Xero identifier for payroll employee |
| PayTemplateEarningID | The Xero identifier for payroll earnings template |

Example of minimum elements required to delete an Earnings Template – 200 OK Response

```
DELETE https://api.xero.com/payroll.xro/2.0/employees/35cdd697-c9fc-4931-b579-a18cb8b6fe14/paytemplates/earnings/ad66073f-2dde-4825-9741-a3886e90ca61
```


Response Body

```
{
  "id": "b461118e-5f3e-464e-9ced-3e9721448447",
  "providerName": "!YLT5Y",
  "dateTimeUTC": "2017-09-18T06:02:29.816809",
  "httpStatusCode": "OK",
  "pagination": null,
  "problem": null
}
```


### Elements for Earnings Template

|  |  |
| --- | --- |
| payTemplateEarningID | The Xero identifier for the leave |
| ratePerUnit | The rate per unit |
| numberOfUnits | The number of units |
| fixedAmount | The fixed amount per period |
| earningsRateID | The corresponding earnings rate identifier |
| name | The read-only name of the Earning Template. |
