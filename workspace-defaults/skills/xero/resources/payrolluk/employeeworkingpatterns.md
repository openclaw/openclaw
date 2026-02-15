# Employee Working Patterns

## Overview


|  |  |
| --- | --- |
| URLs | `https://api.xero.com/payroll.xro/2.0/employees/{EmployeeID}/working-patterns` |
| Methods Supported | GET, POST, DELETE |
| Description | Allows you to retrieve the collection of working patterns in Payroll <br>for an employee in a Xero organisation. <br>Allows you to create or delete working patterns in Payroll <br>for an employee in a Xero organisation. |
| Limitations |  |

## GET All Employee Working Patterns


`GET https://api.xero.com/payroll.xro/2.0/employees/{EmployeeID}/working-patterns`

Retrieves all the working patterns for an active employee

### Elements for a Employee Working Pattern

| Element Name | Element Description |
| --- | --- |
| PayeeWorkingPatternID | The Xero identifier for an employee working pattern |
| WorkingPatternID | The Xero identifier for an working pattern |
| EffectiveFrom | The effective date of the corresponding working pattern |

Example response for GET All Employee Working Patterns – 200 OK Response

```
GET https://api.xero.com/payroll.xro/2.0/employees/5db02fad-9921-4a04-8327-9e8724895a77/working-patterns
```


```
{
    "id": "d35de0f1-6fe4-4841-a4d6-f6a785e0c4b7",
    "providerName": "{{xero-provider-name}}",
    "dateTimeUTC": "2024-03-15T01:22:19.0631163",
    "httpStatusCode": "OK",
    "pagination": {
        "page": 1,
        "pageSize": 100,
        "pageCount": 2,
        "itemCount": 21
    },
    "problem": null,
    "payeeWorkingPatterns": [
        {
            "payeeWorkingPatternID": "f429dfe0-4de7-4fdb-8fd3-64f3ec38207c",
            "workingPatternID": "f9cdb808-b9a6-4c96-933f-857db5ab1c3c",
            "effectiveFrom": "2024-03-24T00:00:00"
        }
    ]
}
```


## GET Employee Working Pattern


`GET https://api.xero.com/payroll.xro/2.0/employees/{EmployeeID}/working-patterns/{WorkingPatternID}`

Retrieves all the working patterns for an active employee

### Elements for a Employee Working Pattern

| Element Name | Element Description |
| --- | --- |
| PayeeWorkingPatternID | The Xero identifier for an employee working pattern |
| WorkingPatternID | The Xero identifier for working pattern |
| EffectiveFrom | The effective date of the corresponding working pattern |

Example response for GET All Employee Working Patterns – 200 OK Response

```
GET https://api.xero.com/payroll.xro/2.0/employees/5db02fad-9921-4a04-8327-9e8724895a77/working-patterns/3941fa5d-25e3-4a76-96e1-d6c6d0a19197
```


```
{
    "id": "d35de0f1-6fe4-4841-a4d6-f6a785e0c4b7",
    "providerName": "text",
    "dateTimeUTC": "2024-03-15T01:52:56.8339542",
    "httpStatusCode": "OK",
    "pagination": null,
    "problem": null,
    "payeeWorkingPattern": {
        "payeeWorkingPatternID": "3941fa5d-25e3-4a76-96e1-d6c6d0a19197",
        "workingPatternID": "f9cdb808-b9a6-4c96-933f-857db5ab1c3c",
        "effectiveFrom": "2024-03-24T00:00:00"
    }
}
```


## Create an Employee Working Pattern


`POST https://api.xero.com/payroll.xro/2.0/employees/{EmployeeID}/working-patterns`

Use this method to create a working pattern item for an active employee.

### Elements for a Employee Working Pattern

_The following are **required** to create a new employee working pattern_

| Element Name | Element Description |
| --- | --- |
| WorkingPatternID | The Xero identifier for a working pattern |
| EffectiveFrom | The effective date of the corresponding working pattern |

Example of minimum elements required to add an Employee Working Pattern – 200 OK Response

```
POST https://api.xero.com/payroll.xro/2.0/employees/5db02fad-9921-4a04-8327-9e8724895a77/working-patterns
```


Request Body

```
{
	"workingPatternID": "f9cdb808-b9a6-4c96-933f-857db5ab1c3c",
	"effectiveFrom": "2024-03-24T00:00:00"
}
```


Response Body

```
{
    "id": "d35de0f1-6fe4-4841-a4d6-f6a785e0c4b7",
    "providerName": "text",
    "dateTimeUTC": "2024-03-15T01:52:56.8339542",
    "httpStatusCode": "OK",
    "pagination": null,
    "problem": null,
    "payeeWorkingPattern": {
        "payeeWorkingPatternID": "3941fa5d-25e3-4a76-96e1-d6c6d0a19197",
        "workingPatternID": "f9cdb808-b9a6-4c96-933f-857db5ab1c3c",
        "effectiveFrom": "2024-03-24T00:00:00"
    }
}
```


