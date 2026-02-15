# Leave

## Overview


|  |  |
| --- | --- |
| URL | `https://api.xero.com/payroll.xro/2.0/employees/{EmployeeID}/leave`<br>`https://api.xero.com/payroll.xro/2.0/employees/{EmployeeID}/leave/{LeaveID}` |
| Methods Supported | GET, POST, PUT, DELETE |
| Description | Allows you to retrieve all the leaves in Payroll for an employee in a Xero organisation. <br>Allows you to retrieve and add a leave in Payroll for an employee in a Xero organisation. <br>This is closely related to LeavePeriods and LeaveTypes. LeaveTypes identify what type of leave is being applied for while LeavePeriods identify the which pay periods are affected by the Leave application. <br>Allows you to update leave in Payroll for an employee in a Xero organisation. Allows you to delete leave in Payroll for an employee in a Xero organisation. |
| Limitations | Leave is not supported for off-payroll workers |

## GET All Leave


`GET https://api.xero.com/payroll.xro/2.0/employees/{EmployeeID}/leave`

Retrieves all the leave for an active employee

### Elements for a Leave

|  |  |
| --- | --- |
| LeaveID | The Xero identifier for the leave |
| LeaveTypeID | The Xero identifier for the leaveTypeID |
| Description | The description of the leave |
| StartDate | Start date of the leave (YYYY-MM-DD) |
| EndDate | End date of the leave (YYYY-MM-DD) |
| Periods | The leave period information |
| UpdatedDateUTC | The date the leave was last updated (YYYY-MM-DD) |

### Elements for a Period

|  |  |
| --- | --- |
| PeriodStartDate | The Pay Period Start Date (YYYY-MM-DD) |
| PeriodEndDate | The Pay Period End Date (YYYY-MM-DD) |
| NumberOfUnits | The Number of Units for the leave |
| PeriodStatus | See PeriodStatus codes |

Example response for GET All Employee leave – 200 OK Response

```
GET https://api.xero.com/payroll.xro/2.0/employees/35cdd697-c9fc-4931-b579-a18cb8b6fe14/leave
```


```
{
  "id": "c4be24e5-e840-4c92-9eaa-2d86cd596314",
  "providerName": "!YLT5Y",
  "dateTimeUTC": "2017-09-06T05:16:25.5262207",
  "httpStatusCode": "OK",
  "pagination": null,
  "problem": null,
  "leave": [
    {
      "leaveID": "20788ab2-b2ed-4c4d-bccf-0a6a835ddbb0",
      "leaveTypeID": "2d8fc263-9620-47a4-b071-15d67c45a0ce",
      "description": "Holiday to Palawan",
      "startDate": "2017-06-08T00:00:00",
      "endDate": "2017-06-12T00:00:00",
      "periods": [
        {
          "periodStartDate": "2017-06-08T00:00:00",
          "periodEndDate": "2017-06-14T00:00:00",
          "numberOfUnits": 40,
          "periodStatus": "Completed"
        }
      ],
      "updatedDateUTC": "2017-08-30T04:53:47"
    },
    {
      "leaveID": "25674a22-d9e3-41ed-943a-df1d98ea5991",
      "leaveTypeID": "2d8fc263-9620-47a4-b071-15d67c45a0ce",
      "description": "Holiday to Japan",
      "startDate": "2017-08-05T00:00:00",
      "endDate": "2017-08-16T00:00:00",
      "periods": [
        {
          "periodStartDate": "2017-08-03T00:00:00",
          "periodEndDate": "2017-08-09T00:00:00",
          "numberOfUnits": 24,
          "periodStatus": "Approved"
        },
        {
          "periodStartDate": "2017-08-10T00:00:00",
          "periodEndDate": "2017-08-16T00:00:00",
          "numberOfUnits": 40,
          "periodStatus": "Approved"
        }
      ],
      "updatedDateUTC": "2017-08-30T04:38:08"
    }
  ]
}
```


Example response for GET All Employee Leave – 404 Not Found Response

```
GET https://api.xero.com/payroll.xro/2.0/employees/35cdd697-c9fc-4931-b579-a18cb8b6fe15/leave
```


