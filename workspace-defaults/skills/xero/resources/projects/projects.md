# Projects

## Overview


|  |  |
| --- | --- |
| URL | `https://api.xero.com/projects.xro/2.0/projects` |
| Methods Supported | POST, GET, PUT, PATCH |
| Description | Allows you to retrieve, create and update projects. Project estimates calculated from tasks and estimated expenses are not supported in version 2.0. |

## GET projects


The following elements are returned in the projects response

|  |  |
| --- | --- |
| projectId | Identifier of the project. |
| contactId | Identifier of the contact this project was created for. See Contacts. |
| name | Name of the project. |
| currencyCode | A project's currency code in ISO-4217 format. Will be set to the organisation's default currency, until a time where Projects supports multi-currency projects. |
| minutesLogged | A total of minutes logged against all tasks on the Project. |
| totalTaskAmount | A summation of the total actuals amount of each project task. An object containing currency and value. |
| totalExpenseAmount | A summation of the total actuals amount of each project expense. An object containing currency and value. |
| minutesToBeInvoiced | Minutes which have not been invoiced across all chargeable tasks in the project. |
| taskAmountToBeInvoiced | A summation of `amountToBeInvoiced` of each task in the project. An object containing currency and value. |
| taskAmountInvoiced | A summation of `amountInvoiced` of each task in the project. An object containing currency and value. |
| expenseAmountToBeInvoiced | A summation of 'total' of each expense which is not invoiced in the project. An object containing currency and value. |
| expenseAmountInvoiced | A summation of 'total' of each expense which is invoiced in the project. An object containing currency and value. |
| projectAmountInvoiced | A summation of project amount invoices that is invoiced in the project. An object containing currency and value. |
| deposit | Deposit for the project. An object containing currency and value. |
| depositApplied | Deposit amounts which have been applied to invoice/s as credit. An object containing currency and value. |
| creditNoteAmount | A summation of credit notes in the project. An object containing currency and value. |
| deadlineUTC | Deadline for the project. UTC Date Time in ISO-8601 format. |
| totalInvoiced | A summation of the values `taskAmountInvoiced`, `expenseAmountInvoiced`, `projectAmountInvoiced`, `deposit`, `depositApplied` and `creditNoteAmount`. An object containing currency and value. |
| totalToBeInvoiced | A summation of the values values `taskAmountToBeInvoiced` and `expenseAmountToBeInvoiced`. An object containing currency and value. |
| estimate | Estimate for the project (currency and value). An object containing currency and value. |
| status | Status of the project. INPROGRESS or CLOSED. A project is created with status of `INPROGRESS`. To change the status of a project see PATCH. |

### Optional parameters for GET Projects

|  |  |
| --- | --- |
| projectId | You can specify an individual project by appending the projectId to the endpoint, i.e. `GET https://.../projects/{projectId}` |
| projectIds | Search for all projects that match a comma separated list of projectIds, i.e. `GET https://.../projects?projectIDs={projectId},{projectId}` |
| contactID | Filter for projects for a specific contact |
| states | Filter for projects in a particular state (INPROGRESS or CLOSED) |
| page | set to 1 by default. The requested number of the page in paged response – Must be a number greater than 0. |
| pageSize | Optional, it is set to 50 by default. The number of items to return per page in a paged response – Must be a number between 1 and 500. |

Example response when searching projects

```
GET https://api.xero.com/projects.xro/2.0/projects?contactId=01234567-89ab-cdef-0123-456789abcdef&states=INPROGRESS&page=1&pageSize=50
```


```
{
  "pagination": {
    "page": 1,
    "pageSize": 50,
    "pageCount": 1,
    "itemCount": 1
    }
  },
  "items": [
    {
      "projectId": "254553fa-2be8-4991-bd5e-70a97ea12ef8",
      "contactId": "01234567-89ab-cdef-0123-456789abcdef",
      "name": "New Kitchen",
      "currencyCode": "",
      "minutesLogged": 0,
      "totalTaskAmount": {
        "currency": "NZD",
        "value": 0
      },
      "totalExpenseAmount": {
        "currency": "NZD",
        "value": 0
      },
      "minutesToBeInvoiced": 0,
      "taskAmountToBeInvoiced": {
        "currency": "NZD",
        "value": 0
      },
      "taskAmountInvoiced": {
        "currency": "NZD",
        "value": 0
      },
      "expenseAmountToBeInvoiced": {
        "currency": "NZD",
        "value": 0
      },
      "expenseAmountInvoiced": {
        "currency": "NZD",
        "value": 0
      },
      "projectAmountInvoiced": {
        "currency": "NZD",
        "value": 0
      },
      "deposit": {
        "currency": "NZD",
        "value": 0
      },
      "depositApplied": {
        "currency": "NZD",
        "value": 0
      },
      "creditNoteAmount": {
        "currency": "NZD",
        "value": 0
      },
      "deadlineUtc": "",
      "totalInvoiced": {
        "currency": "NZD",
        "value": 0
      },
      "totalToBeInvoiced": {
        "currency": "NZD",
        "value": 0
      },
      "estimate": {
        "currency": "NZD",
        "value": 99.99
      },
      "status": "INPROGRESS"
    }
  ]
}
```


## POST projects


This method creates a project for the specified contact.

The following are **required** when creating a Project

|  |  |
| --- | --- |
| contactId | Identifier of the contact this project was created for. See Contacts. Currently only available when creating a project. |
| Name | Name of the project. |

The following are **optional** when creating a Project

|  |  |
| --- | --- |
| deadlineUTC | Deadline for the project. UTC Date Time in ISO-8601 format. |
| estimateAmount | Estimate for the project. |

Example request creating a project

```
POST https://api.xero.com/projects.xro/2.0/Projects
```


```
{
  "contactId": "01234567-89ab-cdef-0123-456789abcdef",
  "name": "New Kitchen",
  "deadlineUtc": "2017-04-23T18:25:43.511Z",
  "estimateAmount": 99.99
}
```


## PUT projects


This method updates the details of a project.

|  |  |
| --- | --- |
| The following are **required** when updating a Project |  |
| Name | Name of the project. |
| The following are **optional** when updating a Project |  |
| deadlineUTC | Deadline for the project. UTC Date Time in ISO-8601 format. |
| estimateAmount | Estimate for the project. |

Example request to update a project's details

```
PUT https://api.xero.com/projects.xro/2.0/Projects/254553fa-2be8-4991-bd5e-70a97ea12ef8
```


```
{
  "name": "New Kitchen",
  "deadlineUtc": "2017-04-23T18:25:43.511Z",
  "estimateAmount": 99.99
}
```


## PATCH projects


This method updates the status of a project.

The following are **required** when updating a Project's status

|  |  |
| --- | --- |
| Status | INPROGRESS or CLOSED |

Example request to update a project's status

```
PATCH https://api.xero.com/projects.xro/2.0/Projects/254553fa-2be8-4991-bd5e-70a97ea12ef8
```


```
{
  "status": "INPROGRESS"
}
```
