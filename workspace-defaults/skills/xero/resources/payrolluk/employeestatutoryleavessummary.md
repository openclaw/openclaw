# Employee Statutory Leaves Summary

## Overview


|  |  |
| --- | --- |
| URLs | `https://api.xero.com/payroll.xro/2.0/statutoryleaves/summary/{EmployeeID}?activeOnly={ActiveOnly}` |
| Methods Supported | GET |
| Description | Allows you to retrieve a summary of all or only active statutory leaves for a specified employee in Payroll |

## GET Statutory Leaves Summary


`GET https://api.xero.com/payroll.xro/2.0/statutoryleaves/summary/{EmployeeID}?activeOnly={ActiveOnly}`

Retrieves a summary of all or only active statutory leaves for an employee in Payroll

### Elements for request

|  |  |
| --- | --- |
| EmployeeID | The unique identifier of the employee |
| ActiveOnly | Optional. <br>Filter response with leaves that are currently active or yet to be taken <br>If not specified, all leaves (past, current, and future scheduled) are returned |

### Elements for response

|  |  |
| --- | --- |
| StatutoryLeaveID | The unique identifier (guid) of a statutory leave. |
| EmployeeID | The unique identifier (guid) of the employee |
| Type | The category of statutory leave. See leave types |
| Start Date | The date when the leave starts |
| End Date | The date when the leave ends |
| IsEntitled | Whether the leave was entitled to receive payment |
| Status | The status of the leave. See status |

Example response for GET Employee Leave Balances – 200 OK Response

```
GET https://api.xero.com/payroll.xro/2.0/statutoryleaves/summary/35cdd697-c9fc-4931-b579-a18cb8b6fe14?
```


Response Body

```
{
  "id": "907f0599-24cc-1aca-d24e-950ef7a9b249",
  "providerName": "!1Fake",
  "dateTimeUTC": "2019-03-13T18:29:37.6953745",
  "httpStatusCode": "OK",
  "pagination": null,
  "problem": null,
  "statutoryLeaves": [
      {
          "statutoryLeaveID": "cbbc3309-249a-4c1c-87cf-53f30c257c21",
          "employeeID": "35cdd697-c9fc-4931-b579-a18cb8b6fe14",
          "type": "Sick",
          "endDate": "2019-03-06",
          "startDate": "2019-03-01",
          "isEntitled": true,
          "status": "Pending"
      },
      {
          "statutoryLeaveID": "81c1fa7e-6c58-45ba-b796-c02ca7970ed1",
          "employeeID": "35cdd697-c9fc-4931-b579-a18cb8b6fe14",
          "type": "Sick",
          "endDate": "2019-02-08",
          "startDate": "2019-02-04",
          "isEntitled": true,
          "status": "Complete"
      }
  ]
}
```


Example response for GET Employee Leave Balances – Filtered for active only

```
GET https://api.xero.com/payroll.xro/2.0/statutoryleaves/summary/35cdd697-c9fc-4931-b579-a18cb8b6fe14?activeOnly=true
```


Response Body

```
{
  "id": "907f0599-24cc-1aca-d24e-950ef7a9b249",
  "providerName": "!1Fake",
  "dateTimeUTC": "2019-03-13T18:29:37.6953745",
  "httpStatusCode": "OK",
  "pagination": null,
  "problem": null,
  "statutoryLeaves": [
      {
          "statutoryLeaveID": "cbbc3309-249a-4c1c-87cf-53f30c257c21",
          "employeeID": "35cdd697-c9fc-4931-b579-a18cb8b6fe14",
          "type": "Sick",
          "endDate": "2019-03-06",
          "startDate": "2019-03-01",
          "isEntitled": true,
          "status": "Pending"
      }
  ]
}
```


Example response for GET Employee Leave Balances – 404 Not Found Response

```
GET https://api.xero.com/payroll.xro/2.0/statutoryleaves/summary/35cdd697-c9fc-4931-b579-a18cb8b6fe14?
```


Response Body

```
{
  "id": "907f0599-24cc-1aca-d24e-950ef7a9b249",
  "providerName": "!1Fake",
  "dateTimeUTC": "2019-03-13T18:19:51.4968823",
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


### Statutory Leave Types

|  |  |
| --- | --- |
| Adoption | **active** |
| Bereavement | **active** |
| Maternity | **active** |
| Neonatal Care | **active** |
| Paternity | **active** |
| SharedParental | **active** |
| Sick | **active** |

### Statutory Leave Statuses

|  |  |
| --- | --- |
| Pending | _Leave was submitted but has no payments (not entitled)_ |
| In-Progress | _Leave is active and employee has yet to be fully paid_ |
| Completed | _Leave has passed and employee has been fully paid for the leave_ |
