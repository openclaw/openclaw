# Employees

## Overview


|  |  |
| --- | --- |
| URLs | `https://api.xero.com/payroll.xro/2.0/employees`<br>`https://api.xero.com/payroll.xro/2.0/employees/{employeeID}` |
| Supported Methods | GET, POST, PUT |
| Description | Allows you to retrieve payroll employees in a Xero organisation <br>Allows you to retrieve details of a payroll employee in a Xero organisation <br>Allows you to add a payroll employee in a Xero organisation <br>Allows you to update a payroll employee in a Xero organisation |
| Limitations | Once set, IsOffPayrollWorker cannot be changed |

## GET Employees


`GET https://api.xero.com/payroll.xro/2.0/employees`

Retrieves a list of active employees

### Optional Parameters

|  |  |
| --- | --- |
| Page | Page number which specifies the set of records to retrieve. <br>By default the number of the records per set is 100.<br>Example: `https://api.xero.com/payroll.xro/2.0/employees?page=2` to get the second set of the records.<br>When page value is not a number or a negative number, by default, the first set of records is returned. |
| Filter by FirstName | By default get employees will return all the employees for an organization. You can add `GET https://…/employees?filter=firstName=={First Name of an Employee}` to filter the employees by first name. |
| Filter by LastName | By default get employees will return all the employees for an organization. You can add `GET https://…/employees?filter=lastName=={Last Name of an Employee}` to filter the employees by last name. |
| Filter by FirstName and LastName | By default get employees will return all the employees for an organization. You can add `GET https://…/employees?filter=firstName=={First Name of an Employee},lastName=={Last Name of an Employee}` to filter the employees by first name and last name. |
| Filter by IsOffPayrollWorker | By default get employees will return all the employees for an organization. You can add `GET https://…/employees?filter=isOffPayrollWorker=={true or false}` to filter the employees by whether they are an off-payroll worker or not. |

### Elements for Employee

| Element name | Element description |
| --- | --- |
| EmployeeID | Xero unique identifier for the employee |
| FirstName | First name of the employee |
| LastName | Last name of the employee |
| DateOfBirth | Date of birth of the employee |
| Gender | The employee’s gender (F or M) |
| Email | Email of the employee |
| PhoneNumber | Phone number of the employee |
| StartDate | Employment start date of the employee at the time it was requested |
| IsOffPayrollWorker | Boolean – describes whether the employee is an off-payroll worker |
| Address | Employee home address |
| PayrollCalendarID | Xero unique identifier for the payroll calendar of the employee |
| UpdatedDateUTC | UTC timestamp of last update to the employee |
| CreatedDateUTC | UTC timestamp when the employee was created in Xero |
| EndDate | Employment end date of the employee at the time it was requested |
| Contracts | Employee contract and employment status information |

Example response for GET Employees – 200 OK Response

```
GET https://api.xero.com/payroll.xro/2.0/employees
```


