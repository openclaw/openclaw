# Employee Statutory Sick Leave

## Overview


|  |  |
| --- | --- |
| URLs | `https://api.xero.com/payroll.xro/2.0/statutoryleaves/sick` |
| Methods Supported | GET, POST |
| Description | Allows you to retrieve a statutory sick leave for a specified employee in Payroll <br>Allows you to add a statutory sick leave for a specified employee in Payroll |
| Limitations | Statutory Sick Leave is not supported for off-payroll workers |

## GET Statutory Leave


`GET https://api.xero.com/payroll.xro/2.0/statutoryleaves/sick/{StatutorySickLeaveID}?`

Retrieves a statutory sick leave for an employee in Payroll

### Elements for request

| Element Name | Element Description |
| --- | --- |
| StatutorySickLeaveID | The unique identifier of the sick leave |

### Elements for response

| Element Name | Element Description |
| --- | --- |
| StatutoryLeaveID | The unique identifier (guid) of a statutory leave |
| EmployeeID | The unique identifier (guid) of the employee |
| LeaveTypeID | The unique identifier (guid) of the "Statutory Sick Leave (non-pensionable)" pay item |
| StartDate | The date when the leave starts |
| EndDate | The date when the leave ends |
| WorkPattern | The days of the work week the employee is scheduled to work at the time the leave is taken. For employees with a `working-pattern` this will be `null` |
| IsPregnancyRelated | Whether the sick leave was pregnancy related |
| SufficientNotice | Whether the employee provided sufficent notice and documentation as required by the employer supporting the sick leave request |
| IsEntitled | Whether the leave was entitled to receive payment |
| EntitlementWeeksRequested | The amount of requested time (in weeks) |
| EntitlementWeeksQualified | The amount of statutory sick leave time off (in weeks) that is available to take at the time the leave was requested |
| EntitlementWeeksRemaining | A calculated amount of time (in weeks) that remains for the statutory sick leave period |
| OverlapsWithOtherLeave | Whether another leave (Paternity, Shared Parental specifically) occurs during the requested leave's period. While this is allowed it could affect payment amounts |
| EntitlementFailureReasons | If the leave requested was considered "not entitled", the reasons why are listed here. See entitlement failure reasons |

Example response for GET Statutory Sick Leave – 200 OK Response

```
GET https://api.xero.com/payroll.xro/2.0/statutoryleaves/sick/cbbc3309-249a-4c1c-87cf-53f30c257c21?
```


```
{

    "id": "907f0599-24cc-1aca-d24e-950ef7a9b249",
    "providerName": "!1Fake",
    "dateTimeUTC": "2019-03-13T21:12:32.3785681",
    "httpStatusCode": "OK",
    "pagination": null,
    "problem": null,
    "statutorySickLeave": {
        "statutoryLeaveID": "cbbc3309-249a-4c1c-87cf-53f30c257c21",
        "employeeID": "610d76b2-5e0e-46e4-b5c3-5c12fa7ab980",
        "leaveTypeID": "34e451b8-437e-421b-a260-752bddd54590",
        "startDate": "2019-03-01",
        "endDate": "2019-03-06",
        "workPattern": null,
        "isPregnancyRelated": false,
        "sufficientNotice": true,
        "isEntitled": true,
        "entitlementWeeksRequested": 0.8,
        "entitlementWeeksQualified": 28,
        "entitlementWeeksRemaining": 0,
        "overlapsWithOtherLeave": false,
        "entitlementFailureReasons": null
    }
}
```


Example response for GET Employee Statutory Sick Leave – not entitled

Note that in this reponse, the 'entitlementWeeksRemaining' are 0 as a leave that is "not entitled" will not incur a balance.

```
GET https://api.xero.com/payroll.xro/2.0/statutoryleaves/sick/66910b5e-a7a3-4e43-b8c7-9c9e714539ef?
```