Example of adding a working pattern to a locked base pay – 400 Bad Request

```
POST https://api.xero.com/payroll.xro/2.0/employees/5db02fad-9921-4a04-8327-9e8724895a77/working-patterns
```


Request Body

```
{
	"workingPatternID": "f9cdb808-b9a6-4c96-933f-857db5ab1c3c",
	"effectiveFrom": "2044-03-24T00:00:00"
}
```


Response Body

```
{
    "id": "d35de0f1-6fe4-4841-a4d6-f6a785e0c4b7",
    "providerName": "text",
    "dateTimeUTC": "2024-03-14T01:12:55.23984",
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
                "name": "PayeeWorkingPatterns",
                "reason": "Base pay for  is locked"
            }
        ],
        "invalidObjects": null
    },
    "payeeWorkingPattern": null
}
```


Example of adding multiple working patterns to the same base pay – 400 Bad Request

```
POST https://api.xero.com/payroll.xro/2.0/employees/5db02fad-9921-4a04-8327-9e8724895a77/working-patterns
```


Request Body

```
{
	"workingPatternID": "f9cdb808-b9a6-4c96-933f-857db5ab1c3c",
	"effectiveFrom": "2044-03-24T00:00:00"
}
```


Response Body

```
{
    "id": "d35de0f1-6fe4-4841-a4d6-f6a785e0c4b7",
    "providerName": "text",
    "dateTimeUTC": "2024-03-15T01:46:48.5771564",
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
                "name": "_default",
                "reason": "Multiple PayeeWorkingPatterns have the same effective date. Please check and try again"
            }
        ],
        "invalidObjects": null
    },
    "payeeWorkingPattern": null
}
```


## Delete an Employee Working Pattern


`DELETE https://api.xero.com/payroll.xro/2.0/employees/{EmployeeID}/working-patterns/{PayeeWorkingPatternID}`

Use this method to delete an employee working pattern for an active employee

### Elements for Employee Working Pattern

_The following are **required** to delete an employee working pattern_

| Element Name | Element Description |
| --- | --- |
| EmployeeID | Xero unique identifier for an employee |
| WorkingPatternID | The Xero identifier for an employee working pattern |

Example of minimum elements required to delete an Employee Working Pattern – 200 OK Response

```
DELETE https://api.xero.com/payroll.xro/2.0/employees/f9cd7a97-6307-4ef4-a628-a9e62df822d2/working-patterns/3941fa5d-25e3-4a76-96e1-d6c6d0a19197
```


Response Body

```
{
    "id": "d35de0f1-6fe4-4841-a4d6-f6a785e0c4b7",
    "providerName": "text",
    "dateTimeUTC": "2024-03-15T02:10:40.3232581",
    "httpStatusCode": "OK",
    "pagination": null,
    "problem": null
}
```


## Working Patterns


## Overview


|  |  |
| --- | --- |
| URLs | `https://api.xero.com/payroll.xro/2.0/working-patterns` |
| Methods Supported | GET, POST, DELETE |
| Description | Allows you to retrieve the collection of working patterns in Payroll <br>for a Xero organisation. <br>Allows you to create or delete working patterns in Payroll <br>for a Xero organisation. |
| Limitations |  |

## GET All Working Patterns


`GET https://api.xero.com/payroll.xro/2.0/working-patterns`

Retrieves all the working patterns for a Xero organisation

### Elements for a Working Pattern

| Element Name | Element Description |
| --- | --- |
| WorkingPatternID | The Xero identifier for a working pattern |
| Name | The name of the working pattern |
| IsDefault | Describes if the working pattern is default. Can only be `true` for a single working pattern |
| WorkingWeeks | The working weeks which make up a working pattern |

### Elements for a Working Week

| Element Name | Element Description |
| --- | --- |
| WorkingWeekID | The Xero identifier for a working week |
| SequenceNumber | The position of the working week within the working pattern sequence |
| Monday | The number of hours worked on a Monday |
| Tuesday | The number of hours worked on a Tuesday |
| Wednesday | The number of hours worked on a Wednesday |
| Thursday | The number of hours worked on a Thursday |
| Friday | The number of hours worked on a Friday |
| Saturday | The number of hours worked on a Saturday |
| Sunday | The number of hours worked on a Sunday |

Example response for GET All Working Patterns – 200 OK Response

```
GET https://api.xero.com/payroll.xro/2.0/working-patterns
```


