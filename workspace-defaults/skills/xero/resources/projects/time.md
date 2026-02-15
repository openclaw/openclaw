# Time

## Overview


|  |  |
| --- | --- |
| URL | `https://api.xero.com/projects.xro/2.0/projects/{projectId}/time` |
| Methods Supported | GET, PUT, POST, DELETE |
| Description | Allows you to retrieve, add, update and delete time entries. Managing time for fixed price tasks is not supported in version 1.0. |

## GET time


The following elements are returned in a time response

|  |  |
| --- | --- |
| timeEntryId | Identifier of the time entry. |
| userId | The xero user identifier of the person who logged time. |
| projectId | Identifier of the project, that the task (which the time entry is logged against) belongs to. |
| taskId | Identifier of the task that time entry is logged against. |
| dateUtc | The date time that time entry is logged on. UTC Date Time in ISO-8601 format. |
| dateEnteredUtc | The date time that time entry is created. UTC Date Time in ISO-8601 format. By default it is set to server time. |
| duration | The duration of logged minutes. |
| description | A description of the time entry. |
| status | Status of the time entry. By default a time entry is created with status of `ACTIVE`. A `LOCKED` state indicates that the time entry is currently changing state (for example being invoiced). Updates are not allowed when in this state. It will have a status of `INVOICED` once it is invoiced. |

### Optional parameters for GET time

|  |  |
| --- | --- |
| timeEntryId | You can specify an individual time entry by appending the timeEntryId to the endpoint, i.e. `GET https://.../time/{timeEntryId}` |
| userId | Finds all time entries matching this user identifier. |
| taskId | Finds all time entries matching this task identifier. |
| dateAfterUtc | ISO 8601 UTC date. Finds all time entries on or after this date filtered on the `dateUtc` field. |
| dateBeforeUtc | ISO 8601 UTC date. Finds all time entries on or before this date filtered on the `dateUtc` field. |
| isChargeable | Finds all time entries which relate to tasks with the charge type `TIME` or `FIXED`. |
| invoiceId | Finds all time entries for this invoice. |
| contactId | Finds all time entries for this contact identifier. |
| states | Comma-separated list of states to find. Will find all time entries that are in the status of whatever’s specified. |
| page | set to 1 by default. The requested number of the page in paged response – Must be a number greater than 0. |
| pageSize | Optional, it is set to 50 by default. The number of items to return per page in a paged response – Must be a number between 1 and 500. |

Example of retrieving time entries

```
GET https://api.xero.com/projects.xro/2.0/projects/01234567-89ab-cdef-0123-456789abcdef/time?userId=01234567-89ab-cdef-0123-456789abcdef&taskId=01234567-89ab-cdef-0123-456789abcdef&dateAfterUtc=2016-02-25T15:35:15Z&dateBeforeUtc=2016-02-26T23:59:59Z&chargeType=TIME&invoiceId=01234567-89ab-cdef-0123-456789abcdef&states=ACTIVE&page=1&pageSize=50
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
      "timeEntryId": "1554d9c8-4fd9-46c7-8822-44e67ff299f4",
      "userId": "8e55a91c-ad9f-4b82-8981-a9eb0c81860d",
      "projectId": "01234567-89ab-cdef-0123-456789abcdef",
      "taskId": "f4ca82a5-9943-44fd-af86-451a2f707d22",
      "dateUtc": "2015-01-01T23:34:15Z",
      "dateEnteredUtc": "2015-01-01T23:34:15Z",
      "duration": 120,
      "description": "Removed old deep fryer",
      "status": "ACTIVE"
    }
  ]
}
```


## POST time


This method creates a time entry for the specified task in the given project.

The following are **required** when creating a time entry

|  |  |
| --- | --- |
| userId | The xero user identifier of the person logging the time. |
| taskId | Identifier of the task that time entry is logged against. |
| dateUtc | Date time entry is logged on. UTC Date Time in ISO-8601 format. |
| duration | Number of minutes to be logged. Duration is between 1 and 59940 inclusively. |

The following are **optional** when creating a time entry

|  |  |
| --- | --- |
| description | An optional description of the time entry, will be set to null if not provided during update. |

Example of creating a time entry

```
POST https://api.xero.com/projects.xro/2.0/projects/01234567-89ab-cdef-0123-456789abcdef/time
```


```
{
	"userId": "8e55a91c-ad9f-4b82-8981-a9eb0c81860d",
	"taskId": "f4ca82a5-9943-44fd-af86-451a2f707d22",
  "dateUtc": "2015-01-01T23:34:15Z",
  "duration": 120,
  "description": "Removed old deep fryer"
}
```


## PUT time


This method updates the details of the time entry. You cannot update a time entry if the state is not ACTIVE.

The following are **required** when updating a time entry

|  |  |
| --- | --- |
| userId | The xero user identifier of the person logging the time. |
| taskId | Identifier of the task that time entry is logged against. |
| dateUtc | Date time entry is logged on. UTC Date Time in ISO-8601 format. |
| duration | Number of minutes to be logged. Duration is between 1 and 59940 inclusively. |

The following are **optional** when updating a time entry

|  |  |
| --- | --- |
| description | An optional description of the time entry, will be set to null if not provided during update. |

Example of updating a time entry

```
PUT https://api.xero.com/projects.xro/2.0/projects/01234567-89ab-cdef-0123-456789abcdef/time/1554d9c8-4fd9-46c7-8822-44e67ff299f4
```


```
{
  "userId": "8e55a91c-ad9f-4b82-8981-a9eb0c81860d",
  "taskId": "5ca79345-5c46-4b5c-b9ea-cc7b46f273c0",
  "dateUtc": "2015-01-01T23:34:15Z",
  "duration": 120,
  "description": "Removed old deep fryer"
}
```


## DELETE time


This method will delete a time entry. Note that if the time entry has status `INVOICED`, it will not be removed.

Example of deleting a time entry

```
DELETE https://api.xero.com/projects.xro/2.0/projects/01234567-89ab-cdef-0123-456789abcdef/time/1554d9c8-4fd9-46c7-8822-44e67ff299f4
```
