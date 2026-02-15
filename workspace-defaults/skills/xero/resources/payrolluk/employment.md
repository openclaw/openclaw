# Employment

## Overview


|  |  |
| --- | --- |
| URL | `https://api.xero.com/payroll.xro/2.0/employees/{EmployeeID}/employment` |
| Methods Supported | POST |
| Description | Allows you to add an employment record in Payroll for an employee in a Xero organisation |

## POST Employment


`POST https://api.xero.com/payroll.xro/2.0/employees/{EmployeeID}/employment/`

Adds an employment for an active employee. Only one employee employment application can be processed in each request.

_The following are **required** to create a new employment_

| Element name | Element description |
| --- | --- |
| PayrollCalendarID | The Xero identifier for Payroll Calendar |
| StartDate | Start date of the employment. This will be locked once an employee has been paid and has created contracts (YYYY-MM-DD) |
| EmployeeNumber | The employment number of the employee |
| NICategories | The NI Category information. See NI Category |
| Contracts | The employment contract information. See Contracts |

Contracts are optional until the end of the breaking period notification on **January 20th 2026**. After this date, Contracts will be required.

### Elements for a NI Category

_The following are **required** to create a NI Category_

| Element name | Element description |
| --- | --- |
| NICategory | The National Insurance category code of the employee |

_The following elements are **optional** to create a NI Category_

|  |  |
| --- | --- |
| StartDate | Start date of the NI Category (YYYY-MM-DD) |
| DateFirstEmployedAsCivilian | Applies to category V only. The date the employee was first employed as a civilian |
| WorkplacePostcode | Applies to Freeport and Investment Zone categories only. The postcode at which NI relief is being claimed |

### Elements for Contracts

_The following are **required** to create a Contract_

| Element name | Element description |
| --- | --- |
| EmploymentStatus | The employment status of the employee. Valid values: 'Employee' or 'Worker'. 'Unspecified' is a system generated EmploymentStatus type that is used to represent any gaps between the start date of an employee and their first contract |
| ContractType | The contract type of the employee. Valid values: 'FullTime', 'PartTime' & 'ZeroHour'. 'Unspecified' is a system generated contract type that is used to represent any gaps between the start date of an employee and their first contract |
| StartDate | The contract start date of the employee. This will be locked once an employee has been paid and cannot be changed (YYYY-MM-DD)\* |

\*This StartDate change is effective immediately and not included in the breaking change notification on January 20th 2026.

_The following are **optional** to create a Contract_

| Element name | Element description |
| --- | --- |
| PublicKey | The public key of the contract. Public key is required if the intention is to edit an existing contract. If no key is supplied a new contract will be created |
| IsFixedTerm | Boolean – describes whether the contract is fixed term (required if trying to create Fixed term contract) |
| FixedTermEndDate | The fixed term end date of the employee. Not required if isFixedTerm is false or not provided (required if trying to create Fixed term contract) |
| DevelopmentalRoleDetails | The development role details of the employee |

_The following are **required** to create a Developmental Role_

A Developmental Role is a role that is used to describe an employee's role as an Apprentice.

| Element name | Element description |
| --- | --- |
| StartDate | The start date of the developmental role |
| EndDate | The end date of the developmental role |
| DevelopmentalRole | The developmental role type - "Apprentice" is the only supported role currently |

_The following are **optional** to create a Developmental Role_

| Element name | Element description |
| --- | --- |
| DevelopmentalRolePublicKey | The public key of the developmental role. Public key is required if the intention is to edit an existing developmental role. If no key is supplied a new developmental role will be created |

Example of a successful POST of an employment record – 200 OK Response

This uses minimum required elements to add a new employment with **contracts** and **nicategories**.

```
POST https://api.xero.com/payroll.xro/2.0/employees/d90457c4-f1be-4f2e-b4e3-f766390a7e30/employment
```


Request Body

```
{
  "startDate": "2017-11-1T00:00:00",
  "payRollCalendarID": "d90457c4-f1be-4f2e-b4e3-f766390a7e30",
  "niCategories": [
    {
      "nICategory": "A",
      "startDate": "2020-05-01"
    }
  ],
  "employeeNumber": "007",
  "contracts": [
    {
      "employmentStatus": "Employee",
      "contractType": "FullTime",
      "startDate": "2017-11-01T00:00:00"
    }
  ]
}
```


Response Body

