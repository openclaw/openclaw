# Timesheets

## Overview


|  |  |
| --- | --- |
| URLs | `https://api.xero.com/payroll.xro/2.0/timesheets`<br>`https://api.xero.com/payroll.xro/2.0/timesheets/{identifier}`<br>`https://api.xero.com/payroll.xro/2.0/timesheets/{identifier}/lines`<br>`https://api.xero.com/payroll.xro/2.0/timesheets/{identifier}/approve`<br>`https://api.xero.com/payroll.xro/2.0/timesheets/{identifier}/reverttodraft`<br>`https://api.xero.com/payroll.xro/2.0/timesheets/{identifier}/lines/{identifier}` |
| Methods Supported | GET, POST, PUT, DELETE |
| Description | Allows you to add and retrieve Payroll Timesheets in a Xero organisation <br>Allows you to add Timesheet Lines to Payroll Timesheets in a Xero organisation <br>Allows you to Approve a Payroll Timesheet in a Xero organisation <br>Allows you to Revert a Payroll Timesheet to Draft in a Xero organisation <br>Allows you to Delete a Payroll Timesheet in a Xero organisation <br>Allows you to update a Timesheet Line of a Payroll Timesheet in a Xero organisation <br>Allows you to delete a Timesheet Line of a Payroll Timesheet in a Xero organisation |

## GET Timesheets


`GET https://api.xero.com/payroll.xro/2.0/timesheets`

Retrieves all Payroll Timesheets in a Xero organisation

### Elements for Timesheets

|  |  |
| --- | --- |
| TimesheetID | The Xero identifier for a Timesheet |
| PayrollCalendarID | The Xero identifier for the Payroll Calendar that the Timesheet applies to |
| EmployeeID | The Xero identifier for the Employee that the Timesheet is for |
| StartDate | The Start Date of the Timesheet period (YYYY-MM-DD) |
| EndDate | The End Date of the Timesheet period (YYYY-MM-DD) |
| Status | See Timesheet Status codes |
| TotalHours | The Total Hours of the Timesheet |
| UpdatedDateUTC | The UTC date time that the Timesheet was last updated |

**Optional parameters for GET Timesheets**

|  |  |
| --- | --- |
| page | return the page of results, paginated by 100 results per page <br> – _example: ?page=2_ |
| filter | filter timesheets by an employee (using employeeId) or a pay run calendar (using payrollCalendarId) <br> – _example: ?filter=employeeId=={guid}_<br> – _example: ?filter=payrollCalendarId=={guid}_ |
| status | filter results by any timesheets with a matching timesheet status<br> – _example: ?status=Draft_ |
| startDate | filter results by any timesheets with a startDate on or after the provided date <br> – _example: ?startDate={yyyy-MM-dd}_ |
| endDate | filter results by any timesheets with an endDate on or before the provided date <br> – _example: ?startDate={yyyy-MM-dd}_ |
| sort | sort the order of timesheets returned. The default is based on the timesheets createdDate, sorted _oldest to newest_. Currently, the only other option is to reverse the order based on the timesheets startDate, sorted _newest to oldest_. <br> – _example: ?sort=startDate_ |

Example response for GET Timesheets – 200 OK Response

```
GET https://api.xero.com/payroll.xro/2.0/timesheets
```


```
{
  "id": "7eecfdef-46b3-446e-8063-9338cef93611",
  "providerName": "Your provider name",
  "dateTimeUTC": "2017-09-11T01:23:19.201032",
  "httpStatusCode": "OK",
  "pagination": {
    "page": 1,
    "pageSize": 100,
    "pageCount": 1,
    "itemCount": 3
  },
  "problem": null,
  "timesheets": [
    {
      "timesheetID": "00cfdcdb-29e3-43a2-b47e-f3d8424952e4",
      "payrollCalendarID": "7bc23d98-790f-4990-a159-c5c2f6c950d6",
      "employeeID": "dc92aeef-c3cb-4dbe-8aaa-abfbf9e3c5c7",
      "startDate": "2017-05-01T00:00:00",
      "endDate": "2017-05-07T00:00:00",
      "status": "Draft",
      "totalHours": 12,
      "updatedDateUTC": "2017-09-06T00:12:43"
    },
    {
      "timesheetID": "a10767d2-5566-4f25-9d65-e2329dd2a67e",
      "payrollCalendarID": "7bc23d98-790f-4990-a159-c5c2f6c950d6",
      "employeeID": "dc92aeef-c3cb-4dbe-8aaa-abfbf9e3c5c7",
      "startDate": "2017-05-08T00:00:00",
      "endDate": "2017-05-14T00:00:00",
      "status": "Completed",
      "totalHours": 21,
      "updatedDateUTC": "2017-09-06T04:04:23"
    },
    {
      "timesheetID": "7c377c2d-36d9-41c5-b4e3-88ad7cf54611",
      "payrollCalendarID": "8210598b-1630-4be7-90db-f5c6fd5d6418",
      "employeeID": "e5ac8ae8-3dcc-4be7-a6a0-c84d1aab010a",
      "startDate": "2017-08-01T00:00:00",
      "endDate": "2017-08-31T00:00:00",
      "status": "Approved",
      "totalHours": 32,
      "updatedDateUTC": "2017-09-07T01:34:57"
    }
  ]
}
```


