# Pay Run Calendars

## Overview


|  |  |
| --- | --- |
| URLs | `https://api.xero.com/payroll.xro/2.0/payRunCalendars`<br>`https://api.xero.com/payroll.xro/2.0/payRunCalendars/{payruncalendarID}` |
| Supported Method | GET, POST |
| Description | Allows you to retrieve and add pay run calendars in a Xero organisation <br>Allows you to retrieve details of a pay run calendar in a Xero organisation |

## GET Pay Run Calendars


`GET https://api.xero.com/payroll.xro/2.0/payRunCalendars`

Retrieves a list of pay run calendars

### Optional Parameters

|  |  |
| --- | --- |
| Page | Page number which specifies the set of records to retrieve. <br>By default the number of the records per set is 100. <br>Example: `https://api.xero.com/payroll.xro/2.0/payRunCalendars?page=2` to get the second set of the records. <br>When page value is not a number or a negative number, by default, the first set of records is returned. |

### Elements for PayRunCalendar

|  |  |
| --- | --- |
| PayRunCalendarID | Xero unique identifier for the pay run calendar |
| Name | Name of the calendar |
| CalendarType | Type of the calendar. See Pay Run Calendar types |
| PeriodStartDate | Period start date of the calendar |
| PeriodEndDate | Period end date of the calendar |
| PaymentDate | Payment date of the calendar |
| UpdatedDateUTC | UTC timestamp of the last update to the pay run calendar |

Example response for GET Pay Run Calendars – 200 OK Response

```
GET https://api.xero.com/payroll.xro/2.0/payRunCalendars?page=1
```


```
{
 "id": "356aacc7-ce54-5501-b1a7-ffcb017e07ca",
 "providerName": "Example Provider",
 "dateTimeUTC": "2017-09-17T23:23:26.0249087",
 "httpStatusCode": "OK",
 "pagination": {
    "page": 1,
    "pageSize": 100,
    "pageCount": 1,
    "itemCount": 2
 },
 "problem": null,
 "payRunCalendars": [
  {
    "payRollCalendarID": "b70ce0c1-c469-4ba6-b2b2-0ca7d24926fb",
    "name": "Weekly Calendar",
    "calendarType": "Weekly",
    "periodStartDate": "2017-05-12T00:00:00",
    "periodEndDate": "2017-05-18T00:00:00",
    "paymentDate": "2017-05-19T00:00:00",
    "updatedDateUTC": "2017-05-15T16:53:54"
  },
  {
    "payRollCalendarID": "14e7afa7-7d4b-4a89-8ec0-db4664edd9fd",
    "name": "Fortnightly Calendar",
    "calendarType": "Fortnightly",
    "periodStartDate": "2017-06-02T00:00:00",
    "periodEndDate": "2017-06-15T00:00:00",
    "paymentDate": "2017-06-09T00:00:00",
    "updatedDateUTC": "2017-07-06T00:18:49"
  }
 ]
}
```


Example response for GET Pay Run Calendars – 404 Not Found Response

```
GET https://api.xero.com/payroll.xro/2.0/payRunCalendars?page=100
```


```
{
  "id": "356aacc7-ce54-5501-b1a7-ffcb017e07ca",
  "providerName": "Example Provider",
  "dateTimeUTC": "2018-03-01T12:42:12.1186367",
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
    "payRunCalendar": null
}
```


## GET Pay Run Calendar By ID


`GET https://api.xero.com/payroll.xro/2.0/payRunCalendars/{payruncalendarID}`

Retrieves detailed information for a pay run calendar by its unique identifier

### Elements for PayRunCalendar

See PayRunCalendar.

Example for GET a Pay Run Calendar by ID – 200 OK Response

```
GET https://api.xero.com/payroll.xro/2.0/payRunCalendars/b70ce0c1-c469-4ba6-b2b2-0ca7d24926fb
```


```
{
 "id": "356aacc7-ce54-5501-b1a7-ffcb017e07ca",
 "providerName": "Example Provider",
 "dateTimeUTC": "2017-09-17T23:55:29.7202104",
 "httpStatusCode": "OK",
 "pagination": null,
 "problem": null,
 "payRunCalendar": {
    "payRollCalendarID": "b70ce0c1-c469-4ba6-b2b2-0ca7d24926fb",
    "name": "Weekly Calendar",
    "calendarType": "Weekly",
    "periodStartDate": "2017-05-12T00:00:00",
    "periodEndDate": "2017-05-18T00:00:00",
    "paymentDate": "2017-05-19T00:00:00",
    "updatedDateUTC": "2017-05-15T16:53:54"
 }
}
```


Example for GET a Pay Run Calendar by ID – 404 Not Found Response

```
GET https://api.xero.com/payroll.xro/2.0/payRunCalendars/b70ce0c1-c469-4ba6-b2b2-0ca7d24926fc
```


```
{
 "id": "356aacc7-ce54-5501-b1a7-ffcb017e07ca",
 "providerName": "Example Provider",
 "dateTimeUTC": "2017-09-18T00:13:08.8503678",
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
 "payRunCalendar": null
}
```


## POST Pay Run Calendar


`POST https://api.xero.com/payroll.xro/2.0/payRunCalendars`

Adds a pay run calendar

### Elements for Posting a PayRunCalendar

|  |  |
| --- | --- |
| Name | Name of the calendar |
| CalendarType | Type of the calendar. See Pay Run Calendar types |
| PeriodStartDate | Period start date of the calendar |
| PaymentDate | Payment date of the calendar |

Example response for POST Pay Run Calendars – 200 OK Response

```
GET https://api.xero.com/payroll.xro/2.0/payRunCalendars
```


Request Body

```
{
  "name": "Weekly",
  "calendarType": "Weekly",
  "periodStartDate": "2017-03-06T00:00:00",
  "paymentDate": "2017-03-14T00:00:00",
}
```


Response Body

```
{
"id": "712286a1-30bd-fe5a-72d6-d0fbf7035b7a",
"providerName": "Example Provider",
"dateTimeUTC": "2018-03-01T12:16:26.9611971",
"httpStatusCode": "OK",
"pagination": null,
"problem": null,
"payRunCalendar": {
    "payRollCalendarID": "6309098d-ec3e-4634-902a-90d686590d40",
    "name": "Weekly",
    "calendarType": "Weekly",
    "periodStartDate": "2017-03-06T00:00:00",
    "periodEndDate": "2017-03-12T00:00:00",
    "paymentDate": "2017-03-14T00:00:00",
    "updatedDateUTC": "2018-03-01T12:16:26.8141653"
  }
}
```


Example for POST a Pay Run Calendar – 400 Bad Request

```
POST https://api.xero.com/payroll.xro/2.0/payRunCalendars
```


Request Body

```
{
  "name": "Weekly",
  "periodStartDate": "2017-03-06T00:00:00"
}
```


Response Body

```
{
  "id": "712286a1-30bd-fe5a-72d6-d0fbf7035b7a",
  "providerName": "Example Provider",
  "dateTimeUTC": "2018-03-01T12:20:08.8741433",
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
        "name": "CalendarType",
        "reason": "The calendar type is required"
      },
      {
        "name": "paymentDate",
        "reason": "The First Payment Date is required."
      }
    ]
  },
  "payRunCalendar": null
}
```