```
{
   "id": "a1dc55a8-4132-03c0-671c-2be7e0549770",
   "providerName": "Example Provider",
   "dateTimeUTC": "2017-09-05T04:05:18.4009114",
   "httpStatusCode": "OK",
   "pagination": {
      "page": 1,
      "pageSize": 100,
      "pageCount": 1,
      "itemCount": 4
   },
   "problem": null,
   "employees": [
      {
         "employeeID": "d90457c4-f1be-4f2e-b4e3-f766390a7e30",
         "firstName": "Jack",
         "lastName": "Allan",
         "dateOfBirth": "1985-03-24T00:00:00",
         "gender": "M",
         "email": "jack.allan@email.com",
         "phoneNumber": "0401789123",
         "startDate": "2012-03-19T00:00:00",
         "isOffPayrollWorker": false,
         "address": {
             "addressLine1": "171 Midsummer Boulevard",
             "addressLine2": "Block A",
             "city": "Milton Keynes",
             "county": "Buckinghamshire",
             "postCode": "MK9 1EB"
         },
         "payrollCalendarID": "d6c1e0b8-8b15-4769-bce0-63ce17917616",
         "updatedDateUTC": "2017-06-27T04:56:03",
         "createdDateUTC": "2017-05-12T10:00:24",
         "endDate": null,
         "contracts": []
      },
      {
         "employeeID": "8082c1c1-229f-438e-aa69-da57795f868f",
         "firstName": "Charlotte",
         "lastName": "Danes",
         "dateOfBirth": "1991-01-24T00:00:00",
         "gender": "F",
         "email": null,
         "phoneNumber": null,
         "startDate": "2012-03-19T00:00:00",
         "isOffPayrollWorker": false,
         "address": {
             "addressLine1": "172 Kings Cross Road",
             "addressLine2": null,
             "city": "London",
             "county": "Greater London",
             "postCode": "WC1X 9DH"
         },
         "payrollCalendarID": null,
         "updatedDateUTC": "2017-07-06T00:17:40",
         "createdDateUTC": "2017-06-27T02:05:44",
         "endDate": "2019-03-19T00:00:00",
         "contracts": [
            {
               "publicKey": "72d71548-2800-4fb9-be6c-d496a617428c" ,
               "isFixedTerm": false,
               "employmentStatus": "Employee",
               "contractType": "PartTime",
               "startDate": "2012-03-19T00:00:00",
               "fixedTermEndDate": null
            }
         ]
      },
      {
         "employeeID": "b5987cdf-8563-4be0-9955-e8930d60f43e",
         "firstName": "Chelsea",
         "lastName": "Serati",
         "dateOfBirth": "1973-05-18T10:00:00",
         "gender": "M",
         "email": null,
         "phoneNumber": "0401234567",
         "startDate": "2012-03-19T00:00:00",
         "isOffPayrollWorker": false,
         "address": {
             "addressLine1": "171 Midsummer Boulevard",
             "addressLine2": "Block A",
             "city": "Milton Keynes",
             "county": "Buckinghamshire",
             "postCode": "MK9 1EB"
         },
         "payrollCalendarID": "c6c1e0b8-8b15-4769-bce0-63ce17917616",
         "updatedDateUTC": "2017-06-27T04:45:12",
         "createdDateUTC": "2017-05-15T16:32:12",
         "endDate": null,
         "contracts": [
            {
               "publicKey": "3a8243d5-a14a-4c06-a71b-930194928ee9",
               "isFixedTerm": false,
               "employmentStatus": "Worker",
               "contractType": "PartTime",
               "startDate": "2012-03-19T00:00:00",
               "fixedTermEndDate": null
            },
            {
               "publicKey": "ce4fe24d-bb85-4b17-a461-3e56917457d6",
               "isFixedTerm": true,
               "employmentStatus": "Employee",
               "contractType": "FullTime",
               "startDate": "2018-06-30T00:00:00",
               "fixedTermEndDate": "2026-08-01T00:00:00",
               "developmentalRoleDetails": {
                  "developmentalRolePublicKey": "05bceb91-89c0-4ecc-864c-32a874143770",
                  "startDate": "2017-11-01T00:00:00",
                  "endDate": "2026-08-01T00:00:00",
                  "developmentalRole": "Apprentice"
               }
            }
         ]
      }
   ]
}
```


Example response for GET Employees – 503 Service Unavailable Response

```
GET https://api.xero.com/payroll.xro/2.0/employees
```


```
{
   "id": "1d986f71-5abe-4ade-b62d-b4993e20abc9",
   "providerName": "Example Provider",
   "dateTimeUTC": "2017-09-06T07:21:35.751382",
   "httpStatusCode": "ServiceUnavailable",
   "pagination": null,
   "problem": {
      "type": "about:blank",
      "title": "ServiceUnavailable",
      "status": 503,
      "detail": "Service is unavailable. Try again later.",
      "instance": null,
      "invalidFields": null
   },
   "employees": null
}
```


## GET Employee By ID


`GET https://api.xero.com/payroll.xro/2.0/employees/{employeeID}`

Retrieves detailed information for an employee by its unique identifier

### Elements for Employee

| Element name | Element description |
| --- | --- |
| EmployeeID | Xero unique identifier for the employee |
| FirstName | First name of the employee |
| LastName | Last name of the employee |
| DateOfBirth | Date of birth of the employee |
| Gender | The employee’s gender (F or M) |
| Email | E-mail address of the employee |
| PhoneNumber | Phone number of the employee |
| StartDate | Employment start date of the employee at the time it was requested |
| NationalInsuranceNumber | National insurance number of the employee |
| IsOffPayrollWorker | Boolean – describes whether the employee is an off-payroll worker |
| Address | Employee home address |
| PayrollCalendarID | Xero unique identifier for the payroll calendar of the employee |
| UpdatedDateUTC | UTC timestamp of last update to the employee |
| CreatedDateUTC | UTC timestamp when the employee was created in Xero |
| NICategories | The NI Category information. See NI Category. |
| EmployeeNumber | The employment number of the employee |
| EndDate | Employment end date of the employee at the time it was requested |
| Contracts | The contract and employment status information. See Contracts. |