## GET Timesheet by identifier


`https://api.xero.com/payroll.xro/2.0/Timesheet/{TimesheetID}`

Retrieves a Payroll Timesheet in a Xero organisation using timesheet identifier

### Elements for Timesheet

|  |  |
| --- | --- |
| TimesheetID | The Xero identifier for a Timesheet |
| PayrollCalendarID | The Xero identifier for the Payroll Calendar that the Timesheet applies to |
| EmployeeID | The Xero identifier for the Employee that the Timesheet is for |
| StartDate | The Start Date of the Timesheet period (YYYY-MM-DD) |
| EndDate | The End Date of the Timesheet period (YYYY-MM-DD) |
| Status | See Timesheet Status codes |
| TotalHours | The Total Hours of the Timesheet |
| UpdatedDateUTC | The UTC date time that the Timesheet was last updated |
| TimesheetLines | The individual lines that make up the Timesheet. <br>See TimesheetLines |

### Elements for Timesheet Line

|  |  |
| --- | --- |
| TimesheetLineID | The Xero identifier for a Timesheet Line |
| Date | The Date that this Timesheet Line is for (YYYY-MM-DD) |
| EarningsRateID | The Xero identifier for the Earnings Rate that the Timesheet is for |
| TrackingItemID | The Xero identifier for the Tracking Item that the Timesheet is for |
| NumberOfUnits | The Number of Units of the Timesheet Line |

Example response for GET Timesheet by identifier – 200 OK Response

```
GET https://api.xero.com/payroll.xro/2.0/timesheets/a10767d2-5566-4f25-9d65-e2329dd2a67e
```


```
{
  "id": "7eecfdef-46b3-446e-8063-9338cef93611",
  "providerName": "Your provider name",
  "dateTimeUTC": "2017-09-11T05:06:49.4892722",
  "httpStatusCode": "OK",
  "pagination": null,
  "problem": null,
  "timesheet": {
    "timesheetID": "a10767d2-5566-4f25-9d65-e2329dd2a67e",
    "payrollCalendarID": "7bc23d98-790f-4990-a159-c5c2f6c950d6",
    "employeeID": "dc92aeef-c3cb-4dbe-8aaa-abfbf9e3c5c7",
    "startDate": "2017-05-08T00:00:00",
    "endDate": "2017-05-14T00:00:00",
    "status": "Completed",
    "totalHours": 21,
    "updatedDateUTC": "2017-09-06T04:04:23",
    "timesheetLines": [
      {
        "timesheetLineID": "d9e7dfb6-e0fd-4bbc-98b6-5981d8e14a99",
        "date": "2017-05-08T00:00:00",
        "earningsRateID": "1f4e4951-487b-4b57-94ce-5a6dd620d78c",
        "trackingItemID": "ea806cf0-4bce-4c9f-a37e-bf7c4551a14b",
        "numberOfUnits": 6
      },
      {
        "timesheetLineID": "4708339a-5d98-493e-9f79-b190b3f4c7a4",
        "date": "2017-05-08T00:00:00",
        "earningsRateID": "1f4e4951-487b-4b57-94ce-5a6dd620d78c",
        "trackingItemID": null,
        "numberOfUnits": 7
      },
      {
        "timesheetLineID": "09d79b57-c90a-4e09-9424-36719cf2c92d",
        "date": "2017-05-08T00:00:00",
        "earningsRateID": "1f4e4951-487b-4b57-94ce-5a6dd620d78c",
        "trackingItemID": "ea806cf0-4bce-4c9f-a37e-bf7c4551a14b",
        "numberOfUnits": 8
      }
    ]
  }
}
```


## POST Timesheet


`https://api.xero.com/payroll.xro/2.0/timesheets`

Use this method to add a payroll timesheet.

### Elements for Timesheet

_The following are **required** to create a new timesheet_

|  |  |
| --- | --- |
| PayrollCalendarID | The Xero identifier for the Payroll Calendar that the Timesheet applies to |
| EmployeeID | The Xero identifier for the Employee that the Timesheet is for |
| StartDate | The Start Date of the Timesheet period (YYYY-MM-DD) |
| EndDate | The End Date of the Timesheet period (YYYY-MM-DD) |