```
{

    "id": "907f0599-24cc-1aca-d24e-950ef7a9b249",
    "providerName": "!1Fake",
    "dateTimeUTC": "2019-03-13T22:06:01.1622118",
    "httpStatusCode": "OK",
    "pagination": null,
    "problem": null,
    "statutorySickLeave": {
        "statutoryLeaveID": "66910b5e-a7a3-4e43-b8c7-9c9e714539ef",
        "employeeID": "610d76b2-5e0e-46e4-b5c3-5c12fa7ab980",
        "leaveTypeID": "34e451b8-437e-421b-a260-752bddd54590",
        "startDate": "2019-02-23",
        "endDate": "2019-02-27",
        "workPattern": [
            "Monday",
            "Tuesday",
            "Wednesday",
            "Thursday",
            "Friday"
        ],
        "isPregnancyRelated": false,
        "sufficientNotice": false,
        "isEntitled": false,
        "entitlementWeeksRequested": 0.6,
        "entitlementWeeksQualified": 26.6,
        "entitlementWeeksRemaining": 0,
        "overlapsWithOtherLeave": false,
        "entitlementFailureReasons": [
            "SufficientNoticeNotGiven"
        ]
    }
}
```


Example response for GET Employee Statutory Sick Leave – 404 Not Found Response

```
GET https://api.xero.com/payroll.xro/2.0/statutoryleaves/sick/35cdd697-c9fc-4931-b579-a18cb8b6fe14?
```


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


## POST Statutory Leave


`POST https://api.xero.com/payroll.xro/2.0/statutoryleaves/sick?`

Use this method to create statutory sick leave for an employee. Statutory Sick Leave is not supported for off-payroll workers.

### Elements for Statutory Sick Leave

_The following are **required** to create a new employee statutory sick leave_

| Element Name | Element Description |
| --- | --- |
| EmployeeID | The unique identifier (guid) of the employee |
| StartDate | The date when the leave starts |
| EndDate | The date when the leave ends. To qualify for statutory sick pay the employee must be out for at least 4 days in a row (including non-working days). |
| WorkPattern | The days of the work week the employee is scheduled to work at the time the leave is taken. For employees with a `working-pattern` this will be ignored. |
| LeaveTypeID | The unique identifer (guid) of the pay item referred to as "Statutory Sick Leave (non-pensionable)" |
| IsPregnancyRelated | Whether or not the sick leave was pregnancy related |
| SufficientNotice | Whether or not the employee provided sufficent notice and documentation as required by the employer |

Example response for POST Statutory Sick Leave – 200 OK Response

```
POST https://api.xero.com/payroll.xro/2.0/statutoryleaves/sick?
```


Request Body

```
{
    "employeeID": "610d76b2-5e0e-46e4-b5c3-5c12fa7ab980",
    "startDate": "2019-02-25",
    "endDate": "2019-03-01",
    "workPattern": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
    "leaveTypeID": "34e451b8-437e-421b-a260-752bddd54590",
    "isPregnancyRelated": false,
    "sufficientNotice": true
}
```


Response Body

```
{
    "id": "907f0599-24cc-1aca-d24e-950ef7a9b249",
    "providerName": "!1Fake",
    "dateTimeUTC": "2019-03-13T23:07:41.9799084",
    "httpStatusCode": "OK",
    "pagination": null,
    "problem": null,
    "statutorySickLeave": {
        "statutoryLeaveID": "6d69c1a4-cdad-45f5-a755-ac7c01bc2908",
        "employeeID": "610d76b2-5e0e-46e4-b5c3-5c12fa7ab980",
        "leaveTypeID": "34e451b8-437e-421b-a260-752bddd54590",
        "startDate": "2019-02-25",
        "endDate": "2019-03-01",
        "workPattern": [
            "Monday",
            "Tuesday",
            "Wednesday",
            "Thursday",
            "Friday"
        ],
        "isPregnancyRelated": false,
        "sufficientNotice": true,
        "isEntitled": true,
        "entitlementWeeksRequested": 1,
        "entitlementWeeksQualified": 26.6,
        "entitlementWeeksRemaining": 25.6,
        "overlapsWithOtherLeave": false,
        "entitlementFailureReasons": null
    }
}
```