### Elements for Address

| Element name | Element description |
| --- | --- |
| AddressLine1 | Address line 1 for employee home address |
| AddressLine2 | Address line 2 for employee home address |
| City | City for employee home address |
| County | County for employee home address |
| PostCode | Post code for employee home address |
| County | County for employee home address |
| CountryName | Full name of the country. Defaults to United Kingdom. |

### Elements for a NI Category

| Element name | Element description |
| --- | --- |
| StartDate | Start date of the NI Category (YYYY-MM-DD) |
| NICategory | The National Insurance category code of the employee |
| DateFirstEmployedAsCivilian | Applies to category V only. The date the employee was first employed as a civilian (YYYY-MM-DD) |
| WorkplacePostcode | Applies to Freeport and Investment Zone categories only. The postcode at which NI relief is being claimed |

### Elements for a Contract

| Element name | Element description |
| --- | --- |
| PublicKey | Xero unique identifier for the contract |
| IsFixedTerm | Boolean – describes whether the contract is fixed term |
| EmploymentStatus | The employment status of the employee |
| ContractType | The contract type of the employee |
| StartDate | The contract start date of the employee |
| FixedTermEndDate | The fixed term end date of the employee |
| DevelopmentalRoleDetails | The development role details of the employee |

### Elements for a DevelopmentalRoleDetail

| Element name | Element description |
| --- | --- |
| DevelopmentalRolePublicKey | Xero unique identifier for the developmental role |
| DevelopmentalRole | The development role type of the employee - "Apprentice" is the only supported role currently |
| StartDate | The development role start date of the employee |
| EndDate | The development role end date of the employee |

Example response for GET Employee by ID – 200 OK Response

```
GET https://api.xero.com/payroll.xro/2.0/employees/d90457c4-f1be-4f2e-b4e3-f766390a7e30
```


```
{
   "id": "a1dc55a8-4132-03c0-671c-2be7e0549770",
   "providerName": "Example Provider",
   "dateTimeUTC": "2017-09-05T04:46:40.9419275",
   "httpStatusCode": "OK",
   "pagination": null,
   "problem": null,
   "employee": {
      "employeeID": "d90457c4-f1be-4f2e-b4e3-f766390a7e30",
      "title": "Mr.",
      "firstName": "Jack",
      "lastName": "Allan",
      "dateOfBirth": "1985-03-24T00:00:00",
      "gender": "M",
      "email": "jack.allan@test.com",
      "phoneNumber": "0401234567",
      "startDate": "2017-05-05T00:00:00",
      "nationalInsuranceNumber": "AB123456C",
      "isOffPayrollWorker": false,
      "address": {
         "addressLine1": "171 Midsummer Boulevard",
         "addressLine2": "Block A",
         "city": "Milton Keynes",
         "county": "Buckinghamshire",
         "countryName": "UNITED KINGDOM",
         "postCode": "MK9 1EB"
      },
      "payrollCalendarID": "d6c1e0b8-8b15-4769-bce0-63ce17917616",
      "updatedDateUTC": "2017-06-27T04:56:03",
      "createdDateUTC": "2017-05-12T10:00:24",
      "niCategories": [
        {
          "startDate": "2020-05-01T00:00:00",
          "niCategory": "A"
        },
        {
          "startDate": null,
          "niCategory": "F",
          "dateFirstEmployedAsCivilian": null,
          "workplacePostcode": "MK9 1EB"
        }
      ],
      "employeeNumber": "2",
      "endDate": "2018-05-05T00:00:00",
      "contracts": [
        {
          "publicKey": "d6c1e0b8-8b15-4769-bce0-63ce17917616",
          "isFixedTerm": false,
          "employmentStatus": "Employee",
          "contractType": "FullTime",
          "startDate": "2017-05-05T00:00:00",
          "fixedTermEndDate": null
        }
      ]
   }
}
```


Example response for GET Employee by ID – 404 Not Found Response

```
GET https://api.xero.com/payroll.xro/2.0/employees/d90457c4-f1be-4f2e-b4e3-f766390a7e31
```


```
{
   "id": "a1dc55a8-4132-03c0-671c-2be7e0549770",
   "providerName": "Example Provider",
   "dateTimeUTC": "2017-09-05T05:18:06.2263195",
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
   "employee": null
}
```


## Post an Employee


