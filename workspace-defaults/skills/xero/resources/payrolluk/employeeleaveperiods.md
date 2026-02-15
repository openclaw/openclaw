# Leave Periods

## Overview


|  |  |
| --- | --- |
| URL | `https://api.xero.com/payroll.xro/2.0/employees/{EmployeeID}/leavePeriods?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD` |
| Methods Supported | GET |
| Description | Allows you to retrieve the leave periods for a specified employee in a Xero organisation given a start and end date. |

## GET Leave Periods


`GET https://api.xero.com/payroll.xro/2.0/employees/{EmployeeID}/leavePeriods?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD`

Retrieves leave periods for the given StartDate and EndDates

### Elements for a Leave Period

|  |  |
| --- | --- |
| StartDate | Start date of the leave (YYYY-MM-DD) |
| EndDate | End date of the leave (YYYY-MM-DD) |
| NumberOfUnits | The total number of hours the on leave for that period |

Example response for GET Employee Leave Periods – 200 OK Response

```
GET https://api.xero.com/payroll.xro/2.0/employees/35cdd697-c9fc-4931-b579-a18cb8b6fe14/leavePeriods?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
```


```
{
    "id": "c4be24e5-e840-4c92-9eaa-2d86cd596314",
    "providerName": "!YLT5Y",
    "dateTimeUTC": "2017-09-13T04:11:08.629317",
    "httpStatusCode": "OK",
    "pagination": null,
    "problem": null,
    "leavePeriods": [
        {
            "periodStartDate": "2017-11-02T00:00:00",
            "periodEndDate": "2017-11-08T00:00:00",
            "numberOfUnits": 24,
            "periodStatus": null
        },
        {
            "periodStartDate": "2017-11-09T00:00:00",
            "periodEndDate": "2017-11-15T00:00:00",
            "numberOfUnits": 40,
            "periodStatus": null
        }
    ]
}
```


Example response for GET Employee Leave Periods – 400 Bad Request

```
GET https://api.xero.com/payroll.xro/2.0/employees/35cdd697-c9fc-4931-b579-a18cb8b6fe14/leavePeriods
```


```
{
    "id": "c4be24e5-e840-4c92-9eaa-2d86cd596314",
    "providerName": "!YLT5Y",
    "dateTimeUTC": "2017-09-15T01:48:25.2943963",
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
                "name": "StartDate",
                "reason": "The start date is required"
            },
            {
                "name": "EndDate",
                "reason": "The end date is required"
            }
        ]
    },
    "periods": null
}
```
