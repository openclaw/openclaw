# Leave Types

## Overview


|  |  |
| --- | --- |
| URLs | `https://api.xero.com/payroll.xro/2.0/leaveTypes`<br>`https://api.xero.com/payroll.xro/2.0/leaveTypes/{leavetypeID}` |
| Supported Methods | GET, POST |
| Description | Allows you to retrieve payroll leave types in a Xero organisation <br>Allows you to retrieve details of a leave type in a Xero organisation <br>Allows you to add a leave type in a Xero organisation |

## GET Leave Types


`GET https://api.xero.com/payroll.xro/2.0/leaveTypes`

Retrieve all leave types

### Optional Parameters

|  |  |
| --- | --- |
| Page | Page number which specifies the set of records to retrieve. <br>By default the number of the records per set is 100. <br>Example: `https://api.xero.com/payroll.xro/2.0/leavetypes?page=2` to get the second set of the records. <br>When page value is not a number or a negative number, by default, the first set of records is returned. |
| ActiveOnly | It filters leave types by active status. <br>By default the API returns all leave types. <br>Example: `https://api.xero.com/payroll.xro/2.0/leaveTypes?activeOnly=true` to get only active leave types. |

### Elements of LeaveType

|  |  |
| --- | --- |
| LeaveTypeID | Xero unique identifier for the leave type |
| Name | Name of the leave type |
| IsPaidLeave | Indicate that an employee will be paid when taking this type of leave |
| ShowOnPayslip | Indicate that a balance for this leave type to be shown on the employee’s payslips |
| UpdatedDateUTC | UTC timestamp of last update to the leave type note |
| IsStatutoryLeave | Shows whether the leave type is a statutory leave type or not |
| IsActive | Shows whether the leave type is active or not |

Example response for GET Leave Types – 200 OK Response

```
GET https://api.xero.com/payroll.xro/2.0/leaveTypes
```


```
{
   "id": "ea249b3c-e7c1-f96d-2d22-0651326ce29b",
   "providerName": "Example Provider",
   "dateTimeUTC": "2017-09-13T06:21:31.4746406",
   "httpStatusCode": "OK",
   "pagination": {
      "page": 1,
      "pageSize": 100,
      "pageCount": 1,
      "itemCount": 7
   },
   "problem": null,
   "leaveTypes": [
      {
         "leaveTypeID": "eb2d7175-7df8-4512-9c20-d35a36202828",
         "name": "Statutory Sick Leave",
         "isPaidLeave": false,
         "showOnPayslip": false,
         "updatedDateUTC": "2017-05-03T03:53:44",
         "isStatutoryLeave": true,
         "isActive": true
      },
      {
         "leaveTypeID": "94c4eb62-a7fb-4c36-b563-917bbde25b1e",
         "name": "Unpaid Maternity Leave (SML)",
         "isPaidLeave": false,
         "showOnPayslip": false,
         "updatedDateUTC": "2017-05-03T03:53:44",
         "isStatutoryLeave": true,
         "isActive": true
      },
      {
         "leaveTypeID": "c6b42463-6c83-44b9-886c-a1736c693821",
         "name": "Unpaid Adoption Leave (SAL)",
         "isPaidLeave": false,
         "showOnPayslip": false,
         "updatedDateUTC": "2017-05-03T03:53:44",
         "isStatutoryLeave": true,
         "isActive": false
      },
      {
         "leaveTypeID": "9de94459-d6b3-4ab1-aa7b-85dd0cf46935",
         "name": "Unpaid Paternity Leave (SPL)",
         "isPaidLeave": false,
         "showOnPayslip": false,
         "updatedDateUTC": "2017-05-03T03:53:44",
         "isStatutoryLeave": true,
         "isActive": true
      },
      {
         "leaveTypeID": "e1bd70b3-5fab-4caa-b9a5-3b5e173607d2",
         "name": "Unpaid Shared Parental Leave (SPL)",
         "isPaidLeave": false,
         "showOnPayslip": false,
         "updatedDateUTC": "2017-05-03T03:53:44",
         "isStatutoryLeave": true,
         "isActive": true
      },
      {
         "leaveTypeID": "dcc0ed6b-8c3e-4045-a138-7d85907ba4a4",
         "name": "Holiday",
         "isPaidLeave": true,
         "showOnPayslip": true,
         "updatedDateUTC": "2017-05-15T15:56:11",
         "isStatutoryLeave": false,
         "isActive": true
      },
      {
         "leaveTypeID": "ef1ffef9-3a9f-4685-8b3f-ae01e2a299db",
         "name": "New Test LeaveType",
         "isPaidLeave": true,
         "showOnPayslip": false,
         "updatedDateUTC": "2017-09-13T05:59:43",
         "isStatutoryLeave": false,
         "isActive": true
      }
   ]
}
```


