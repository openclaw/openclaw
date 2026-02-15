# Pay Runs

## Overview


|  |  |
| --- | --- |
| URLs | `https://api.xero.com/payroll.xro/2.0/payRuns`<br>`https://api.xero.com/payroll.xro/2.0/payRuns/{payrunID}` |
| Supported Methods | GET |
| Description | Allows you to retrieve pay runs in a Xero organisation <br>Allows you to retrieve details of a pay run in a Xero organisation |

## GET PayRuns


`GET https://api.xero.com/payroll.xro/2.0/payRuns`

Retrieves a list of pay runs

### Optional Parameters

|  |  |
| --- | --- |
| Page | Page number which specifies the set of records to retrieve. <br>By default the number of the records per set is 100. <br>Example: `https://api.xero.com/payroll.xro/2.0/payRuns?page=2` to get the second set of the records. <br>When page value is not a number or a negative number, by default, the first set of records is returned. |
| Status | By default get payruns will return all the payruns for an organization. <br>You can add `GET https://api.xero.com/payroll.xro/2.0/payRuns?status={PayRunStatus}` PayRunStatus to filter the payruns by status. <br>Example: `GET https://api.xero.com/payroll.xro/2.0/payRuns?status=Posted` to get the payruns in Posted status. |

### Elements for PayRun

|  |  |
| --- | --- |
| PayRunID | Xero unique identifier for the pay run |
| PayrollCalendarID | Xero unique identifier for the payroll calendar |
| PeriodStartDate | Period start date of the payroll calendar |
| PeriodEndDate | Period end date of the payroll calendar |
| PaymentDate | Payment date of the pay run |
| TotalCost | Total cost of the pay run |
| TotalPay | Total pay of the pay run |
| PayRunStatus | Pay run status. See PayRunStatus |
| PayRunType | Pay run type. See PayRunType |
| CalendarType | Calendar type of the pay run. See CalendarType |
| PostedDateTime | Posted date time of the pay run |

Example response for GET PayRuns – 200 OK Response

```
GET https://api.xero.com/payroll.xro/2.0/payRuns
```


```
{
   "id": "43f8d9aa-9e5f-0a0e-1b30-aa5e5ee0888a",
   "providerName": "Example Provider",
   "dateTimeUTC": "2017-09-18T04:03:00.7820937",
   "httpStatusCode": "OK",
   "pagination": {
      "page": 1,
      "pageSize": 100,
      "pageCount": 1,
      "itemCount": 6
   },
   "problem": null,
   "payRuns": [
      {
         "payRunID": "e1e889e4-d574-4224-b4e7-d962346ae3a1",
         "payrollCalendarID": "26b073f2-b77f-4c5b-8938-88bc3c364a7b",
         "periodStartDate": "2017-05-05T00:00:00",
         "periodEndDate": "2017-05-11T00:00:00",
         "paymentDate": "2017-05-12T00:00:00",
         "totalCost": 547.07,
         "totalPay": 266.72,
         "payRunStatus": "Draft",
         "payRunType": "Scheduled",
         "calendarType": "Weekly",
         "postedDateTime": null
      },
      {
         "payRunID": "e79657cf-16db-417b-ac01-1bd7942d6fea",
         "payrollCalendarID": "37791711-1a0f-487b-bac4-d4a4dfd2da75",
         "periodStartDate": "2017-05-05T00:00:00",
         "periodEndDate": "2017-05-18T00:00:00",
         "paymentDate": "2017-05-12T00:00:00",
         "totalCost": 5825.37,
         "totalPay": 4105.55,
         "payRunStatus": "Posted",
         "payRunType": "Scheduled",
         "calendarType": "Fortnightly",
         "postedDateTime": "2017-06-27T07:28:20"
      },
      {
         "payRunID": "43aec017-c157-4838-8ae5-9a6021b3d640",
         "payrollCalendarID": "37791711-1a0f-487b-bac4-d4a4dfd2da75",
         "periodStartDate": "2017-05-19T00:00:00",
         "periodEndDate": "2017-06-01T00:00:00",
         "paymentDate": "2017-05-26T00:00:00",
         "totalCost": 3182.43,
         "totalPay": 2134.9,
         "payRunStatus": "Draft",
         "payRunType": "Scheduled",
         "calendarType": "Fortnightly",
         "postedDateTime": null
      },
      {
         "payRunID": "c75ab4a2-0dd8-45be-888b-ec8d31f4829b",
         "payrollCalendarID": "fe09bd41-02ed-4188-a363-8fa5bbf7335d",
         "periodStartDate": "2017-05-05T00:00:00",
         "periodEndDate": "2017-06-04T00:00:00",
         "paymentDate": "2017-05-30T00:00:00",
         "totalCost": 2024.97,
         "totalPay": 841.74,
         "payRunStatus": "Posted",
         "payRunType": "Scheduled",
         "calendarType": "Monthly",
         "postedDateTime": "2017-06-27T04:45:12"
      },
      {
         "payRunID": "f99cdaf1-cb05-476e-ad6a-cab7b9146b58",
         "payrollCalendarID": "756e3d88-7fcf-4fb8-927f-a40af53b4261",
         "periodStartDate": "2017-04-01T00:00:00",
         "periodEndDate": "2017-04-07T00:00:00",
         "paymentDate": "2017-06-02T00:00:00",
         "totalCost": 0,
         "totalPay": 0,
         "payRunStatus": "Posted",
         "payRunType": "Scheduled",
         "calendarType": "Weekly",
         "postedDateTime": "2017-06-27T07:39:24"
      },
      {
         "payRunID": "0cc1e4c6-97f3-408f-bf04-f2b476ab8c9d",
         "payrollCalendarID": "c0cc6c1a-7fcd-4fe4-9788-cce24e0446f3",
         "periodStartDate": "2017-05-01T00:00:00",
         "periodEndDate": "2017-05-07T00:00:00",
         "paymentDate": "2017-06-05T00:00:00",
         "totalCost": 3038.72,
         "totalPay": 2270.73,
         "payRunStatus": "Posted",
         "payRunType": "Scheduled",
         "calendarType": "Weekly",
         "postedDateTime": "2017-06-29T00:15:01"
      }
   ]
}
```


