# Overview

The Payroll API exposes payroll related functions of the payroll Xero application and can be used for a variety of purposes such as syncing employee details, importing timesheets etc.

## Availability


This documentation is for the UK Payroll API. We have separate payroll APIs for the Australia and New Zealand markets.

UK Xero organisations (including the sample Demo company) must have concluded the [payroll set up steps](https://central.xero.com/s/topic/0to1n0000017kmiwaq/payroll-employees/#business) before the Payroll API can be used.

You'll need partner permissions provided by Xero. If you'd like to be a partner, you can get in touch here.

## Permissions


In order to authorise **any** API connection the Xero user must have the [Standard](http://help.xero.com/uk/#standard) or [Adviser](http://help.xero.com/uk/#farole) role.

In addition, only Xero users with [payroll administrator access](http://help.xero.com/uk/#payrolladmin) can authorise access to payroll endpoints.

## URLs


The base url for all payroll endpoints is `https://api.xero.com/payroll.xro/2.0/`
e.g. The URL for the Employees endpoint is `https://api.xero.com/payroll.xro/2.0/employees`

## Types and Codes


See the Types and Codes applicable for use with the Payroll API endpoints.

## Response Codes


See the HTTP Response Codes and Errors applicable for the Payroll API endpoints.

## Feature requests


The Payroll API has its own section of our [feature request forum](http://xero.uservoice.com/forums/250567-xero-payroll-api) – please feel free to suggest any features that you would like to see added to this API.