```
{
    "id": "d35de0f1-6fe4-4841-a4d6-f6a785e0c4b7",
    "providerName": "{{xero-provider-name}}",
    "dateTimeUTC": "2024-03-15T00:00:08.4219318",
    "httpStatusCode": "OK",
    "pagination": {
        "page": 1,
        "pageSize": 100,
        "pageCount": 1,
        "itemCount": 2
    },
    "problem": null,
    "workingPatterns": [
        {
            "workingPatternID": "f9cdb808-b9a6-4c96-933f-857db5ab1c3c",
            "name": "Test",
            "isDefault": true,
            "workingWeeks": [
                {
                    "workingWeekID": "7ceac6ba-cd57-4de7-b395-bc1352b2d3ed",
                    "sequenceNumber": 0,
                    "monday": 7.5000,
                    "tuesday": 7.5000,
                    "wednesday": 7.5000,
                    "thursday": 7.5000,
                    "friday": 9.0000,
                    "saturday": 0.0,
                    "sunday": 0.0
                }
            ]
        }
    ]
}
```


## Create a Working Pattern


`POST https://api.xero.com/payroll.xro/2.0/working-patterns`

Use this method to create a working pattern for a Xero organisation

### Elements for a Working Pattern

| Element Name | Element Description |
| --- | --- |
| Name | The name of the working pattern |
| IsDefault | Describes if the working pattern is default. Can only be `true` for a single working pattern |
| WorkingWeeks | The working weeks which make up a working pattern |

### Elements for a Working Week

| Element Name | Element Description |
| --- | --- |
| SequenceNumber | The position of the working week within the working pattern sequence |
| Monday | The number of hours worked on a Monday |
| Tuesday | The number of hours worked on a Tuesday |
| Wednesday | The number of hours worked on a Wednesday |
| Thursday | The number of hours worked on a Thursday |
| Friday | The number of hours worked on a Friday |
| Saturday | The number of hours worked on a Saturday |
| Sunday | The number of hours worked on a Sunday |

Example of minimum elements required to add a Working Pattern – 200 OK Response

```
POST https://api.xero.com/payroll.xro/2.0/working-patterns
```


Request Body

```
{
    "workingPatterns": [
        {
            "name": "Weekends",
            "isDefault": true,
            "workingWeeks": [
                {
                    "sequenceNumber": 0,
                    "monday": 0.0,
                    "tuesday": 0.0,
                    "wednesday": 0.0,
                    "thursday": 0.0,
                    "friday": 0.0,
                    "saturday": 8.5,
                    "sunday": 8.5
                }
            ]
        }
    ]
}
```


Response Body

```
{
    "id": "d35de0f1-6fe4-4841-a4d6-f6a785e0c4b7",
    "providerName": "{{xero-provider-name}}",
    "dateTimeUTC": "2024-03-15T00:19:06.1125071",
    "httpStatusCode": "OK",
    "pagination": {
        "page": 1,
        "pageSize": 100,
        "pageCount": 1,
        "itemCount": 3
    },
    "problem": null,
    "workingPatterns": [
        {
            "workingPatternID": "d2be8a05-a91c-4732-a41e-7d4583ac5837",
            "name": "Weekends",
            "isDefault": true,
            "workingWeeks": [
                {
                    "workingWeekID": "d0553207-52fc-4763-8f88-1c3d2ec3cb3b",
                    "sequenceNumber": 0,
                    "monday": 0.0,
                    "tuesday": 0.0,
                    "wednesday": 0.0,
                    "thursday": 0.0,
                    "friday": 0.0,
                    "saturday": 8.5000,
                    "sunday": 8.5000
                }
            ]
        }
    ]
}
```


## Delete a Working Pattern


`DELETE https://api.xero.com/payroll.xro/2.0/working-patterns/`

Use this method to delete a working pattern for a Xero organisation

### Elements for Employee Working Pattern

_The following are **required** to delete an employee working pattern_

| Element Name | Element Description |
| --- | --- |
| WorkingPatternIDs | A collection of the the Xero identifier for a working pattern to delete |

Example of minimum elements required to delete an Employee Working Pattern – 200 OK Response

```
DELETE https://api.xero.com/payroll.xro/2.0/working-patterns/
```


Request Body

```
{
    "WorkingPatternIDs": ["d2be8a05-a91c-4732-a41e-7d4583ac5837"]
}
```


Response Body

```
{
    "id": "d35de0f1-6fe4-4841-a4d6-f6a785e0c4b7",
    "providerName": "{{xero-provider-name}}",
    "dateTimeUTC": "2024-03-15T00:26:40.2504249",
    "httpStatusCode": "OK",
    "pagination": null,
    "problem": null
}
```
