# Leave Types

## Overview


|  |  |
| --- | --- |
| URL | `https://api.xero.com/payroll.xro/2.0/employees/{EmployeeID}/leaveTypes` |
| Methods Supported | GET, POST |
| Description | Allows you to retrieve assigned leave types in Payroll for an employee in a Xero organisation. <br>Allows you to add leave types in Payroll for an employee in a Xero organisation. |
| Limitations | Leave types are not supported for off-payroll workers |

## GET Leave Types


`GET https://api.xero.com/payroll.xro/2.0/employees/{EmployeeID}/leaveTypes`

Retrieves all the leave types for an active employee

### Elements for Leave Types

|  |  |
| --- | --- |
| LeaveTypeID | The Xero identifier for leave type. See leave types |
| ScheduleOfAccrual | See scheduleOfAccrual codes |
| HoursAccruedAnnually | The number of hours accrued for the leave annually. This is 0 when the scheduleOfAccrual chosen is "OnHourWorked" |
| MaximumToAccrue | The maximum number of hours that can be accrued for the leave |
| OpeningBalance | The initial number of hours assigned when the leave was added to the employee |
| RateAccruedHourly | The number of hours added to the leave balance for every hour worked by the employee. This is normally 0, unless the scheduleOfAccrual chosen is "OnHourWorked" |
| ScheduleOfAccrualDate | The date when an employee becomes entitled to their accrual. Only applicable when scheduleOfAccrual is set to "OnAnniversaryDate" |

Example response for GET Employee Leave types – 200 OK Response

```
GET https://api.xero.com/payroll.xro/2.0/employees/35cdd697-c9fc-4931-b579-a18cb8b6fe14/leaveTypes
```


```
{
    "id": "c4be24e5-e840-4c92-9eaa-2d86cd596314",
    "providerName": "!YLT5Y",
    "dateTimeUTC": "2017-09-12T00:07:35.3779023",
    "httpStatusCode": "OK",
    "pagination": null,
    "problem": null,
    "LeaveTypes": [
        {
            "leaveTypeID": "2d8fc263-9620-47a4-b071-15d67c45a0ce",
            "scheduleOfAccrual": "BeginningOfCalendarYear",
            "hoursAccruedAnnually": 100,
            "maximumToAccrue": 200,
            "openingBalance": 125,
            "rateAccruedHourly": 0,
            "scheduleOfAccrualDate": null
        },
        {
            "leaveTypeID": "3de5a4f8-07f5-4883-91d1-7ae3f90362d7",
            "scheduleOfAccrual": "OnAnniversaryDate",
            "hoursAccruedAnnually": 300,
            "maximumToAccrue": 2000,
            "openingBalance": 125,
            "rateAccruedHourly": 0,
            "scheduleOfAccrualDate": null
        }
    ]
}
```


## POST Leave Type


`POST https://api.xero.com/payroll.xro/2.0/employees/{EmployeeID}/leaveTypes`

Use this method to assign an existing leave type to the selected employee. Leave types are not supported for off-payroll workers. It cannot be a leave type already assigned to the employee.

### Elements for Posting a leave type

\| _The following are **required** to create a new leave application_ \| \|
\| LeaveTypeID \| The Xero identifier for leave type. See leave types \|
\| ScheduleOfAccrual \| See ScheduleOfAccrual codes \|

_The following are **optional** elements when creating a new leave application. Set to 0 by default if not included in the POST request. It is advisable to add values to them as to be able to properly allow the employee to use the leave._

|  |  |
| --- | --- |
| HoursAccruedAnnually | The number of hours accrued for the leave annually. This is 0 when the scheduleOfAccrual chosen is "OnHourWorked" |
| MaximumToAccrue | The maximum number of hours that can be accrued for the leave |
| OpeningBalance | The initial number of hours assigned when the leave was added to the employee |
| RateAccruedHourly | The number of hours added to the leave balance for every hour worked by the employee. This is normally 0, unless the scheduleOfAccrual chosen is "OnHourWorked" |
| ScheduleOfAccrualDate | The date when an employee becomes entitled to their accrual. Only applicable when scheduleOfAccrual is set to "OnAnniversaryDate" |

Example using minimum required elements to add a new leave type for an employee – 200 OK Response

```
POST https://api.xero.com/payroll.xro/2.0/employees/35cdd697-c9fc-4931-b579-a18cb8b6fe14/leaveTypes
```


Request Body