## GET PayRun By ID


`GET https://api.xero.com/payroll.xro/2.0/payRuns/{payrunID}`

Retrieves detailed information for a pay run by its unique identifier

### Elements for PayRun

|  |  |
| --- | --- |
| PayRunID | Xero unique identifier for the pay run |
| PayrollCalendarID | Xero unique identifier for the payroll calendar |
| PeriodStartDate | Period start date of the payroll calendar |
| PeriodEndDate | Period end date of the payroll calendar |
| PaymentDate | Payment date of the pay run |
| TotalCost | Total cost of the pay run |
| TotalPay | Total pay of the pay run |
| PayRunStatus | Pay run status. See Pay Run codes |
| PayRunType | Pay run type. See Pay Run types |
| CalendarType | Calendar type of the pay run. See Pay Run Calendar types |
| PostedDateTime | Posted date time of the pay run |
| PaySlips | A list of pay slips associated with the pay run. See Pay Slip |

Example response for GET PayRun by ID – 200 OK Response

```
GET https://api.xero.com/payroll.xro/2.0/payRuns/e1e889e4-d574-4224-b4e7-d962346ae3a1
```


```
{
   "id": "43f8d9aa-9e5f-0a0e-1b30-aa5e5ee0888a",
   "providerName": "Example Provider",
   "dateTimeUTC": "2017-09-18T04:06:27.6899692",
   "httpStatusCode": "OK",
   "pagination": null,
   "problem": null,
   "payRun": {
      "payRunID": "e1e889e4-d574-4224-b4e7-d962346ae3a1",
      "payrollCalendarID": "26b073f2-b77f-4c5b-8938-88bc3c364a7b",
      "periodStartDate": "2017-05-05T00:00:00",
      "periodEndDate": "2017-05-11T00:00:00",
      "paymentDate": "2017-05-12T00:00:00",
      "totalCost": 547.07,
      "totalPay": 266.72,
      "payRunStatus": "Draft",
      "payRunType": "Scheduled",
      "calendarType": "Weekly",
      "postedDateTime": null,
      "paySlips": [
         {
            "paySlipID": "382d1755-cbfe-4e5a-a5a9-27b9015d00c5",
            "employeeID": "641aa9ab-aef5-4e7f-8833-540cc64dbf75",
            "lastEdited": "2017-06-22T02:14:00",
            "firstName": "Jack",
            "lastName": "Allan",
            "totalEarnings": 480.77,
            "grossEarnings": 455.77,
            "totalPay": 278.72,
            "totalEmployerTaxes": 44.68,
            "totalEmployeeTaxes": 89.05,
            "totalDeductions": 25,
            "totalReimbursements": 12,
            "totalCourtOrders": 100,
            "totalBenefits": 9.62,
            "bacsHash": null,
            "paymentMethod": "Electronically"
         }
      ]
   }
}
```


Example response for GET PayRun by ID – 404 Not Found Response

```
GET https://api.xero.com/payroll.xro/2.0/payRuns/e1e889e4-d574-4224-b4e7-d962346ae3a3
```


```
{
   "id": "43f8d9aa-9e5f-0a0e-1b30-aa5e5ee0888a",
   "providerName": "Example Provider",
   "dateTimeUTC": "2017-09-18T04:18:28.4800504",
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
   "payRun": null
}
```