Example response for POST Employee Statutory Sick Leave – 400 Bad Request Response

```
POST https://api.xero.com/payroll.xro/2.0/statutoryleaves/sick?
```


Request Body

```
{
    "employeeID": "610d76b2-5e0e-46e4-b5c3-5c12fa7ab980",
    "startDate": "2019-02-25",
    "endDate": "2019-03-01",
    "workPattern": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
    "leaveTypeID": "34e451b8-437e-421b-a260-752bddd54590",
    "isPregnancyRelated": false,
    "sufficientNotice": true
}
```


Response Body

```
{
    "id": "907f0599-24cc-1aca-d24e-950ef7a9b249",
    "providerName": "!1Fake",
    "dateTimeUTC": "2019-03-13T23:05:11.9883503",
    "httpStatusCode": "BadRequest",
    "pagination": null,
    "problem": {
        "type": "about:blank",
        "title": "BadRequest",
        "status": 400,
        "detail": "BadRequest",
        "instance": null,
        "invalidFields": [
            {
                "name": "StatutorySickLeave",
                "reason": "ActiveLeaveConflict"
            }
        ]
    },
    "statutorySickLeave": null
}
```


Example response for POST Employee Statutory Sick Leave for an off-payroll worker – 400 Bad
Request Response

```
POST https://api.xero.com/payroll.xro/2.0/statutoryleaves/sick?
```


Request Body

```
{
    "employeeID": "35483108-dbe5-48de-b0f5-ef3cd52e48de",
    "startDate": "2019-02-25",
    "endDate": "2019-03-01",
    "workPattern": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
    "leaveTypeID": "34e451b8-437e-421b-a260-752bddd54590",
    "isPregnancyRelated": false,
    "sufficientNotice": true
}
```


Response Body

```
{
    "id": "cd625bfb-0187-421f-9474-9458668d7376",
    "providerName": "xero/api",
    "dateTimeUTC": "2021-03-12T04:00:49.1077411",
    "httpStatusCode": "BadRequest",
    "pagination": null,
    "problem": {
        "type": "about:blank",
        "title": "BadRequest",
        "status": 400,
        "detail": "BadRequest",
        "instance": null,
        "invalidFields": [
            {
                "name": "StatutorySickLeave",
                "reason": null
            }
        ],
        "invalidObjects": null
    },
    "statutorySickLeave": null
}
```


Example response for POST Employee Statutory Sick Leave – 404 Not Found Response

This can happen if the employee is not found

```
POST https://api.xero.com/payroll.xro/2.0/statutoryleaves/sick?
```


Request Body

```
{
    "employeeID": "00000000-0000-0000-0000-00000000000",
    "startDate": "2019-02-25",
    "endDate": "2019-03-01",
    "workPattern": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
    "leaveTypeID": "34e451b8-437e-421b-a260-752bddd54590",
    "isPregnancyRelated": false,
    "sufficientNotice": true
}
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


### Entitlement Failure Reasons

| Element Name | Element Description |
| --- | --- |
| UnableToCalculateAwe | _Unable to calculate Average Weekly Earnings (AWE)_ |
| AweLowerThanLel | _Average Weekly Earnings (AWE) lower than the Lower Earnings Limit (LEL)_ |
| NotQualifiedInPreviousPiw | _Not qualified in previous PIW (Period of Incapacity to Work) which this leave is linked to_ |
| ExceededMaximumEntitlementWeeksOfSsp | _Exceeded the maximum entitlement of 28 weeks in previous linked PIW(s)_ |
| ExceededMaximumDurationOfPiw | _Exceeded 3 year limitation of continuous series of linked leave periods (PIWs)_ |
| SufficientNoticeNotGiven | _Sufficient notice has not been given_ |
