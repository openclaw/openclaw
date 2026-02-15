# Leave Balances

## Overview


|  |  |
| --- | --- |
| URL | `https://api.xero.com/payroll.xro/2.0/employees/{EmployeeID}/leaveBalances` |
| Methods Supported | GET |
| Description | Allows you to retrieve leave balances in Payroll for an employee in a Xero organisation. |

## GET Leave Balances


`GET https://api.xero.com/payroll.xro/2.0/employees/{EmployeeID}/leaveBalances`

Retrieves all the leave balances for an active employee

### Elements for Leave Balances

|  |  |
| --- | --- |
| Name | Name of the leave type. |
| LeaveTypeID | The Xero identifier for leave type. See leave types |
| Balance | The employees current balance for the corresponding leave type. |
| TypeOfUnits | The type of the units of the leave. |

Example response for GET Employee Leave Balances – 200 OK Response

```
GET https://api.xero.com/payroll.xro/2.0/employees/35cdd697-c9fc-4931-b579-a18cb8b6fe14/leaveBalances
```


```
{
    "id": "656244e6-ff7b-dd43-dd60-4fa78d6efd52",
    "providerName": "Test",
    "dateTimeUTC": "2017-11-22T05:26:43.2936407",
    "httpStatusCode": "OK",
    "pagination": {
        "page": 1,
        "pageSize": 100,
        "pageCount": 1,
        "itemCount": 2
    },
    "problem": null,
    "leaveBalances": [
        {
            "name": "Holiday",
            "leaveTypeID": "1f3c77f2-e1f4-406f-9943-fb955dfe9409",
            "balance": 32,
            "typeOfUnits": "Hours"
        },
        {
            "name": "Unpaid Shared Parental Leave (SPL)",
            "leaveTypeID": "882ad775-8cfa-4713-8856-34557d5ba877",
            "balance": -74.76,
            "typeOfUnits": "Hours"
        }
    ]
}
```


Example response for GET Employee Leave Balances – 404 Not Found Response

```
GET https://api.xero.com/payroll.xro/2.0/employees/35cdd697-c9fc-4931-b579-a18cb8b6fe14/leaveBalances
```


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