_The following are **optional** properties_

|  |  |
| --- | --- |
| TimesheetLines | The collection of worked hours by day within the timesheet period |

Example of minimum elements required to add a new Timesheet – 200 OK Response

```
POST https://api.xero.com/payroll.xro/2.0/timesheets/
```


Request Body

```
{
  "payrollCalendarID": "fe5647b8-33a0-4df4-bce4-93f4e7eeb08b",
  "employeeID": "f4eb722e-4c42-450c-9aba-f7c888aff3b4",
  "startDate": "2017-05-12",
  "endDate": "2017-05-18"
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
  "timesheet": {
    "timesheetID": "250b17ad-b209-4ede-b4de-3fa4c5b4dcbf",
    "payrollCalendarID": "fe5647b8-33a0-4df4-bce4-93f4e7eeb08b",
    "employeeID": "f4eb722e-4c42-450c-9aba-f7c888aff3b4",
    "startDate": "2017-05-12T00:00:00",
    "endDate": "2017-05-18T00:00:00",
    "status": "Draft",
    "totalHours": 0,
    "updatedDateUTC": "2017-09-18T06:02:29.7577977",
    "timesheetLines": []
  }
}
```


Example of adding a timesheet with timesheet lines – 200 OK Response

```
POST https://api.xero.com/payroll.xro/2.0/timesheets/
```


Request Body

```
{
  "payrollCalendarID": "fe5647b8-33a0-4df4-bce4-93f4e7eeb08b",
  "employeeID": "f4eb722e-4c42-450c-9aba-f7c888aff3b4",
  "startDate": "2019-04-16",
  "endDate": "2019-04-22",
  "timesheetLines": [
    {
      "date": "2019-04-16",
      "earningsRateID": 1f4e4951-487b-4b57-94ce-5a6dd620d78c",
      "numberOfUnits": 8
    },
    {
      "date": "2019-04-17",
      "earningsRateID": "1f4e4951-487b-4b57-94ce-5a6dd620d78c",
      "numberOfUnits": 8
    },
    {
      "date": "2019-04-18",
      "earningsRateID": "1f4e4951-487b-4b57-94ce-5a6dd620d78c",
      "numberOfUnits": 8
    },
    {
      "date": "2019-04-19",
      "earningsRateID": "1f4e4951-487b-4b57-94ce-5a6dd620d78c",
      "numberOfUnits": 8
    },
    {
      "date": "2019-04-20",
      "earningsRateID": "1f4e4951-487b-4b57-94ce-5a6dd620d78c",
      "numberOfUnits": 8
    }
  ]
}
```


Response Body

```
{
  "timesheetID": "732b1b7c-eaa1-4e5c-9e49-febf83772195",
  "startDate": "2019-04-16T00:00:00",
  "endDate": "2019-04-22T00:00:00",
  "payrollCalendarID": "71482108-b931-4569-b670-92c19bec0273",
  "employeeID": "349e2fb9-dcca-4406-97fa-ba96e309ac4c",
  "status": "Draft",
  "totalHours": 48,
  "updatedDateUTC": "2019-04-29T19:12:07.0346653",
  "timesheetLines": [
    {
      "timesheetLineID": "62b5c7b2-d876-47ce-b921-ad434f6f6d90",
      "date": "2019-04-20T00:00:00",
      "earningsRateID": "750b374e-a9b1-4273-8e52-a31c29e51844",
      "trackingCategoryID": null,
      "numberOfUnits": 8
    },
    {
      "timesheetLineID": "58621b29-f429-41d1-9fe5-d627b2b0277a",
      "date": "2019-04-18T00:00:00",
      "earningsRateID": "750b374e-a9b1-4273-8e52-a31c29e51844",
      "trackingCategoryID": null,
      "numberOfUnits": 8
    },
    {
      "timesheetLineID": "818a6df2-7351-4486-903a-a6b0d3b3eac3",
      "date": "2019-04-16T00:00:00",
      "earningsRateID": "750b374e-a9b1-4273-8e52-a31c29e51844",
      "trackingCategoryID": null,
      "numberOfUnits": 8
    },
    {
      "timesheetLineID": "305238f4-1735-4712-b7ad-181f4c9ff6b2",
      "date": "2019-04-19T00:00:00",
      "earningsRateID": "750b374e-a9b1-4273-8e52-a31c29e51844",
      "trackingCategoryID": null,
      "numberOfUnits": 8
    },
    {
      "timesheetLineID": "8fd44d9b-91fc-46da-9b79-3a06ad331a37",
      "date": "2019-04-17T00:00:00",
      "earningsRateID": "750b374e-a9b1-4273-8e52-a31c29e51844",
      "trackingCategoryID": null,
      "numberOfUnits": 8
    },
    {
      "timesheetLineID": "995e1591-c0ae-4fe6-80f0-9ee27274c1f8",
      "date": "2019-04-21T00:00:00",
      "earningsRateID": "750b374e-a9b1-4273-8e52-a31c29e51844",
      "trackingCategoryID": null,
      "numberOfUnist": 8
    }
  ],
  "concurrencyToken": 1
}
```


