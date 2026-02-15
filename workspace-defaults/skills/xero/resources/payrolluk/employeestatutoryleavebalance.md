# Statutory Leave Balances

## Overview


|  |  |
| --- | --- |
| URL | `https://api.xero.com/payroll.xro/2.0/employees/{EmployeeID}/statutoryleavebalance?leaveType=sick&asOfDate=yyyy-MM-dd` |
| Methods Supported | GET |
| Description | Allows you to retrieve a specified statutory leave balance in Payroll for an employee <br>NOTE: Currently, only **Sick** leave balance is supported. |

## GET Statutory Leave Balance


`GET https://api.xero.com/payroll.xro/2.0/employees/{EmployeeID}/statutoryleaveBalance?leaveType={LeaveType}&asOfDate={AsOfDate}`

Retrieves a specified statutory leave balance for an employee

### Elements for Statutory Leave Balance request

|  |  |
| --- | --- |
| EmployeeID | The unique identifier of the employee to retrieve the balance. |
| LeaveType | The type of statutory leave. See leave types |
| AsOfDate | Optional. <br>The date from which to calculate balance remaining. <br>If not specified, current date UTC is used. |

### Elements for Statutory Leave Balance response

|  |  |
| --- | --- |
| LeaveType | The type of statutory leave. See leave types |
| BalanceRemaining | The balance remaining for the corresponding leave type as of specified date. |
| Units | The units will be "Hours" |

Example response for GET Employee Leave Balances – 200 OK Response

```
GET https://api.xero.com/payroll.xro/2.0/employees/35cdd697-c9fc-4931-b579-a18cb8b6fe14/statutoryleavebalance?leaveType=sick
```


Response Body

```
{
    "id": "907f0599-24cc-1aca-d24e-950ef7a9b249",
    "providerName": "!1Fake",
    "dateTimeUTC": "2019-02-25T22:02:56.9372541",
    "httpStatusCode": "OK",
    "pagination": null,
    "problem": null,
    "leaveBalance": {
        "leaveType": "Sick",
        "balanceRemaining": 1120,
        "units": "Hours"
    }
}
```


Example response for GET Employee Leave Balances – 404 Not Found Response

```
GET https://api.xero.com/payroll.xro/2.0/employees/35cdd697-c9fc-4931-b579-a18cb8b6fe14/statutoryleavebalance?leaveType=sick
```


Response Body

```
{
    "id": "656244e6-ff7b-dd43-dd60-4fa78d6efd52",
    "providerName": "Test",
    "dateTimeUTC": "2017-11-22T05:27:08.1387942",
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


Example response for GET Employee Leave Balances – 400 Bad Request Response

```
GET https://api.xero.com/payroll.xro/2.0/employees/35cdd697-c9fc-4931-b579-a18cb8b6fe14/statutoryleavebalance?leaveType=maternity
```


Response Body

```
{
    "id": "907f0599-24cc-1aca-d24e-950ef7a9b249",
    "providerName": "!1Fake",
    "dateTimeUTC": "2019-02-25T23:49:53.7919948",
    "httpStatusCode": "BadRequest",
    "pagination": null,
    "problem": {
        "type": "application/problem+json",
        "title": "BadRequest",
        "status": 400,
        "detail": "GET leave balance for leave type not yet implemented",
        "instance": null,
        "invalidFields": null
    },
    "leaveBalance": null
}
```


### Statutory Leave Types

|  |  |
| --- | --- |
| Adoption | _future_ |
| Bereavement | _future_ |
| Maternity | _future_ |
| Neonatal Care | _future_ |
| Paternity | _future_ |
| SharedParental | _future_ |
| Sick | **active** |