```
{
  "id": "c4be24e5-e840-4c92-9eaa-2d86cd596314",
  "providerName": "!YLT5Y",
  "dateTimeUTC": "2017-09-15T03:51:43.3204368",
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
  "leave": null
}
```


## GET Leave


`GET https://api.xero.com/payroll.xro/2.0/employees/{EmployeeID}/leave/{LeaveID}`

Retrieves a specific leave for an active employee

### Elements for a Leave

|  |  |
| --- | --- |
| LeaveID | The Xero identifier for the leave. |
| LeaveTypeID | The Xero identifier for the leaveTypeID |
| Description | The description of the leave. |
| StartDate | Start date of the leave (YYYY-MM-DD). |
| EndDate | End date of the leave (YYYY-MM-DD). |
| Periods | The leave period information. See LeavePeriods |
| UpdatedDateUTC | The date the leave was last updated (YYYY-MM-DD). |

Example response for GET Employee Leave – 200 OK Response

```
GET https://api.xero.com/payroll.xro/2.0/employees/35cdd697-c9fc-4931-b579-a18cb8b6fe14/leave/20788ab2-b2ed-4c4d-bccf-0a6a835ddbb0
```


```
{
  "id": "c4be24e5-e840-4c92-9eaa-2d86cd596314",
  "providerName": "!YLT5Y",
  "dateTimeUTC": "2017-09-06T05:16:25.5262207",
  "httpStatusCode": "OK",
  "pagination": null,
  "problem": null,
  "leave": {
    "leaveID": "20788ab2-b2ed-4c4d-bccf-0a6a835ddbb0",
    "leaveTypeID": "2d8fc263-9620-47a4-b071-15d67c45a0ce",
    "description": "Holiday to Palawan",
    "startDate": "2017-06-08T00:00:00",
    "endDate": "2017-06-12T00:00:00",
    "periods": [
      {
        "periodStartDate": "2017-06-08T00:00:00",
        "periodEndDate": "2017-06-14T00:00:00",
        "numberOfUnits": 40,
        "periodStatus": "Completed"
      }
    ],
      "updatedDateUTC": "2017-08-30T04:53:47"
  }
}
```


Example response for GET Employee Leave – 404 Not Found Response

```
GET https://api.xero.com/payroll.xro/2.0/employees/35cdd697-c9fc-4931-b579-a18cb8b6fe14/leave/20788ab2-b2ed-4c4d-bccf-0a6a835ddbb1
```


```
{
  "id": "c4be24e5-e840-4c92-9eaa-2d86cd596314",
  "providerName": "!YLT5Y",
  "dateTimeUTC": "2017-09-15T04:10:52.3860223",
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
  "leave": null
}
```


## POST Leave