`POST https://api.xero.com/payroll.xro/2.0/employees`

Adds an employee

### Elements for Employee in the Request

_The following elements are **required** to add a new employee_

| Element name | Element description |
| --- | --- |
| Title | Title of the employee (max length = 35) |
| FirstName | First name of the employee (max length = 35) |
| LastName | Last name of the employee (max length = 35) |
| DateOfBirth | Date of birth of the employee (YYYY-MM-DD) |
| Gender | The employee’s gender (F or M) |
| Address | Employee home address |

_The following elements are **optional** when adding a new employee_

| Element name | Element description |
| --- | --- |
| IsOffPayrollWorker | Boolean - describes whether the employee is an off-payroll worker <br>Cannot be modified after initial creation. <br>If not specified, set to false. |
| Email | Email of the employee |
| PhoneNumber | Phone number of the employee |
| NationalInsuranceNumber | The National Insurance Number of the employee |

### Elements for Address in the Request

_The following elements are **required** to add a new employee_

| Element name | Element description |
| --- | --- |
| AddressLine1 | Address line 1 for employee home address (max length = 35) |
| City | City for employee home address (max length = 50) |
| PostCode | Post code for employee home address (max length = 8) |

_The following elements are **optional** when adding a new employee_

| Element name | Element description |
| --- | --- |
| AddressLine2 | Address line 2 for employee home address |
| County | County for employee home address |
| CountryName | Full name of the country. Defaults to United Kingdom. |

Example for POST an Employee with minimum elements required – 200 OK Response

```
POST https://api.xero.com/payroll.xro/2.0/employees
```


Request Body

```
{
  "title": "Mr.",
  "firstName": "Edgar",
  "lastName": "Allan Po",
  "dateOfBirth": "1985-03-24",
  "gender": "M",
  "email": "tester@gmail.com",
  "phoneNumber": "0400123456",
  "isOffPayrollWorker": false,
  "address": {
    "addressLine1": "171 Midsummer",
    "city": "Milton Keynes",
    "postCode": "MK9 1EB"
  },
  "nationalInsuranceNumber": "AB123456C"
}
```


Response Body

```
{
  "id": "9414291b-a8c6-08fa-b165-9b30b1e6aab5",
  "providerName": "!YLT5Y",
  "dateTimeUTC": "2018-04-09T05:15:18.1011141",
  "httpStatusCode": "OK",
  "pagination": null,
  "problem": null,
  "employee": {
      "employeeID": "d17e008e-3381-45c0-b50c-2fab7757e503",
      "title": "Mr.",
      "firstName": "Edgar",
      "lastName": "Allan Po",
      "dateOfBirth": "1985-03-24T00:00:00",
      "gender": "M",
      "email": "tester1@gmail.com",
      "phoneNumber": "0400123456",
      "nationalInsuranceNumber": "AB123456C",
      "isOffPayrollWorker": false,
      "address": {
          "addressLine1": "171 Midsummer",
          "addressLine2": null,
          "city": "Milton Keynes",
          "county": null,
          "countryName": "UNITED KINGDOM",
          "postCode": "MK9 1EB"
      },
      "payrollCalendarID": null,
      "updatedDateUTC": "2017-05-12T10:00:24",
      "createdDateUTC": "2017-05-12T10:00:24",
      "endDate": null
  }
}
```


Example for POST an Employee – 400 Bad Request Response

```
POST https://api.xero.com/payroll.xro/2.0/employees
```


```
Empty Request Body
```


Response Body

```
{
   "id": "80cd3b89-fa6c-98f1-4ee9-19062cbe0600",
   "providerName": "Example Provider",
   "dateTimeUTC": "2017-09-07T01:55:21.2138205",
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
            "name": "DateOfBirth",
            "reason": "The Date of Birth is required."
         },
         {
            "name": "Title",
            "reason": "The Title is required."
         },
         {
            "name": "FirstGivenName",
            "reason": "The First Name is required."
         },
         {
            "name": "Surname",
            "reason": "The Last Name is required."
         },
         {
            "name": "Gender",
            "reason": "The Gender is required."
         },
         {
            "name": "City",
            "reason": "The Town/City is required."
         },
         {
            "name": "PostCode",
            "reason": "The Postcode is required."
         },
         {
            "name": "AddressLine1",
            "reason": "The Address is required."
         }
      ]
   },
   "employee": null
}
```


## Put an Employee