Example add a new Timesheet, missing a required parameter – 400 Bad Request Response

```
POST https://api.xero.com/payroll.xro/2.0/timesheets/
```


Request Body

```
{
  "payrollCalendarID": "fe5647b8-33a0-4df4-bce4-93f4e7eeb08b",
  "startDate": "2017-05-12",
  "endDate": "2017-05-18"
}
```


Response Body

```
{
  "id": "54a1f6aa-eee7-d860-f44b-ffc6e10ded5a",
  "providerName": "!YLT5Y",
  "dateTimeUTC": "2017-09-18T06:53:03.732772",
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
        "name": "EmployeeID",
        "reason": "The employee is required"
      }
    ],
    "invalidObjects": [
      {
        "timesheetID": null,
        "startDate": "2019-04-16T00:00:00",
        "endDate": "2019-04-22T00:00:00",
        "payrollCalendarID": "71482108-b931-4569-b670-92c19bec0273",
        "employeeID": null,
        "status": "Draft",
        "totalHours": 48,
        "updatedDateUTC": null,
        "timesheetLines": [],
        "concurrencyToken": null,
        "isValid": false,
        "validationResult": {
          "memberNames": [
            "EmployeeID"
          ],
          "errorMessage": "The employee is required"
        }
      }
    ]
  }
}
```


Example adding a new Timesheet with invalid timesheet lines – 400 Bad Request Response

```
POST https://api.xero.com/payroll.xro/2.0/timesheets/
```


Request Body

```
{
  "timesheetID": null,
  "startDate": "2019-04-16",
  "endDate": "2019-04-22",
  "employeeID": "349e2fb9-dcca-4406-97fa-ba96e309ac4c",
  "payrollCalendarID": "71482108-b931-4569-b670-92c19bec0273",
  "timesheetLines": [
    {
      "date": "2019-04-26",
      "earningsRateID": "750b374e-a9b1-4273-8e52-a31c29e51844",
      "numberOfUnits": 8
    },
    {
      "date": "2019-04-27",
      "earningsRateID": "750b374e-a9b1-4273-8e52-a31c29e51844",
      "numberOfUnits": 8
    },
    {
      "date": "2019-04-28",
      "earningsRateID": "750b374e-a9b1-4273-8e52-a31c29e51844",
      "numberOfUnits": 8
    },
    {
      "date": "2019-04-19",
      "earningsRateID": "750b374e-a9b1-4273-8e52-a31c29e51844",
      "numberOfUnits": 8
    },
    {
      "date": "2019-04-20",
      "earningsRateID": "750b374e-a9b1-4273-8e52-a31c29e51844",
      "numberOfUnits": 8
    },
    {
      "date": "2019-04-21",
      "earningsRateID": "750b374e-a9b1-4273-8e52-a31c29e51844",
      "numberOfUnits": 8
    }]
}
```


Response Body

```
{
  "type": "application/problem+json",
  "title": "BadRequest",
  "status": 400,
  "detail": "One or more errors have occurred",
  "instance": null,
  "invalidFields": null,
  "invalidIds": null,
  "invalidObjects": [
    {
      "timesheetID": null,
      "startDate": "2019-04-16T00:00:00",
      "endDate": "2019-04-22T00:00:00",
      "payrollCalendarID": "71482108-b931-4569-b670-92c19bec0273",
      "employeeID": "349e2fb9-dcca-4406-97fa-ba96e309ac4c",
      "status": 0,
      "totalHours": null,
      "updatedDateUTC": null,
      "timesheetLines": [
        {
          "timesheetLineID": null,
          "date": "2019-04-26T00:00:00",
          "earningsRateID": "750b374e-a9b1-4273-8e52-a31c29e51844",
          "trackingCategoryID": null,
          "numberOfUnit": 8,
          "isValid": false,
          "validationResult": {
            "memberNames": [
              "Date"
            ],
            "errorMessage": "Date must be within timesheet date range"
          }
        },
        {
          "timesheetLineID": null,
          "date": "2019-04-28T00:00:00",
          "earningsRateID": "750b374e-a9b1-4273-8e52-a31c29e51844",
          "trackingCategoryID": null,
          "numberOfUnit": 8,
          "isValid": false,
          "validationResult": {
            "memberNames": [
              "Date"
            ],
            "errorMessage": "Date must be within timesheet date range"
          }
        },
        {
          "timesheetLineID": null,
          "date": "2019-04-27T00:00:00",
          "earningsRateID": "750b374e-a9b1-4273-8e52-a31c29e51844",
          "trackingCategoryID": null,
          "numberOfUnit": 8,
          "isValid": false,
          "validationResult": {
            "memberNames": [
              "Date"
            ],
            "errorMessage": "Date must be within timesheet date range"
          }
        }
      ],
      "concurrencyToken": null
    }
  ]
}
```


