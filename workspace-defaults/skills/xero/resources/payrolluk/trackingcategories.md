# Tracking Categories

## Overview


|  |  |
| --- | --- |
| URLs | `https://api.xero.com/payroll.xro/2.0/settings/trackingCategories` |
| Methods Supported | GET |
| Description | Allows you to get an tracking categories information from a Xero organisation <br>This tracking categories information is comprised of EmployeeGroupsTrackingCategoryID and TimesheetTrackingCategoryID |

## GET Tracking Categories


`https://api.xero.com/payroll.xro/2.0/settings/trackingCategories`

### Elements for Tracking Categories

|  |  |
| --- | --- |
| EmployeeGroupsTrackingCategoryID | The Xero identifier for Employee groups tracking category. |
| TimesheetTrackingCategoryID | The Xero identifier for Timesheet tracking category. |

Example response for GET Tracking Categories

```
GET https://api.xero.com/payroll.xro/2.0/settings/trackingCategories
```


```
{
    "id": "7b377959-99fa-081f-3206-0acd280e7625",
    "providerName": "!YLT5Y",
    "dateTimeUTC": "2018-02-02T00:47:07.8531242",
    "httpStatusCode": "OK",
    "pagination": null,
    "problem": null,
    "trackingCategories": {
        "employeeGroupsTrackingCategoryID": "b0689e8d-71d3-4c8a-acc8-eabd4e33f108",
        "timesheetTrackingCategoryID": "9e98334c-f2dc-495f-8e7b-88eb01708991"
    }
}
```