PUT [https://api.xero.com/payroll.xro/2.0/employees/{employeeID}](https://api.xero.com/payroll.xro/2.0/employees/%7BemployeeID%7D)

Update an employee

### Elements for Employee in the Request

_The following elements are **required** to update an employee_

| Element name | Element description |
| --- | --- |
| Title | Title of the employee (max length = 35) |
| FirstName | First name of the employee (max length = 35) |
| LastName | Last name of the employee (max length = 35) |
| DateOfBirth | Date of birth of the employee (YYYY-MM-DD) |
| Gender | The employee’s gender (F or M) |
| Address | Employee home address |

_The following elements are **optional** when updating an employee_

| Element name | Element description |
| --- | --- |
| Email | Email of the employee |
| PhoneNumber | Phone number of the employee |
| NationalInsuranceNumber | The National Insurance Number of the employee |

### Elements for Address in the Request

_The following elements are **required** to update an employee_

| Element name | Element description |
| --- | --- |
| AddressLine1 | Address line 1 for employee home address (max length = 35) |
| City | City for employee home address (max length = 50) |
| PostCode | Post code for employee home address (max length = 8) |

_The following elements are **optional** when adding a new employee_

| Element name | Element description |
| --- | --- |
| AddressLine2 | Address line 2 for employee home address |
| County | County for employee home address |
| CountryName | Full name of the country. Defaults to United Kingdom. |

Example for PUT an Employee with minimum elements required – 200 OK Response

```
PUT https://api.xero.com/payroll.xro/2.0/employees/d90457c4-f1be-4f2e-b4e3-f766390a7e30
```


Request Body

```
{
  "title": "Mr.",
  "firstName": "TestDataUK",
  "lastName": "Tester",
  "dateOfBirth": "1992-11-22T00:00:00",
  "gender": "M",
  "email": "tester@gmail.com",
  "phoneNumber": "0400123456",
  "startDate": null,
  "address": {
    "addressLine1": "171 Midsummer",
    "addressLine2": "Address line 2",
    "city": "Milton Keyness",
    "postCode": "MK9 1EB"
  },
  "payrollCalendarID": null,
  "nationalInsuranceNumber": "AB123456C"
}
```


Response Body

```
{
  "id": "9414291b-a8c6-08fa-b165-9b30b1e6aab5",
  "providerName": "!YLT5Y",
  "dateTimeUTC": "2018-04-09T05:10:51.3504472",
  "httpStatusCode": "OK",
  "pagination": null,
  "problem": null,
  "employee": {
      "employeeID": "07f0f9fc-cc95-46ac-9a8a-aa03779f2bde",
      "title": "Mr.",
      "firstName": "TestDataUK",
      "lastName": "Tester",
      "dateOfBirth": "1992-11-22T00:00:00",
      "gender": "M",
      "email": "tester@gmail.com",
      "phoneNumber": "0400123456",
      "startDate": null,
      "nationalInsuranceNumber": "AB123456C",
      "isOffPayrollWorker": false,
      "address": {
         "addressLine1": "171 Midsummer",
         "addressLine2": "Address line 2",
         "city": "Milton Keyness",
         "county": null,
         "countryName": "UNITED KINGDOM",
         "postCode": "MK9 1EB"
      },
      "payrollCalendarID": null,
      "updatedDateUTC": "2017-06-27T04:56:03",
      "createdDateUTC": "2017-05-12T10:00:24",
      "endDate": null
  }
}
```


Example for PUT an Employee – 400 Bad Request Response

```
PUT https://api.xero.com/payroll.xro/2.0/employees/d90457c4-f1be-4f2e-b4e3-f766390a7e30
```


```
Empty Request Body
```


Response Body

```
{
   "id": "656244e6-ff7b-dd43-dd60-4fa78d6efd52",
   "providerName": "Test",
   "dateTimeUTC": "2017-11-22T05:42:01.0603496",
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
               "name": "DateOfBirth",
               "reason": "The Date of Birth is required."
         },
         {
               "name": "Title",
               "reason": "The Title is required."
         },
         {
               "name": "FirstName",
               "reason": "The First Name is required."
         },
         {
               "name": "LastName",
               "reason": "The Last Name is required."
         },
         {
               "name": "Gender",
               "reason": "The Gender is required."
         },
         {
               "name": "City",
               "reason": "The Town/City is required."
         },
         {
               "name": "PostCode",
               "reason": "The Postcode is required."
         },
         {
               "name": "AddressLine1",
               "reason": "The Address is required."
         }
      ]
   },
   "employee": null
}
```