Example add an invalid Timesheet with included timesheet lines – 400 Bad Request Response

```
POST https://api.xero.com/payroll.xro/2.0/timesheets/
```


Request Body

```
{
  "timesheetID": null,
  "startDate": "2019-04-16",
  "endDate": "2019-04-22",
  "employeeID": "349e2fb9-dcca-4406-97fa-ba96e309ac4c",
  "payrollCalendarID": "71482108-b931-4569-b670-92c19bec0273",
  "timesheetLines": [
  {
    "date": "2019-04-16",
    "earningsRateID": "750b374e-a9b1-4273-8e52-a31c29e51844",
    "numberOfUnits": 8
  },
  {
    "date": "2019-04-17",
    "earningsRateID": "750b374e-a9b1-4273-8e52-a31c29e51844",
    "numberOfUnits": 8
  },
  {
    "date": "2019-04-18",
    "earningsRateID": "750b374e-a9b1-4273-8e52-a31c29e51844",
    "numberOfUnits": 8
  },
  {
    "date": "2019-04-19",
    "earningsRateID": "750b374e-a9b1-4273-8e52-a31c29e51844",
    "numberOfUnits": 8
  },
  {
    "date": "2019-04-20",
    "earningsRateID": "750b374e-a9b1-4273-8e52-a31c29e51844",
    "numberOfUnits": 8
  },
  {
    "date": "2019-04-21",
    "earningsRateID": "750b374e-a9b1-4273-8e52-a31c29e51844",
    "numberOfUnits": 8
  }]
}
```


Response Body

```
{
  "id": "907f0599-24cc-1aca-d24e-950ef7a9b249",
  "providerName": "!YLT5Y",
  "dateTimeUTC": "2019-04-29T15:57:25.5323434",
  "httpStatusCode": "BadRequest",
  "pagination": null,
  "problem": {
    "type": "application/problem+json",
    "title": "BadRequest",
    "status": 400,
    "detail": "Validation error occured.",
    "instance": null,
    "invalidFields": [
      {
        "name": "TimesheetId",
        "reason": "The timesheet already exists for this employee and pay period"
      }
    ],
    "invalidObjects": [
      {
        "timesheetID": null,
        "payrollCalendarID": "71482108-b931-4569-b670-92c19bec0273",
        "employeeID": "349e2fb9-dcca-4406-97fa-ba96e309ac4c",
        "startDate": "2019-04-16T00:00:00",
        "endDate": "2019-04-22T00:00:00",
        "status": 0,
        "totalHours": null,
        "updatedDateUTC": null,
        "timesheetLines": [
          {
            "timesheetLineID": null,
            "date": "2019-04-16T00:00:00",
            "earningsRateID": "750b374e-a9b1-4273-8e52-a31c29e51844",
            "trackingItemID": null,
            "numberOfUnits": 8
          },
          {
            "timesheetLineID": null,
            "date": "2019-04-17T00:00:00",
            "earningsRateID": "750b374e-a9b1-4273-8e52-a31c29e51844",
            "trackingItemID": null,
            "numberOfUnits": 8
          },
          {
            "timesheetLineID": null,
            "date": "2019-04-18T00:00:00",
            "earningsRateID": "750b374e-a9b1-4273-8e52-a31c29e51844",
            "trackingItemID": null,
            "numberOfUnits": 8
          },
          {
            "timesheetLineID": null,
            "date": "2019-04-19T00:00:00",
            "earningsRateID": "750b374e-a9b1-4273-8e52-a31c29e51844",
            "trackingItemID": null,
            "numberOfUnits": 8
          },
          {
            "timesheetLineID": null,
            "date": "2019-04-20T00:00:00",
            "earningsRateID": "750b374e-a9b1-4273-8e52-a31c29e51844",
            "trackingItemID": null,
            "numberOfUnits": 8
          },
          {
            "timesheetLineID": null,
            "date": "2019-04-21T00:00:00",
            "earningsRateID": "750b374e-a9b1-4273-8e52-a31c29e51844",
            "trackingItemID": null,
            "numberOfUnits": 8
          }
        ],
        "errorMessage": "The timesheet already exists for this employee and pay period"
      }
    ]
  },
  "timesheet": null
}
```


