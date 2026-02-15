# Release Notes

## Version 1.16


Date: 26 August 2024

**New features and improvements**

UK Payroll is now supporting custom leave year for leave accrual with a new property **ScheduleOfAccrualDate**. This property is valid when using a Schedule Of Accrual of `OnAnniversaryDate` only.

- GET Employee Leave Types added additional parameter **ScheduleOfAccrualDate** to the response when retrieving all the leave types for an active employee.
- POST Employee Leave Types added additional parameter **ScheduleOfAccrualDate** to the response when retrieving all the leave types for an active employee.

## Version 1.15.0


Date: 25 June 2020

**New features and improvements**

- GET Timesheets added optional parameter **status** to filter by the provided timesheetStatusCode.
- GET Timesheets added optional parameter **startDate** to filter by timesheets with a startDate on or after the provided date.
- GET Timesheets added optional parameter **endDate** to filter by timesheets with an endDate on or before the provided date.
- GET Timesheets added optional parameter **sort** to sort by startDate field, in a descending order (newest to oldest).

## Version 1.5.0


Date: 15 May 2019

**New features and improvements**

- POST multiple Earnings Template endpoint is now available.
- GET Payruns requests can now be filtered by **Status**. See documentation for more details.
- POST Timesheet now supports **TimesheetLines**.

## Version 1.4.0


Date: 18 Apr 2019

**New features and improvements**

- GET Employees added additional **PayrollCalendarId** field to the response.
- GET Employees added additional employment **StartDate** field to the response.

## Version 1.3.0


Date: 13 Mar 2019

**New features and improvements**

- GET method on the Statutory Leave Balance endpoint is now available
- GET method on the Statutory Leave Summary endpoint is now available.
- GET and POST methods on Statutory Sick Leave endpoints are now available.

## Version 1.2.0


Date: 26 Feb 2019

**New features and improvements**

- GET and POST methods on the Employee Opening balances endpoint are now available.

## Version 1.1.11


Date: 12 Feb 2019

**New features and improvements**

- GET Employees added additional employment **EndDate** field to the response.
- GET Leave Types added additional **IsStatutoryLeave** field to the response.

## Version 1.1.10


Date: 29 Nov 2018

**New features and improvements**

- Renamed earningsTypeID to earningsRateID.
- Name field is added to Pay Template.

**Bug fixes**

- Create Earnings Template was not returning **ratePerUnit** details.

## Version 1.1.9


Date: 22 Oct 2018

**New features and improvements**

- POST method on Employees Employment is now available.

## Version 1.1.8


Date: 24 Sep 2018

**New features and improvements**

- References to payrunCalendarID have been removed from the Payruns endpoints.
- GET method on Employee By ID – UpdatedDateUTC and CreatedDateUTC added to the response object.
- GET method on Employees – UpdatedDateUTC and CreatedDateUTC added to the response objects.

## Version 1.1.5


Date: 27 Jun 2018

**New features and improvements**

- GET, POST, PUT and DELETE methods on the Salary and Wages endpoint are now available.
- GET Employees added additional contact details fields to the response.

## Version 1.1.2


Date: 4 Apr 2018

**New features and improvements**

- PUT and DELETE methods on the TimesheetLines endpoint are now available.
- POST method on EarningsRates endpoint (PayItems) is now available. Creation of EarningsRates is now supported.
- POST method on PayRunCalendars endpoint is now available. PayRun Calendars can now be created.
- GET Employees requests can now be filtered by FirstName and LastName of employee. See documentation for more details.

## Version 0.3


Date: 21 Feb 2018

**New features and improvements**

- Setting Pay Items (GET)

## Version 0.2


Date: 17 Nov 2017

**New features and improvements**

- PUT Employees
- GET Leave Balances for Employee

## Version 0.1


Date: 4 Oct 2017

**New features and improvements**

- Closed Beta for existing partner applications
- Endpoints for
  - Employees
  - LeaveTypes
  - PaymentMethods
  - PayRunCalendars
  - PayRuns
  - Payslips
  - Settings
  - Timesheets