```
{
	"leaveTypeID": "0624ce8e-6561-4811-88b6-ad8ebfa74ac4",
	"scheduleOfAccrual": "OnHourWorked"
}
```


Response Body

```
{
    "id": "c4be24e5-e840-4c92-9eaa-2d86cd596314",
    "providerName": "!YLT5Y",
    "dateTimeUTC": "2017-09-12T02:59:18.5496918",
    "httpStatusCode": "OK",
    "pagination": null,
    "problem": null,
    "LeaveType": {
        "leaveTypeID": "0624ce8e-6561-4811-88b6-ad8ebfa74ac4",
        "scheduleOfAccrual": "OnHourWorked",
        "hoursAccruedAnnually": 0,
        "maximumToAccrue": 0,
        "openingBalance": 0,
        "rateAccruedHourly": 0
    }
}
```


Example for POST a Leave Type – 400 Bad Request

```
POST https://api.xero.com/payroll.xro/2.0/employees/35cdd697-c9fc-4931-b579-a18cb8b6fe14/leaveTypes
```


Request Body

```
{
	"scheduleOfAccrual": "OnAnniversaryDate"
}
```


Response Body

```
{
    "id": "c4be24e5-e840-4c92-9eaa-2d86cd596314",
    "providerName": "!YLT5Y",
    "dateTimeUTC": "2017-09-18T01:26:43.020908",
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
                "name": "EntitlementTypeID",
                "reason": "The Time Off type is required."
            }
        ]
    },
    "leaveType": null
}
```


Example for POST a Leave Type to an off-payroll worker – 400 Bad Request

```
POST https://api.xero.com/payroll.xro/2.0/employees/64a9de4b-85f4-4f5a-bae5-4495777dd0e6/leaveTypes
```


Request Body

```
{
    "leaveTypeID": "5c855a7a-def9-48d8-9c53-a296a1996f65",
    "scheduleOfAccrual":  "OnHourWorked",
    "hoursAccruedAnnually": 12.3,
    "maximumToAccrue": 40.123,
    "openingBalance": 7.24,
    "rateAccruedHourly": 4.56
}
```


Response Body

```
{
    "id": "cd625bfb-0187-421f-9474-9458668d7376",
    "providerName": "xero/api",
    "dateTimeUTC": "2021-03-12T06:37:19.4125009",
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
                "name": null,
                "reason": "Leave cannot be assigned, ensure the employee is set up."
            }
        ],
        "invalidObjects": null
    },
    "leaveType": null
}
```


Example for POST a Leave Type with EmployeeID not existing – 404 Not Found

```
POST https://api.xero.com/payroll.xro/2.0/employees/35cdd697-c9fc-4931-b579-a18cb8b6fe15/leaveTypes
```


Request Body

```
{
	"leaveTypeID": "0624ce8e-6561-4811-88b6-ad8ebfa74ac4",
	"scheduleOfAccrual": "OnHourWorked"
}
```


Response Body

```
{
    "id": "c4be24e5-e840-4c92-9eaa-2d86cd596314",
    "providerName": "!YLT5Y",
    "dateTimeUTC": "2017-09-18T01:24:59.1259836",
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
    "leaveType": null
}
```


#### OnHourWorked Example

Example of specifying the number of units for a leave application using scheduleOfAccrual: "OnHourWorked"

```
POST https://api.xero.com/payroll.xro/2.0/employees/35cdd697-c9fc-4931-b579-a18cb8b6fe14/leaveTypes
```


Request Body

```
{
	"leaveTypeID": "7c77e0de-a1fc-412a-9ed0-19907477f732",
	"scheduleOfAccrual": "OnHourWorked",
	"maximumToAccrue": 2000,
	"openingBalance": 100,
	"rateAccruedHourly": 0.25
}
```


Response Body

```
{
    "id": "c4be24e5-e840-4c92-9eaa-2d86cd596314",
    "providerName": "!YLT5Y",
    "dateTimeUTC": "2017-09-12T03:03:26.3096052",
    "httpStatusCode": "OK",
    "pagination": null,
    "problem": null,
    "employeeLeaveType": {
        "leaveTypeID": "7c77e0de-a1fc-412a-9ed0-19907477f732",
        "scheduleOfAccrual": "OnHourWorked",
        "hoursAccruedAnnually": 0,
        "maximumToAccrue": 2000,
        "openingBalance": 100,
        "rateAccruedHourly": 0.25
    }
}
```