## POST Timesheet Line


`https://api.xero.com/payroll.xro/2.0/timesheets/{TimesheetID}/lines`

Use this method to add a timesheet line to a payroll timesheet.

### Elements for Timesheet Line

_The following are **required** to create a new timesheet_

|  |  |
| --- | --- |
| Date | The Date that this Timesheet Line is for (YYYY-MM-DD) |
| EarningsRateID | The Xero identifier for the Earnings Rate that the Timesheet is for |
| NumberOfUnits | The Number of Units of the Timesheet Line |

_The following are **optional** when creating a timesheet_

|  |  |
| --- | --- |
| TrackingItemID | The Xero identifier for the Tracking Item that the Timesheet is for. See addingTimeSheetLine with Tracking item |

Example of minimum elements required to add a new Timesheet Line – 200 OK Response

```
POST https://api.xero.com/payroll.xro/2.0/timesheets/a10767d2-5566-4f25-9d65-e2329dd2a67e/lines
```


Request Body

```
{
  "date": "2017-05-12",
  "earningsRateID": "1f4e4951-487b-4b57-94ce-5a6dd620d78c",
  "numberOfUnits": 7
}
```


Response Body

```
{
  "id": "54a1f6aa-eee7-d860-f44b-ffc6e10ded5a",
  "providerName": "!YLT5Y",
  "dateTimeUTC": "2017-09-18T06:26:30.8676487",
  "httpStatusCode": "OK",
  "pagination": null,
  "problem": null,
  "timesheetLine": {
    "timesheetLineID": "2d119e7a-3f83-4004-9cdd-f01811269b45",
    "date": "2017-05-12T00:00:00",
    "earningsRateID": "1f4e4951-487b-4b57-94ce-5a6dd620d78c",
    "trackingItemID": null,
    "numberOfUnits": 7
  }
}
```


Example add a Timesheet Line, missing a required parameter – 400 Bad Request Response

```
POST https://api.xero.com/payroll.xro/2.0/timesheets/a10767d2-5566-4f25-9d65-e2329dd2a67e/lines
```


Request Body

```
{
  "date": "2017-05-12",
  "earningsRateID": "1f4e4951-487b-4b57-94ce-5a6dd620d78c"
}
```


Response Body

```
{
  "id": "54a1f6aa-eee7-d860-f44b-ffc6e10ded5a",
  "providerName": "!YLT5Y",
  "dateTimeUTC": "2017-09-18T07:03:54.3823948",
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
        "name": "Time",
        "reason": "Time must be greater than zero"
      }
    ]
  },
  "timesheetLine": null
}
```


Example add a Timesheet Line, not existing timesheet – 404 Not Found Response

```
POST https://api.xero.com/payroll.xro/2.0/timesheets/a10767d2-5566-4f25-9d65-e2329dd2a67f/lines
```


Request Body

```
{
  "date": "2017-05-12",
  "earningsRateID": "1f4e4951-487b-4b57-94ce-5a6dd620d78c"
}
```


Response Body

```
{
  "id": "54a1f6aa-eee7-d860-f44b-ffc6e10ded5a",
  "providerName": "!YLT5Y",
  "dateTimeUTC": "2017-09-18T07:07:07.1759059",
  "httpStatusCode": "NotFound",
  "pagination": null,
  "problem": {
    "type": "about:blank",
    "title": "NotFound",
    "status": 404,
    "detail": "NotFound",
    "instance": null,
    "invalidFields": null
  },
  "timesheetLine": null
}
```


#### Example Timesheet Line with tracking item

Example of adding a Timesheet Line with a tracking item – 200 OK Response

```
POST https://api.xero.com/payroll.xro/2.0/timesheets/a10767d2-5566-4f25-9d65-e2329dd2a67e/lines
```


Request Body

```
{
  "date": "2017-05-12",
  "earningsRateID": "1f4e4951-487b-4b57-94ce-5a6dd620d78c",
  "numberOfUnits": 7,
  "trackingItemID": "40308fcc-ea06-4a07-8f6a-f0f92bb92f81"
}
```


Response Body

```
{
  "id": "54a1f6aa-eee7-d860-f44b-ffc6e10ded5a",
  "providerName": "!YLT5Y",
  "dateTimeUTC": "2017-09-18T06:26:30.8676487",
  "httpStatusCode": "OK",
  "pagination": null,
  "problem": null,
  "timesheetLine": {
    "timesheetLineID": "2d119e7a-3f83-4004-9cdd-f01811269b45",
    "date": "2017-05-12T00:00:00",
    "earningsRateID": "1f4e4951-487b-4b57-94ce-5a6dd620d78c",
    "trackingItemID": "40308fcc-ea06-4a07-8f6a-f0f92bb92f81",
    "numberOfUnits": 7
  }
}
```