```
{
    "id": "3f9d43fe-e191-4e62-f702-99d533645899",
    "providerName": "!YLZZZ",
    "dateTimeUTC": "2018-10-14T23:05:04.704803",
    "httpStatusCode": "OK",
    "pagination": null,
    "problem": null,
    "employment": {
      "payrollCalendarID": "4cb19598-d339-4a0c-ac79-c6dec547a314",
      "startDate": "2017-11-01T00:00:00",
      "niCategories": [
        {
          "niCategory": "A",
          "startDate": "2020-05-01",
          "niCategoryID": 594,
          "dateFirstEmployedAsCivilian": null,
          "workplacePostcode": null
        }
      ],
      "employeeNumber": "007",
      "contracts": [
        {
          "publicKey": "7ee19598-j653-4a0c-8d69-fd909ef4876c",
          "isFixedTerm": false,
          "employmentStatus": "Employee",
          "contractType": "FullTime",
          "startDate": "2017-11-01T00:00:00",
          "fixedTermEndDate": null
        }
      ]
    }
}
```


Example of a successful POST of an employment record with a **Fixed Term** contract – 200 OK Response

This uses minimum required elements to add a new employment.

```
POST https://api.xero.com/payroll.xro/2.0/employees/d90457c4-f1be-4f2e-b4e3-f766390a7e30/employment
```


Request Body

```
{
  "startDate": "2017-11-1T00:00:00",
  "payRollCalendarID": "d90457c4-f1be-4f2e-b4e3-f766390a7e30",
  "niCategories": [
    {
      "nICategory": "A",
      "startDate": "2020-05-01"
    }
  ],
  "employeeNumber": "007",
  "contracts": [
    {
      "isFixedTerm": true,
      "employmentStatus": "Employee",
      "contractType": "PartTime",
      "startDate": "2017-11-01T00:00:00",
      "fixedTermEndDate": "2018-10-31T00:00:00"
    }
  ]
}
```


Response Body

```
{
  "id": "3f9d43fe-e191-4e62-f702-99d533645899",
  "providerName": "!YLZZZ",
  "dateTimeUTC": "2018-10-14T23:05:04.704803",
  "httpStatusCode": "OK",
  "pagination": null,
  "problem": null,
  "employment": {
    "payrollCalendarID": "d90457c4-f1be-4f2e-b4e3-f766390a7e30",
    "startDate": "2017-11-01T00:00:00",
    "niCategories": [
      {
        "niCategory": "A",
        "startDate": "2020-05-01",
        "niCategoryID": 594
      }
    ],
    "employeeNumber": "007",
    "contracts": [
      {
        "publicKey": "7ee19598-j653-4a0c-8d69-fd909ef4876c",
        "isFixedTerm": true,
        "employmentStatus": "Employee",
        "contractType": "PartTime",
        "startDate": "2017-11-01T00:00:00",
        "fixedTermEndDate": "2018-10-31T00:00:00"
      }
    ]
  }
}
```


Example of a successful POST of an employment record with a **Developmental Role** contract – 200 OK Response

This uses minimum required elements to add a new employment.

**NOTE**: A Developmental Role can be created alongside a Fixed Term contract only.

```
POST https://api.xero.com/payroll.xro/2.0/employees/d90457c4-f1be-4f2e-b4e3-f766390a7e30/employment
```


Request Body

```
{
  "startDate": "2017-11-1T00:00:00",
  "payRollCalendarID": "d90457c4-f1be-4f2e-b4e3-f766390a7e30",
  "niCategories": [
    {
      "nICategory": "A",
      "startDate": "2020-05-01"
    }
  ],
  "employeeNumber": "007",
  "contracts": [
    {
      "isFixedTerm": true,
      "employmentStatus": "Employee",
      "contractType": "FullTime",
      "startDate": "2017-11-01T00:00:00",
      "fixedTermEndDate": "2021-11-01T00:00:00",
      "developmentalRoleDetails":
      {
        "startDate": "2017-11-01T00:00:00",
        "endDate": "2021-11-01T00:00:00",
        "developmentalRole": "Apprentice"
      }
    }
  ]
}
```


Response Body

```
{
  "id": "3f9d43fe-e191-4e62-f702-99d533645899",
  "providerName": "!YLZZZ",
  "dateTimeUTC": "2018-10-14T23:05:04.704803",
  "httpStatusCode": "OK",
  "pagination": null,
  "problem": null,
  "employment": {
    "payrollCalendarID": "d90457c4-f1be-4f2e-b4e3-f766390a7e30",
    "startDate": "2017-11-01T00:00:00",
    "niCategories": [
      {
        "niCategory": "A",
        "startDate": "2020-05-01",
        "niCategoryID": 594
      }
    ],
    "employeeNumber": "007",
    "contracts": [
      {
        "publicKey": "7ee19598-j653-4a0c-8d69-fd909ef4876c",
        "isFixedTerm": true,
        "employmentStatus": "Employee",
        "contractType": "FullTime",
        "startDate": "2017-11-01T00:00:00",
        "fixedTermEndDate": "2021-11-01",
        "developmentalRoleDetails":
        {
          "developmentalRolePublicKey": "290cef95-4eb1-496e-94be-ea365265eeba",
          "startDate": "2017-11-01",
          "endDate": "2021-11-01",
          "developmentalRole": "Apprentice"
        }
      }
    ]
  }
}
```


