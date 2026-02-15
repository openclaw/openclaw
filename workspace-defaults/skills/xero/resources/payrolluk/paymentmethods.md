# Payment Methods

## Overview


|  |  |
| --- | --- |
| URL | `https://api.xero.com/payroll.xro/2.0/employees/{employeeID}/paymentMethods` |
| Supported Methods | GET, POST |
| Description | Allows you to retrieve and add payment method for a payroll employee |

## GET Payment Method


`GET https://api.xero.com/payroll.xro/2.0/employees/{employeeID}/paymentMethods`

Retrieves payment method for an active employee

### Elements for PaymentMethod

|  |  |
| --- | --- |
| PaymentMethod | See Payment Method codes |
| BankAccounts | A list of bank accounts for the payment method. See BankAccount. |

### Elements for BankAccount

|  |  |
| --- | --- |
| AccountName | Bank account name |
| AccountNumber | Bank account number |
| SortCode | Bank account sort code |

Example response for GET Employee Payment Method – 200 OK Response

```
GET https://api.xero.com/payroll.xro/2.0/employees/eae7cab3-515e-474b-aa95-78dc4f9c6e12/paymentMethods
```


```
{
   "id": "58c58d87-b077-68c9-a1d5-a5e3acbc4cdf",
   "providerName": "Test",
   "dateTimeUTC": "2017-09-07T06:08:04.8109255",
   "httpStatusCode": "OK",
   "pagination": null,
   "problem": null,
   "paymentMethod": {
      "paymentMethod": "Electronically",
      "bankAccounts": [
         {
            "accountName": "Charlotte Danes",
            "accountNumber": "45678923",
            "sortCode": "123411"
         }
      ]
   }
}
```


Example response for GET Employee Payment Method – 404 Not Found Response

```
GET https://api.xero.com/payroll.xro/2.0/employees/eae7cab3-515e-474b-aa95-78dc4f9c6e10/paymentMethods
```


```
{
    "id": "58c58d87-b077-68c9-a1d5-a5e3acbc4cdf",
    "providerName": "Test",
    "dateTimeUTC": "2017-09-07T06:11:59.5666462",
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
    "paymentMethod": null
}
```


## POST Payment Method


`POST https://api.xero.com/payroll.xro/2.0/employees/{employeeID}/paymentMethods`

Adds payment method for an active employee

### Elements for PaymentMethod in the Request

|  |  |
| --- | --- |
| PaymentMethod | **Required**. See Payment Method codes |
| BankAccounts | A list of bank accounts for the payment method. When PaymentMethod is _Electronically_, only ONE bank account is **accepted and required**. When PaymentMethod is _Cheque_ or _Manual_, **optional and ignored**. See BankAccount. |

### Elements for BankAccount

_The following elements are **required** only when adding **Electronically** payment method for an employee_

|  |  |
| --- | --- |
| AccountName | Bank account name (max length = 32) |
| AccountNumber | Bank account number (digits only; max length = 8) |
| SortCode | Bank account sort code (6 digits) |

Example for POST a Payment Method – 200 OK Response

```
POST https://api.xero.com/payroll.xro/2.0/employees/eae7cab3-515e-474b-aa95-78dc4f9c6e12/paymentMethods
```


Request Body

```
{
   "paymentMethod": "Electronically",
   "bankAccounts": [
      {
         "accountName": "Charlotte Danes",
         "accountNumber": "45678923",
         "sortCode": "123411"
      }
   ]
}
```


Response Body

```
{
   "id": "58c58d87-b077-68c9-a1d5-a5e3acbc4cdf",
   "providerName": "Test",
   "dateTimeUTC": "2017-09-07T06:29:32.4523868",
   "httpStatusCode": "OK",
   "pagination": null,
   "problem": null,
   "paymentMethod": {
      "paymentMethod": "Electronically",
      "bankAccounts": [
         {
            "accountName": "Charlotte Danes",
            "accountNumber": "45678923",
            "sortCode": "123411"
         }
      ]
   }
}
```


Example for POST a Payment Method – 400 Bad Request Response

```
POST https://api.xero.com/payroll.xro/2.0/employees/eae7cab3-515e-474b-aa95-78dc4f9c6e12/paymentMethods
```


Request Body

```
{
   "paymentMethod": "Electronically",
   "bankAccounts": [
      {
         "accountName": "Charlotte Danes",
         "accountNumber": "45678923",
         "sortCode": "123411"
      },
      {
         "accountName": "Charlotte Danes",
         "accountNumber": "45678922",
         "sortCode": "123412"
      }
   ]
}
```


Response Body

```
{
   "id": "58c58d87-b077-68c9-a1d5-a5e3acbc4cdf",
   "providerName": "Test",
   "dateTimeUTC": "2017-09-07T07:11:33.9514795",
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
            "reason": "Only one Bank Account is allowed"
         }
      ]
   },
   "paymentMethod": null
}
```