## GET Leave Type By ID


`GET https://api.xero.com/payroll.xro/2.0/leaveTypes/{leavetypeID}`

Retrieve the details of a leave type

### Elements of LeaveType

|  |  |
| --- | --- |
| LeaveTypeID | Xero unique identifier for the leave type |
| Name | Name of the leave type |
| IsPaidLeave | Indicate that an employee will be paid when taking this type of leave |
| ShowOnPayslip | Indicate that a balance for this leave type to be shown on the employee’s payslips |
| UpdatedDateUTC | UTC timestamp of last update to the leave type note |
| IsStatutoryLeave | Shows whether the leave type is a statutory leave type or not |
| IsActive | Shows whether the leave type is active or not |

Example response for GET Leave Type by ID – 200 OK Response

```
GET https://api.xero.com/payroll.xro/2.0/GET/leaveTypes/ead3b862-8512-4e7c-b02f-6e963fd649cb
```


```
{
   "id": "ea249b3c-e7c1-f96d-2d22-0651326ce29b",
   "providerName": "Example Provider",
   "dateTimeUTC": "2017-09-13T06:23:12.7104924",
   "httpStatusCode": "OK",
   "pagination": null,
   "problem": null,
   "leaveType": {
      "leaveTypeID": "e1bd70b3-5fab-4caa-b9a5-3b5e173607d2",
      "name": "Unpaid Shared Parental Leave (SPL)",
      "isPaidLeave": false,
      "showOnPayslip": false,
      "updatedDateUTC": "2017-05-03T03:53:44",
      "isStatutoryLeave": true,
      "isActive": true
   }
}
```


## POST a Leave Type


`POST https://api.xero.com/payroll.xro/2.0/leavetypes`

Add a leave type

### Elements of LeaveType in the Request

_The following elements are **required** to add a new leave type_

|  |  |
| --- | --- |
| Name | Name of the leave type (max length = 50) |
| IsPaidLeave | Set this to indicate that an employee will be paid when taking this type of leave (true or false) |
| ShowOnPayslip | Set this if you want a balance for this leave type to be shown on your employee’s payslips (true or false) |

Example for POST a Leave Type with minimum elements required – 200 OK Response

```
POST https://api.xero.com/payroll.xro/2.0/leaveTypes
```


Request Body

```
{
   "name": "New Test LeaveType",
   "isPaidLeave": true,
   "showOnPayslip": false
}
```


Response Body

```
{
   "id": "ea249b3c-e7c1-f96d-2d22-0651326ce29b",
   "providerName": "Example Provider",
   "dateTimeUTC": "2017-09-13T06:25:25.581367",
   "httpStatusCode": "OK",
   "pagination": null,
   "problem": null,
   "leaveType": {
      "leaveTypeID": "4db03427-83fe-41d6-8414-bc4d33e56c57",
      "name": "New Test LeaveType",
      "isPaidLeave": true,
      "showOnPayslip": false,
      "updatedDateUTC": "2017-09-13T06:25:25.5543662",
      "isStatutoryLeave": false,
      "isActive": true
   }
}
```


Example for POST a Leave Type – 400 Bad Request Response

```
POST https://api.xero.com/payroll.xro/2.0/leaveTypes
```


Request Body

```
{
   "name": "New Test LeaveType name with extra characters which makes it more than 50 characters"
}
```


Response Body

```
{
   "type": "application/problem+json",
   "title": "BadRequest",
   "status": 400,
   "detail": "Validation error occurred.",
   "instance": null,
   "invalidFields": [
      {
         "name": "Name",
         "reason": "The Time Off Name must not be longer than 50 characters"
      },
      {
         "name": "PaidLeave",
         "reason": "The Time Off Category is required"
      },
      {
         "name": "ShowBalanceOnPayslip",
         "reason": "The Show Balance is required"
      }
   ]
}
```