## POST Approve Timesheet


`https://api.xero.com/payroll.xro/2.0/timesheets/{TimesheetID}/approve`

Use this method to approve a Timesheet

Example of approving a Timesheet – 200 OK Response

```
POST https://api.xero.com/payroll.xro/2.0/timesheets/a10767d2-5566-4f25-9d65-e2329dd2a67e/approve
```


Response Body

```
{
  "id": "54a1f6aa-eee7-d860-f44b-ffc6e10ded5a",
  "providerName": "!YLT5Y",
  "dateTimeUTC": "2017-09-18T06:35:06.2257782",
  "httpStatusCode": "OK",
  "pagination": null,
  "problem": null,
  "timesheet": {
    "timesheetID": "250b17ad-b209-4ede-b4de-3fa4c5b4dcbf",
    "payrollCalendarID": "fe5647b8-33a0-4df4-bce4-93f4e7eeb08b",
    "employeeID": "f4eb722e-4c42-450c-9aba-f7c888aff3b4",
    "startDate": "2017-05-12T00:00:00",
    "endDate": "2017-05-18T00:00:00",
    "status": "Approved",
    "totalHours": 0,
    "updatedDateUTC": "2017-09-18T06:35:06.2207784",
    "timesheetLines": [
      {
        "timesheetLineID": "2d119e7a-3f83-4004-9cdd-f01811269b45",
        "date": "2017-05-12T00:00:00",
        "earningsRateID": "e078035b-828a-471b-959d-a7c58eb32dbf",
        "trackingItemID": "aa16a6af-773b-4a65-9402-64af47191d5d",
        "numberOfUnits": 7
      }
    ]
  }
}
```


Example of approving a Timesheet, not existing timesheet – 404 Not Found Response

```
POST https://api.xero.com/payroll.xro/2.0/timesheets/a10767d2-5566-4f25-9d65-e2329dd2a67f/approve
```


Response Body

```
{
  "id": "54a1f6aa-eee7-d860-f44b-ffc6e10ded5a",
  "providerName": "!YLT5Y",
  "dateTimeUTC": "2017-09-18T07:19:05.515367",
  "httpStatusCode": "NotFound",
  "pagination": null,
  "problem": {
      "type": "about:blank",
      "title": "NotFound",
      "status": 404,
      "detail": "NotFound",
      "instance": null,
      "invalidFields": null
  },
  "timesheet": null
}
```


## POST Revert Timesheet to Draft


`https://api.xero.com/payroll.xro/2.0/timesheets/{TimesheetID}/reverttodraft`

Use this method to revert a Timesheet to draft

Example of reverting a Timesheet to draft – 200 OK Response

```
POST https://api.xero.com/payroll.xro/2.0/timesheets/a10767d2-5566-4f25-9d65-e2329dd2a67e/reverttodraft
```


Response Body

```
{
  "id": "54a1f6aa-eee7-d860-f44b-ffc6e10ded5a",
  "providerName": "!YLT5Y",
  "dateTimeUTC": "2017-09-18T06:45:26.8930551",
  "httpStatusCode": "OK",
  "pagination": null,
  "problem": null,
  "timesheet": {
    "timesheetID": "250b17ad-b209-4ede-b4de-3fa4c5b4dcbf",
    "payrollCalendarID": "fe5647b8-33a0-4df4-bce4-93f4e7eeb08b",
    "employeeID": "f4eb722e-4c42-450c-9aba-f7c888aff3b4",
    "startDate": "2017-05-12T00:00:00",
    "endDate": "2017-05-18T00:00:00",
    "status": "Draft",
    "totalHours": 0,
    "updatedDateUTC": "2017-09-18T06:45:26.889052",
    "timesheetLines": [
      {
        "timesheetLineID": "2d119e7a-3f83-4004-9cdd-f01811269b45",
        "date": "2017-05-12T00:00:00",
        "earningsRateID": "e078035b-828a-471b-959d-a7c58eb32dbf",
        "trackingItemID": "aa16a6af-773b-4a65-9402-64af47191d5d",
        "numberOfUnits": 7
      }
    ]
  }
}
```


Example of reverting a Timesheet to draft, not existing timesheet – 404 Not Found Response

```
POST https://api.xero.com/payroll.xro/2.0/timesheets/a10767d2-5566-4f25-9d65-e2329dd2a67f/reverttodraft
```


Response Body

```
{
  "id": "54a1f6aa-eee7-d860-f44b-ffc6e10ded5a",
  "providerName": "!YLT5Y",
  "dateTimeUTC": "2017-09-18T07:23:22.5307145",
  "httpStatusCode": "NotFound",
  "pagination": null,
  "problem": {
    "type": "about:blank",
    "title": "NotFound",
    "status": 404,
    "detail": "NotFound",
    "instance": null,
    "invalidFields": null
  },
  "timesheet": null
}
```