Example of a POST employment record with an invalid NICategory and EmployeeNumber – 400 Bad Request

```
POST https://api.xero.com/payroll.xro/2.0/employees/35cdd697-c9fc-4931-b579-a18cb8b6fe14/employment
```


Request Body

```
{
  "startDate": "2017-11-1T00:00:00",
  "payRollCalendarID": "4cb19598-d009-4a0c-ac79-c6dec547a314",
  "niCategories": [
    {
      "nICategory": ""
    }
  ]
  "employeeNumber": ""
}
```


Response Body

```
{
  "id": "3f9d43fe-e191-4e62-f702-99d576645899",
  "providerName": "!YLT5Y",
  "dateTimeUTC": "2018-10-14T23:09:47.5484561",
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
              "name": "NICategory",
              "reason": "The NI Category is required."
          },
          {
              "name": "PayerEmployeeNumber",
              "reason": "The Employee Number is required."
          }
      ]
  },
  "employment": null
}
```


Example of a POST employment record with a non-existent EmployeeID – 404 Not Found

```
POST https://api.xero.com/payroll.xro/2.0/employees/35cdd697-c9fc-4931-b579-a18cb8b6fe15/employment
```


Request Body

```
{
  "payrollCalendarID": "e53462af-602c-47b9-9498-892834f96c85",
  "startDate": "2017-10-1"
}
```


Response Body

```
{
    "id": "07c1c934-7649-3429-98ff-d51e6b82317d",
    "providerName": "!YLT5Y",
    "dateTimeUTC": "2017-10-30T03:56:56.6719882",
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
    "employment": null
}
```


### Contracts validation examples

Example of a POST employment record without a contract – 400 Bad Request

```
POST https://api.xero.com/payroll.xro/2.0/employees/35cdd697-c9fc-4931-b579-a18cb8b6fe15/employment
```


Request Body

```
{
  "startDate": "2025-04-15T00:00:00",
  "payrollCalendarID": "78d5c59f-16e9-4805-bfeb-6b5ebd4a697e",
  "niCategories": [
    {
      "niCategory": "A",
      "startDate": "2025-04-01"
    }
  ],
  "employeeNumber": 331,
  "nationalInsuranceNumber": "AB123456C",
  "engagementType": null,
  "fixedTermEndDate": null
}
```


Response Body

```
{
    "id": "07c1c934-7649-3429-98ff-d51e6b82317d",
    "providerName": "local",
    "dateTimeUTC": "2025-10-15T03:56:56.6719882",
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
            "name": "EmploymentContract",
            "reason": "Contract is required."
          }
        ],
        "invalidObjects": null
    },
    "employment": null
}
```


Example of a POST employment record with the first contract start date not the same as the employment start date – 400 Bad Request

```
POST https://api.xero.com/payroll.xro/2.0/employees/35cdd697-c9fc-4931-b579-a18cb8b6fe15/employment
```


Request Body

```
{
  "startDate": "2025-04-15T00:00:00",
  "payrollCalendarID": "78d5c59f-16e9-4805-bfeb-6b5ebd4a697e",
  "niCategories": [
    {
      "niCategory": "A",
      "startDate": "2025-04-01"
    }
  ],
  "employeeNumber": 331,
  "nationalInsuranceNumber": "AB123456C",
  "engagementType": null,
  "fixedTermEndDate": null,
  "contracts": [
    {
      "isFixedTerm": false,
      "employmentStatus": "Employee",
      "contractType": "FullTime",
      "startDate": "2025-04-01T00:00:00",
      "fixedTermEndDate": null
    }
  ]
}
```


Response Body

```
{
    "id": "07c1c934-7649-3429-98ff-d51e6b82317d",
    "providerName": "local",
    "dateTimeUTC": "2025-10-15T03:56:56.6719882",
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
            "name": "StartDate",
            "reason": "The contract start date cannot be earlier than the employment start date."
          }
        ],
        "invalidObjects": null
    },
    "employment": null
}
```


Example of a POST employment record with a contract type that is not supported. In this scenario the Full Time contract type is not supported for a Worker employment status – 400 Bad Request

```
POST https://api.xero.com/payroll.xro/2.0/employees/35cdd697-c9fc-4931-b579-a18cb8b6fe15/employment
```


Request Body

