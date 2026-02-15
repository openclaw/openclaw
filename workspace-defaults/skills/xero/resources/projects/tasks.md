# Tasks

## Overview


|  |  |
| --- | --- |
| URL | `https://api.xero.com/projects.xro/2.0/projects/{projectId}/tasks` |
| Methods Supported | GET, PUT, POST, DELETE |
| Description | Allows you to retrieve, add, update and delete tasks. Fixed price tasks are not supported in version 1.0. |

## GET Tasks


The following elements are returned in a tasks response

|  |  |
| --- | --- |
| name | Name of the task. |
| rate | Rate of the task, when the `chargeType` is `TIME` this will be the amount (per hour) that your contact will be paying you to perform this task, when the `chargeType` is `FIXED` this will be the fixed amount you will charge for this task. An object containing currency and value. |
| chargeType | Can be `TIME`, `FIXED` or `NON\_CHARGEABLE`, defines how the task will be charged. Use `TIME` when you want to charge per hour and `FIXED` to charge as a fixed amount. If the task will not be charged use `NON\_CHARGEABLE`. |
| estimateMinutes | An estimated time to perform the task. |
| taskId | Identifier of the task. |
| projectId | Identifier of the project task belongs to. |
| totalMinutes | Total minutes which have been logged against the task. Logged by assigning a time entry to a task. |
| totalAmount | Amount calculated by multiplying `totalActualMinutes` by task's rate amount. An object containing currency and value. |
| minutesInvoiced | Minutes on this task which have been invoiced. |
| minutesToBeInvoiced | Minutes on this task which have not been invoiced. |
| fixedMinutes | Minutes logged against this task if its charge type is `FIXED`. |
| nonChargeableMinutes | Minutes logged against this task if its charge type is `NON\_CHARGEABLE`. |
| amountToBeInvoiced | Amount calculated by multiplying the `rate` and `minutesToBeInvoiced`. An object containing currency and value. |
| amountInvoiced | Amount calculated by summing all the invoiced amounts made using this task. An object containing currency and value. |
| status | Status of the task, can be `ACTIVE`, `INVOICED` or `LOCKED`. When a task of ChargeType is `FIXED` and the rate amount is invoiced the status will be set to `INVOICED` and can't be modified. A task with ChargeType of `TIME` or `NON\_CHARGEABLE` cannot have a status of `INVOICED`. A `LOCKED` state indicates that the task is currently changing state (for example being invoiced) and can't be modified. |

### Optional parameters for GET tasks

|  |  |
| --- | --- |
| taskId | You can specify an individual task by appending the taskId to the endpoint, i.e. **GET [https://.../tasks/{taskId](https://.../tasks/%7BtaskId)}** |
| taskIds | Search for all tasks that match a comma separated list of taskIds, i.e. **GET [https://.../tasks?taskIds={taskId},{taskId](https://.../tasks?taskIds=%7BtaskId%7D,%7BtaskId)}** |
| chargeType | Filters based on chargeType, possible options are `TIME`, `FIXED` and `NON\_CHARGEABLE`. |
| page | set to 1 by default. The requested number of the page in paged response – Must be a number greater than 0. |
| pageSize | Optional, it is set to 50 by default. The number of items to return per page in a paged response – Must be a number between 1 and 500. |

Example of retrieving tasks

```
GET https://api.xero.com/projects.xro/2.0/projects/01234567-89ab-cdef-0123-456789abcdef/tasks?taskIds=5ca79345-5c46-4b5c-b9ea-cc7b46f273c0,21234567-89ab-cdef-0123-456789abcdef&chargeType=TIME&page=1&pageSize=50
```


```
{
  "pagination": {
    "page": 1,
    "pageSize": 50,
    "pageCount": 1,
    "itemCount": 1
  },
  "items": [
    {
      "name": "Deep Fryer",
      "rate": {
        "currency": "NZD",
        "value": 99.99
      },
      "chargeType": "TIME",
      "estimateMinutes": 120,
      "taskId": "5ca79345-5c46-4b5c-b9ea-cc7b46f273c0",
      "projectId": "01234567-89ab-cdef-0123-456789abcdef",
      "totalMinutes": 0,
      "totalAmount": {
        "currency": "NZD",
        "value": 0
      },
      "minutesToBeInvoiced": 0,
      "minutesInvoiced": 0,
      "nonChargeableMinutes": 0,
      "amountToBeInvoiced": {
        "currency": "NZD",
        "value": 0
      },
      "amountInvoiced": {
        "currency": "NZD",
        "value": 0
      },
      "status": "ACTIVE"
    }
  ]
}
```


## POST tasks


This method creates a new task for a given project.

The following are **required** when creating a task

|  |  |
| --- | --- |
| name | Name of the task. Max length 100 characters. |
| rate | Rate of the task, when the `chargeType` is `TIME` this will be the amount (per hour) that your contact will be paying you to perform this task, when the `chargeType` is `FIXED` this will be the fixed amount you will charge for this task. An object containing currency and value. |
| chargeType | Can be `TIME`, `FIXED` or `NON\_CHARGEABLE`, defines how the task will be charged. Use `TIME` when you want to charge per hour and `FIXED` to charge as a fixed amount. If the task will not be charged use `NON\_CHARGEABLE`. |

The following are **optional** when creating a task

|  |  |
| --- | --- |
| estimateMinutes | Estimated time to perform the task. EstimateMinutes has to be greater than 0 if provided. |

Example of creating a task

```
POST https://api.xero.com/projects.xro/2.0/projects/01234567-89ab-cdef-0123-456789abcdef/tasks
```


```
{
  "name": "Deep Fryer",
  "rate": {
    "currency": "NZD",
    "value": 99.99
  },
  "chargeType": "TIME",
  "estimateMinutes": 120
}
```


## PUT tasks


This method updates the details of a task.

The following are **required** when updating a task

|  |  |
| --- | --- |
| name | Name of the task. Max length 100 characters. |
| rate | Rate of the task, when the `chargeType` is `TIME` this will be the amount (per hour) that your contact will be paying you to perform this task, when the `chargeType` is `FIXED` this will be the fixed amount you will charge for this task. An object containing currency and value. |
| chargeType | Can be `TIME`, `FIXED` or `NON\_CHARGEABLE`, defines how the task will be charged. Use `TIME` when you want to charge per hour and `FIXED` to charge as a fixed amount. If the task will not be charged use `NON\_CHARGEABLE`. |

The following are **optional** when updating a task

|  |  |
| --- | --- |
| estimateMinutes | Estimated time to perform the task. EstimateMinutes has to be greater than 0 if provided. |

Example of updating a task

```
PUT https://api.xero.com/projects.xro/2.0/projects/01234567-89ab-cdef-0123-456789abcdef/tasks/5ca79345-5c46-4b5c-b9ea-cc7b46f273c0
```


```
{
  "name": "Deep Fryer",
  "rate": {
    "currency": "NZD",
    "value": 99.99
  },
  "chargeType": "TIME",
  "estimateMinutes": 120
}
```


## DELETE tasks


This method will delete a task. Note that if the task has a service associated or has a status `INVOICED`, it will not be removed.

Example of deleting a task

```
DELETE https://api.xero.com/projects.xro/2.0/projects/01234567-89ab-cdef-0123-456789abcdef/tasks/1554d9c8-4fd9-46c7-8822-44e67ff299f4
```