POST [https://api.xero.com/payroll.xro/2.0/employees/{EmployeeID}/leave/](https://api.xero.com/payroll.xro/2.0/employees/%7BEmployeeID%7D/leave/)

Adds a leave for an active employee. Leave is not supported for off-payroll workers. Only one employee leave application can be processed in each request and the NumberOfUnits is calculated automatically by default. If you want to specify the NumberOfUnits, you can do so by providing Periods.

### Elements for Posting a leave

_The following are **required** to create a new leave application_

|  |  |
| --- | --- |
| LeaveTypeID | The Xero identifier for LeaveType |
| Description | The description of the leave  (max length = 50) |
| StartDate | Start date of the leave (YYYY-MM-DD) |
| EndDate | End date of the leave (YYYY-MM-DD) |

_The following are **optional** elements when creating a new leave application_

|  |  |
| --- | --- |
| LeavePeriods | The leave period information. See LeavePeriods The StartDate, EndDate and NumberOfUnits needs to be specified when you do not want to calculate NumberOfUnits automatically. Using incorrect period StartDate and EndDate will result in automatic computation of the NumberOfUnits. |

Example for POST a Leave – 200 OK Response

This uses minimum required elements to add a new leave application and automatically calculates the number of units for the leave application. You can also add your own number of units.

```
POST https://api.xero.com/payroll.xro/2.0/employees/35cdd697-c9fc-4931-b579-a18cb8b6fe14/leave
```


Request Body

```
{
  "leaveTypeID": "2d8fc263-9620-47a4-b071-15d67c45a0ce",
  "description": "Vacation to Rome",
  "startDate": "2017-06-11T00:00:00",
  "endDate": "2017-06-12T00:00:00"
}
```


Response Body

```
{
  "id": "c4be24e5-e840-4c92-9eaa-2d86cd596314",
  "providerName": "!YLT5Y",
  "dateTimeUTC": "2017-09-07T00:26:55.8543612",
  "httpStatusCode": "OK",
  "pagination": null,
  "problem": null,
  "leave": {
    "leaveID": "2a1d2310-fbd2-4368-956a-1d522db54592",
    "leaveTypeID": "2d8fc263-9620-47a4-b071-15d67c45a0ce",
    "description": "Vacation to Rome",
    "startDate": "2017-06-11T00:00:00",
    "endDate": "2017-06-12T00:00:00",
    "periods": [
      {
        "periodStartDate": "2017-06-08T00:00:00",
        "periodEndDate": "2017-06-14T00:00:00",
        "numberOfUnits": 8,
        "periodStatus": "Approved"
      }
    ],
    "updatedDateUTC": "2017-09-07T00:26:55.8483693"
  }
}
```


Example for POST a Leave – 400 Bad Request

```
POST https://api.xero.com/payroll.xro/2.0/employees/35cdd697-c9fc-4931-b579-a18cb8b6fe14/leave
```


Request Body

```
{
  "leaveTypeID": "2d8fc263-9620-47a4-b071-15d67c45a0ce",
  "description": "Vacation to Rome",
  "startDate": "2017-06-11T00:00:00"
}
```


Response Body

```
{
  "id": "c4be24e5-e840-4c92-9eaa-2d86cd596314",
  "providerName": "!YLT5Y",
  "dateTimeUTC": "2017-09-15T04:02:57.8561812",
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
        "name": "EndDate",
        "reason": "The end date is required"
      }
    ]
  },
  "leave": null
}
```


Example for POST a Leave for an off-payroll worker – 400 Bad Request

```
POST https://api.xero.com/payroll.xro/2.0/employees/35483108-dbe5-48de-b0f5-ef3cd52e48de/leave
```


Request Body

```
{
  "leaveTypeID": "2d8fc263-9620-47a4-b071-15d67c45a0ce",
  "description": "Vacation to Rome",
  "startDate": "2017-06-11T00:00:00"
}
```


Response Body

```
{
  "id": "35483108-dbe5-48de-b0f5-ef3cd52e48de",
  "providerName": "xero/api",
  "dateTimeUTC": "2021-03-12T03:54:30.4324715",
  "httpStatusCode": "BadRequest",
  "pagination": null,
  "problem": {
      "type": "application/problem+json",
      "title": "BadRequest",
      "status": 400,
      "detail": "Need to complete the Employment information for this employee before configuring and requesting leave",
      "instance": null,
      "invalidFields": null,
      "invalidObjects": null
  },
  "leave": null
}
```


Example for POST a Leave with EmployeeID not existing – 404 Not Found

```
POST https://api.xero.com/payroll.xro/2.0/employees/35cdd697-c9fc-4931-b579-a18cb8b6fe15/leave
```


Request Body

```
{
  "leaveTypeID": "2d8fc263-9620-47a4-b071-15d67c45a0ce",
  "description": "Vacation to Rome",
  "startDate": "2017-06-11T00:00:00",
  "endDate": "2017-06-12T00:00:00"
}
```


Response Body

```
{
  "id": "c4be24e5-e840-4c92-9eaa-2d86cd596314",
  "providerName": "!YLT5Y",
  "dateTimeUTC": "2017-09-17T23:41:27.7283197",
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
  "leave": null
}
```


#### Example of specifying the number of units for a leave application

```
POST https://api.xero.com/payroll.xro/2.0/employees/35cdd697-c9fc-4931-b579-a18cb8b6fe14/leave
```


Request Body

```
{
  "leaveTypeID": "2d8fc263-9620-47a4-b071-15d67c45a0ce",
  "description": "A test leave with Units with correct pay periods",
  "startDate": "2017-06-11T00:00:00",
  "endDate": "2017-06-12T00:00:00",
  "periods": [
    {
      "periodStartDate": "2017-06-05T00:00:00",
      "periodEndDate": "2017-06-14T00:00:00",
      "numberOfUnits": 100
    }
  ]
}
```


Response Body

```
{
  "id": "c4be24e5-e840-4c92-9eaa-2d86cd596314",
  "providerName": "!YLT5Y",
  "dateTimeUTC": "2017-09-07T00:22:43.8346206",
  "httpStatusCode": "OK",
  "pagination": null,
  "problem": null,
  "leave": {
    "leaveID": "14646273-a52c-47e7-aa5d-182577c8de84",
    "leaveTypeID": "2d8fc263-9620-47a4-b071-15d67c45a0ce",
    "description": "A test leave with Units with correct pay periods",
    "startDate": "2017-06-11T00:00:00",
    "endDate": "2017-06-12T00:00:00",
    "periods": [
      {
        "periodStartDate": "2017-06-08T00:00:00",
        "periodEndDate": "2017-06-14T00:00:00",
        "numberOfUnits": 100,
        "periodStatus": "Approved"
      }
    ],
    "updatedDateUTC": "2017-09-07T00:22:43.8286044"
  }
}
```


**NOTE:** In the example below incorrect pay period dates were provided, resulting in automatic computation of the periods.

Example of specifying the number of units for a leave application with incorrect periods

```
POST https://api.xero.com/payroll.xro/2.0/employees/35cdd697-c9fc-4931-b579-a18cb8b6fe14/leave
```


Request Body

```
{
  "leaveTypeID": "2d8fc263-9620-47a4-b071-15d67c45a0ce",
  "description": "A test leave with Units with incorrect pay periods",
  "startDate": "2017-06-11T00:00:00",
	"endDate": "2017-06-12T00:00:00",
	"periods": [
    {
      "periodStartDate": "2017-06-05T00:00:00",
      "periodEndDate": "2017-06-14T00:00:00",
      "numberOfUnits": 100
    }
  ]
}
```


Response Body

```
{
  "id": "c4be24e5-e840-4c92-9eaa-2d86cd596314",
  "providerName": "!YLT5Y",
  "dateTimeUTC": "2017-09-07T00:19:50.1131882",
  "httpStatusCode": "OK",
  "pagination": null,
  "problem": null,
  "leave": {
    "leaveID": "7b8d5a6c-d28b-4b19-8ee0-d8dbcc15dd4c",
    "leaveTypeID": "2d8fc263-9620-47a4-b071-15d67c45a0ce",
    "description": "A test leave with Units with incorrect pay periods",
    "startDate": "2017-06-11T00:00:00",
    "endDate": "2017-06-12T00:00:00",
    "periods": [
      {
        "periodStartDate": "2017-06-08T00:00:00",
        "periodEndDate": "2017-06-14T00:00:00",
        "numberOfUnits": 8,
        "periodStatus": "Approved"
      }
    ],
    "updatedDateUTC": "2017-09-07T00:19:49.7231751"
  }
}
```


## PUT Leave


PUT [https://api.xero.com/payroll.xro/2.0/employees/{EmployeeID}/leave/{LeaveID}](https://api.xero.com/payroll.xro/2.0/employees/%7BEmployeeID%7D/leave/%7BLeaveID%7D)

Update a leave for an active employee. Only one employee leave application can be processed in each request. Periods.

### Elements for Updating a leave

_The following are **required** to update a leave application_

|  |  |
| --- | --- |
| LeaveTypeID | The Xero identifier for LeaveType |
| Description | The description of the leave  (max length = 50) |
| StartDate | Start date of the leave (YYYY-MM-DD) |
| EndDate | End date of the leave (YYYY-MM-DD) |
| LeavePeriods | The leave period information. See LeavePeriods The StartDate, EndDate and NumberOfUnits needs to be specified. The StartDate, EndDate can not be updated, using incorrect period StartDate and EndDate will result a Bad Request. |

Example for PUT a Leave – 200 OK Response

```
PUT https://api.xero.com/payroll.xro/2.0/employees/35cdd697-c9fc-4931-b579-a18cb8b6fe14/leave/4ba08537-9ec2-4706-a4b2-6a42db5c9995
```


Request Body

```
{
  "leaveTypeID": "f847fe03-d9e8-4eea-a1ea-c3877137388e",
  "description": "Update Leave",
  "startDate": "2017-12-05",
  "endDate": "2017-12-25",
  "periods": [
    {
        "periodStartDate": "2017-12-01",
        "periodEndDate": "2017-12-31T00:00:00",
        "numberOfUnits": 2,
        "periodStatus": "Approved"
    }
  ]
}
```


Response Body

```
{
  "id": "68764920-a61f-cde9-89f2-e1134e8fe254",
  "providerName": "Example Provider",
  "dateTimeUTC": "2018-07-20T04:27:14.6380496",
  "httpStatusCode": "OK",
  "pagination": null,
  "problem": null,
  "leave": {
    "leaveID": "4ba08537-9ec2-4706-a4b2-6a42db5c9995",
    "leaveTypeID": "f847fe03-d9e8-4eea-a1ea-c3877137388e",
    "description": "Update Leave",
    "startDate": "2017-12-05T00:00:00",
    "endDate": "2017-12-25T00:00:00",
    "periods": [
      {
          "periodStartDate": "2017-12-01T00:00:00",
          "periodEndDate": "2017-12-31T00:00:00",
          "numberOfUnits": 2,
          "periodStatus": "Approved"
      }
    ],
    "updatedDateUTC": "2018-07-20T04:27:14.5878664"
  }
}
```


Example for PUT a Leave – 400 Bad Request

```
PUT https://api.xero.com/payroll.xro/2.0/employees/35cdd697-c9fc-4931-b579-a18cb8b6fe14/leave/4ba08537-9ec2-4706-a4b2-6a42db5c9995
```


Request Body

```
{
  "leaveTypeID": "{{leaveTypeIDForPut}}",
  "description": "Update Leave",
  "startDate": "2017-12-05"
}
```


Response Body

```
{
  "id": "68764920-a61f-cde9-89f2-e1134e8fe254",
  "providerName": "Example Provider",
  "dateTimeUTC": "2018-07-20T04:28:57.4197036",
  "httpStatusCode": "BadRequest",
  "pagination": null,
  "problem": {
    "type": "application/problem+json",
    "title": "BadRequest",
    "status": 400,
    "detail": "Could not update the leave request. LeavePeriod is required",
    "instance": null,
    "invalidFields": null
  },
  "leave": null
}
```


Example for PUT a Leave with EmployeeID not existing – 404 Not Found

```
PUT https://api.xero.com/payroll.xro/2.0/employees/35cdd697-c9fc-4931-b579-a18cb8b6fe15/leave/4ba08537-9ec2-4706-a4b2-6a42db5c9995
```


Request Body

```
{
  "leaveTypeID": "f847fe03-d9e8-4eea-a1ea-c3877137388e",
  "description": "Update Leave",
  "startDate": "2017-12-05",
  "endDate": "2017-12-25",
  "periods": [
    {
      "periodStartDate": "2017-12-01",
      "periodEndDate": "2017-12-31T00:00:00",
      "numberOfUnits": 2,
      "periodStatus": "Approved"
    }
  ]
}
```


Response Body

```
{
  "id": "68764920-a61f-cde9-89f2-e1134e8fe254",
  "providerName": "Example Provider",
  "dateTimeUTC": "2018-07-20T04:29:57.4422396",
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
  "leave": null
}
```


## Delete an employee leave request


`DELETE https://api.xero.com/payroll.xro/2.0/employees/{EmployeeID}/leave/{LeaveID}`

Use this method to delete an employee leave request

Example of DELETE an Employee leave request – 200 OK Response

```
DELETE https://api.xero.com/payroll.xro/2.0/employees/35cdd697-c9fc-4931-b579-a18cb8b6fe15/leave/4ba08537-9ec2-4706-a4b2-6a42db5c9995
```


Request Body

```
  Response Body{
  "id": "4ba08537-9ec2-4706-a4b2-6a42db5c9995",
  "providerName": "!YLT5Y",
  "dateTimeUTC": null,
  "httpStatusCode": "OK",
  "pagination": null,
  "problem": null
}
```