```
{
  "startDate": "2025-04-15T00:00:00",
  "payrollCalendarID": "78d5c59f-16e9-4805-bfeb-6b5ebd4a697e",
  "niCategories": [
    {
      "niCategory": "A",
      "startDate": "2025-04-01"
    }
  ],
  "employeeNumber": 331,
  "nationalInsuranceNumber": "AB123456C",
  "engagementType": null,
  "fixedTermEndDate": null,
  "contracts": [
    {
      "isFixedTerm": false,
      "employmentStatus": "Worker",
      "contractType": "FullTime",
      "startDate": "2025-04-01T00:00:00",
      "fixedTermEndDate": null
    }
  ]
}
```


Response Body

```
{
    "id": "07c1c934-7649-3429-98ff-d51e6b82317d",
    "providerName": "local",
    "dateTimeUTC": "2025-10-15T03:56:56.6719882",
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
            "name": "ContractType",
            "reason": "Contract type not supported."
          }
        ],
        "invalidObjects": null
    },
    "employment": null
}
```


Example of a POST employment record with an Employment Status that is invalid. In this scenario the EmploymentStatus is missing – 400 Bad Request

```
POST https://api.xero.com/payroll.xro/2.0/employees/35cdd697-c9fc-4931-b579-a18cb8b6fe15/employment
```


Request Body

```
{
  "startDate": "2025-04-15T00:00:00",
  "payrollCalendarID": "78d5c59f-16e9-4805-bfeb-6b5ebd4a697e",
  "niCategories": [
    {
      "niCategory": "A",
      "startDate": "2025-04-01"
    }
  ],
  "employeeNumber": 331,
  "nationalInsuranceNumber": "AB123456C",
  "engagementType": null,
  "fixedTermEndDate": null,
  "contracts": [
    {
      "isFixedTerm": false,
      "contractType": "FullTime",
      "startDate": "2025-04-01T00:00:00",
      "fixedTermEndDate": null
    }
  ]
}
```


Response Body

```
{
    "id": "07c1c934-7649-3429-98ff-d51e6b82317d",
    "providerName": "local",
    "dateTimeUTC": "2025-10-15T03:56:56.6719882",
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
            "name": "EmploymentStatus",
            "reason": "Employment status invalid."
          }
        ],
        "invalidObjects": null
    },
    "employment": null
}
```


Example of a POST employment record with a Fixed Term contract and missing Fixed Term End Date – 400 Bad Request

```
POST https://api.xero.com/payroll.xro/2.0/employees/35cdd697-c9fc-4931-b579-a18cb8b6fe15/employment
```


Request Body

```
{
  "startDate": "2025-04-15T00:00:00",
  "payrollCalendarID": "78d5c59f-16e9-4805-bfeb-6b5ebd4a697e",
  "niCategories": [
    {
      "niCategory": "A",
      "startDate": "2025-04-01"
    }
  ],
  "employeeNumber": 331,
  "nationalInsuranceNumber": "AB123456C",
  "engagementType": null,
  "fixedTermEndDate": null,
  "contracts": [
    {
      "isFixedTerm": true,
      "employmentStatus": "Employee",
      "contractType": "FullTime",
      "startDate": "2025-04-01T00:00:00",
      "fixedTermEndDate": null
    }
  ]
}
```


Response Body

```
{
    "id": "07c1c934-7649-3429-98ff-d51e6b82317d",
    "providerName": "local",
    "dateTimeUTC": "2025-10-15T03:56:56.6719882",
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
            "name": "FixedTermEndDate",
            "reason": "End date is required."
          }
        ],
        "invalidObjects": null
    },
    "employment": null
}
```


Example of a POST employment record with a Fixed Term contract and end date is before the start date – 400 Bad Request

```
POST https://api.xero.com/payroll.xro/2.0/employees/35cdd697-c9fc-4931-b579-a18cb8b6fe15/employment
```


Request Body

```
{
  "startDate": "2025-04-15T00:00:00",
  "payrollCalendarID": "78d5c59f-16e9-4805-bfeb-6b5ebd4a697e",
  "niCategories": [
    {
      "niCategory": "A",
      "startDate": "2025-04-01"
    }
  ],
  "employeeNumber": 331,
  "nationalInsuranceNumber": "AB123456C",
  "engagementType": null,
  "fixedTermEndDate": null,
  "contracts": [
    {
      "isFixedTerm": true,
      "employmentStatus": "Employee",
      "contractType": "FullTime",
      "startDate": "2025-04-15T00:00:00",
      "fixedTermEndDate": "2025-04-14T00:00:00"
    }
  ]
}
```


Response Body

```
{
    "id": "07c1c934-7649-3429-98ff-d51e6b82317d",
    "providerName": "local",
    "dateTimeUTC": "2025-10-15T03:56:56.6719882",
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
            "name": "FixedTermEndDate",
            "reason": "End date must be later than the effective date."
          }
        ],
        "invalidObjects": null
    },
    "employment": null
}
```