## PUT Timesheet Line


`https://api.xero.com/payroll.xro/2.0/timesheets/{TimesheetID}/lines/{TimesheetLineID}`

Use this method to update a timesheet line of a payroll timesheet.

### Elements for Timesheet Line

_The following are **required** to update a new timesheet_

|  |  |
| --- | --- |
| TimesheetLineID | The Xero identifier for a Timesheet Line |
| Date | The Date that this Timesheet Line is for (YYYY-MM-DD) |
| EarningsRateID | The Xero identifier for the Earnings Rate that the Timesheet is for |
| NumberOfUnits | The Number of Units of the Timesheet Line |

_The following are **optional** when updating a timesheet_

|  |  |
| --- | --- |
| TrackingItemID | The Xero identifier for the Tracking Item that the Timesheet is for. See addingTimeSheetLine with Tracking item |

Example of updating a Timesheet Line – 200 OK Response

```
PUT https://api.xero.com/payroll.xro/2.0/timesheets/ef09dfbe-496b-4bc7-9431-5c33a1b78b95/lines/0f773e22-c8f1-4680-aa8d-17ecb41dd5cb
```


Request Body

```
{
  "date": "2017-03-06T00:00:00",
  "earningsRateID": "1e5304e6-40c8-4dd8-9bfb-87b70de7a705",
  "numberOfUnits": 17
}
```


Response Body

```
{
  "id": "41c1daf9-55e5-2204-4a50-e6f0584de1d7",
  "providerName": "!YLT5Y",
  "dateTimeUTC": "2018-03-29T00:33:17.5440655",
  "httpStatusCode": "OK",
  "pagination": null,
  "problem": null,
  "timesheetLine": {
    "timesheetLineID": "0f773e22-c8f1-4680-aa8d-17ecb41dd5cb",
    "date": "2017-03-06T00:00:00",
    "earningsRateID": "1e5304e6-40c8-4dd8-9bfb-87b70de7a705",
    "trackingItemID": "56618f9e-9999-4692-a5b3-cf3ce6c5f6ed",
    "numberOfUnits": 17
  }
}
```


Example of updating a Timesheet Line – Missing required fields – 400 Bad Request Response

```
PUT https://api.xero.com/payroll.xro/2.0/timesheets/ef09dfbe-496b-4bc7-9431-5c33a1b78b95/lines/0f773e22-c8f1-4680-aa8d-17ecb41dd5cb
```


Request Body

```
{
  "earningsRateID": "1e5304e6-40c8-4dd8-9bfb-87b70de7a705"
}
```


Response Body

```
{
  "id": "41c1daf9-55e5-2204-4a50-e6f0584de1d7",
  "providerName": "!YLT5Y",
  "dateTimeUTC": "2018-03-29T00:44:34.7604134",
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
        "name": "Date",
        "reason": "Date is required"
      },
      {
        "name": "NumberOfUnits",
        "reason": "Time must be greater than zero"
      }
    ]
  },
  "timesheetLine": null
}
```


## Delete a Timesheet


`DELETE https://api.xero.com/payroll.xro/2.0/timesheets/{TimesheetID}`

Use this method to delete a timesheet

Example of DELETE a Timesheet – 200 OK Response

```
DELETE https://api.xero.com/payroll.xro/2.0/timesheets/9a649372-da99-dda0-d4ec-57fd723d010a
```


Response Body

```
{
  "id": "9a649372-da99-dda0-d4ec-57fd723d010a",
  "providerName": "!YLT5Y",
  "dateTimeUTC": null,
  "httpStatusCode": "OK",
  "pagination": null,
  "problem": null
}
```


## Delete Timesheet Line


`https://api.xero.com/payroll.xro/2.0/timesheets/{TimesheetID}/lines/{TimesheetLineID}`

Use this method to delete a timesheet line from a payroll timesheet.

### Elements for Timesheet Line

_The following is **required** to delete a timesheet line_

|  |  |
| --- | --- |
| TimesheetLineID | The Xero identifier for a Timesheet Line |

Example of deleting a Timesheet Line – 200 OK Response

```
DELETE https://api.xero.com/payroll.xro/2.0/timesheets/ef09dfbe-496b-4bc7-9431-5c33a1b78b95/lines/d2ef83a1-3295-489c-b029-7a65a73cdb50
```


Response Body

```
{
  "id": "41c1daf9-55e5-2204-4a50-e6f0584de1d7",
  "providerName": "!YLT5Y",
  "dateTimeUTC": null,
  "httpStatusCode": "OK",
  "pagination": null,
  "problem": null
}
```
