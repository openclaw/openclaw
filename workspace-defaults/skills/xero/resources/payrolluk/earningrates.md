# Earning Rates

## Overview


|  |  |
| --- | --- |
| URLs | `https://api.xero.com/payroll.xro/2.0/earningsRates`<br>`https://api.xero.com/payroll.xro/2.0/earningsRates/{EarningRateID}` |
| Supported Methods | GET, POST |
| Description | Allows you to retrieve payroll earning rates in a Xero organisation <br>Allows you to retrieve details of an earning rate in a Xero organisation <br>Allows you to add an earning rate in a Xero organisation |

## GET Earning Rates


`GET https://api.xero.com/payroll.xro/2.0/earningsRates`

Retrieve all earning rates

### Optional Parameters

|  |  |
| --- | --- |
| Page | Page number which specifies the set of records to retrieve. <br>By default the number of the records per set is 100. <br>Example: `https://api.xero.com/payroll.xro/2.0/earningsRates?page=2` to get the second set of the records. <br>When page value is not a number or a negative number, by default, the first set of records is returned. |

### Elements of EarningRate

|  |  |
| --- | --- |
| EarningsRateID | Xero unique identifier for an earning rate |
| Name | Name of the earning rate |
| EarningsType | Indicates how an employee will be paid when taking this type of earning |
| RateType | Indicates the type of the earning rate |
| TypeOfUnits | The type of units used to record earnings |
| CurrentRecord | Indicates whether an earning type is active |
| ExpenseAccountID | The account that will be used for the earnings rate |
| RatePerUnit | Default rate per unit (optional). Only applicable if RateType is RatePerUnit |
| MultipleOfOrdinaryEarningsRate | This is the multiplier used to calculate the rate per unit, based on the employee’s ordinary earnings rate. For example, for time and a half enter 1.5. Only applicable if RateType is MultipleOfOrdinaryEarningsRate |
| FixedAmount | Optional Fixed Rate Amount. Applicable for FixedAmount Rate |

Example response for GET Earning Rates – 200 OK Response

```
GET https://api.xero.com/payroll.xro/2.0/earningsRates
```


```
{
    "id": "65b3e771-8a4a-0345-5136-1f59d64caaf2",
    "providerName": "!YLT5Y",
    "dateTimeUTC": "2018-01-09T03:05:56.9582694",
    "httpStatusCode": "OK",
    "pagination": {
        "page": 1,
        "pageSize": 100,
        "pageCount": 1,
        "itemCount": 13
    },
    "problem": null,
    "earningsRates": [
        {
            "earningsRateID": "49400c4f-1c90-46f3-9cd3-b06dca84d253",
            "name": "Regular Hours",
            "earningsType": "RegularEarnings",
            "rateType": "RatePerUnit",
            "typeOfUnits": "hours",
            "currentRecord": true,
            "expenseAccountID": "f30eb980-23b1-4e3e-b707-a15fe4be1182",
            "ratePerUnit": 65
        },
        {
            "earningsRateID": "10414aef-a57d-478a-81e4-160b65222972",
            "name": "Overtime Hours",
            "earningsType": "OvertimeEarnings",
            "rateType": "MultipleOfOrdinaryEarningsRate",
            "typeOfUnits": null,
            "currentRecord": true,
            "expenseAccountID": "f30eb980-23b1-4e3e-b707-a15fe4be1182",
            "multipleOfOrdinaryEarningsRate": 1.5

        },
        {
            "earningsRateID": "c986682b-b732-4a96-ab11-00a763d33928",
            "name": "Bonus",
            "earningsType": "Bonus",
            "rateType": "FixedAmount",
            "typeOfUnits": null,
            "currentRecord": true,
            "expenseAccountID": "f30eb980-23b1-4e3e-b707-a15fe4be1182",
            "fixedAmount": 6500
        },
        {
            "earningsRateID": "c3da8f29-30cf-4034-b911-02a49f58c5d2",
            "name": "Statutory Adoption Pay",
            "earningsType": "StatutoryAdoptionPay",
            "rateType": "FixedAmount",
            "typeOfUnits": null,
            "currentRecord": true,
            "expenseAccountID": "f30eb980-23b1-4e3e-b707-a15fe4be1182",
            "fixedAmount": 60000
        },
        {
            "earningsRateID": "41f7465f-f08a-4b56-879f-3750dfa544b0",
            "name": "Statutory Maternity Pay",
            "earningsType": "StatutoryMaternityPay",
            "rateType": "FixedAmount",
            "typeOfUnits": null,
            "currentRecord": true,
            "expenseAccountID": "f30eb980-23b1-4e3e-b707-a15fe4be1182",
            "fixedAmount": 15000.00
        },
        {
            "earningsRateID": "a3ce0279-161d-4cd3-931c-938be2274bc7",
            "name": "Statutory Paternity Pay",
            "earningsType": "StatutoryPaternityPay",
            "rateType": "FixedAmount",
            "typeOfUnits": null,
            "currentRecord": true,
            "expenseAccountID": "f30eb980-23b1-4e3e-b707-a15fe4be1182",
            "fixedAmount": 2500
        },
        {
            "earningsRateID": "9398faeb-5e1a-4fcc-9bec-c2e4d413f3ce",
            "name": "Statutory Shared Parental Pay",
            "earningsType": "StatutorySharedParentalPay",
            "rateType": "FixedAmount",
            "typeOfUnits": null,
            "currentRecord": true,
            "expenseAccountID": "f30eb980-23b1-4e3e-b707-a15fe4be1182",
            "fixedAmount": 6000
        },
        {
            "earningsRateID": "41698b22-b093-4972-8c6a-99ebb162ad4c",
            "name": "Statutory Sick Pay",
            "earningsType": "StatutorySickPay",
            "rateType": "FixedAmount",
            "typeOfUnits": null,
            "currentRecord": true,
            "expenseAccountID": "f30eb980-23b1-4e3e-b707-a15fe4be1182",
            "fixedAmount": 800
        },
        {
            "earningsRateID": "bddd8a6e-7d9a-4661-bd74-f58050f68ac6",
            "name": "Statutory Bereavement Pay",
            "earningsType": "StatutoryBereavementPay",
            "rateType": "FixedAmount",
            "typeOfUnits": null,
            "currentRecord": true,
            "expenseAccountID": "f30eb980-23b1-4e3e-b707-a15fe4be1182",
            "fixedAmount": 1200
        },
        {
            "earningsRateID": "f8db6407-d340-4da1-975d-929b4ecc7d98",
            "name": "Statutory Neonatal Care Pay",
            "earningsType": "StatutoryNeonatalCarePay",
            "rateType": "FixedAmount",
            "typeOfUnits": null,
            "currentRecord": true,
            "expenseAccountID": "f30eb980-23b1-4e3e-b707-a15fe4be1182",
            "fixedAmount": 2500
        }
        {
            "earningsRateID": "f3b6a348-e828-41e1-b613-19e09303dbbd",
            "name": "Statutory Adoption Pay (Non Pensionable)",
            "earningsType": "StatutoryAdoptionPay",
            "rateType": "FixedAmount",
            "typeOfUnits": null,
            "currentRecord": true,
            "expenseAccountID": "f30eb980-23b1-4e3e-b707-a15fe4be1182",
            "fixedAmount": 60000
        },
        {
            "earningsRateID": "73250ef9-dacd-49b9-87dd-c180bb7b4268",
            "name": "Statutory Maternity Pay (Non Pensionable)",
            "earningsType": "StatutoryMaternityPay",
            "rateType": "FixedAmount",
            "typeOfUnits": null,
            "currentRecord": true,
            "expenseAccountID": "f30eb980-23b1-4e3e-b707-a15fe4be1182",
            "fixedAmount": 15000.00
        },
        {
            "earningsRateID": "af973496-eeff-42d0-b415-e97a6eb9ccd3",
            "name": "Statutory Paternity Pay (Non Pensionable)",
            "earningsType": "StatutoryPaternityPay",
            "rateType": "FixedAmount",
            "typeOfUnits": null,
            "currentRecord": true,
            "expenseAccountID": "f30eb980-23b1-4e3e-b707-a15fe4be1182",
            "fixedAmount": 2500
        },
        {
            "earningsRateID": "e735a40f-17e2-44e8-8625-240ee74be510",
            "name": "Statutory Shared Parental Pay (Non Pensionable)",
            "earningsType": "StatutorySharedParentalPay",
            "rateType": "FixedAmount",
            "typeOfUnits": null,
            "currentRecord": true,
            "expenseAccountID": "f30eb980-23b1-4e3e-b707-a15fe4be1182",
            "fixedAmount": 6000
        },
        {
            "earningsRateID": "6db0609c-b27d-4b85-9720-06610f9384f5",
            "name": "Statutory Sick Pay (Non Pensionable)",
            "earningsType": "StatutorySickPay",
            "rateType": "FixedAmount",
            "typeOfUnits": null,
            "currentRecord": true,
            "expenseAccountID": "f30eb980-23b1-4e3e-b707-a15fe4be1182",
            "fixedAmount": 800
        },
        {
            "earningsRateID": "ea434baa-23f1-462c-a12d-7dcf011a228e",
            "name": "Statutory Bereavement Pay (Non Pensionable)",
            "earningsType": "StatutoryBereavementPay",
            "rateType": "FixedAmount",
            "typeOfUnits": null,
            "currentRecord": true,
            "expenseAccountID": "f30eb980-23b1-4e3e-b707-a15fe4be1182",
            "fixedAmount": 1200
        },
        {
            "earningsRateID": "3b4fee5e-05f0-4f05-9271-e24ae076287a",
            "name": "Statutory Neonatal Care Pay (Non Pensionable)",
            "earningsType": "StatutoryNeonatalCarePay",
            "rateType": "FixedAmount",
            "typeOfUnits": null,
            "currentRecord": true,
            "expenseAccountID": "f30eb980-23b1-4e3e-b707-a15fe4be1182",
            "fixedAmount": 2500
        }
    ]
}
```


## GET Earning Rate By ID


`GET https://api.xero.com/payroll.xro/2.0/earningsRates/{EarningsRateID}`

Retrieve the details of an earning rate

### Elements of EarningRate

|  |  |
| --- | --- |
| EarningsRateID | Xero unique identifier for an earning rate |
| Name | Name of the earning rate |
| EarningsType | Indicates how an employee will be paid when taking this type of earning |
| RateType | Indicates the type of the earning rate |
| TypeOfUnits | The type of units used to record earnings |
| CurrentRecord | Indicates whether an earning type is active |
| ExpenseAccountID | The account that will be used for the earnings rate |

Example response for GET Earning Rate by ID – 200 OK Response

```
GET https://api.xero.com/payroll.xro/2.0/earningsRates/cb73c009-e0ba-164a-259e-4ec1d3338ab8
```


```
{
    "id": "cb73c009-e0ba-164a-259e-4ec1d3338ab8",
    "providerName": "!YLT5Y",
    "dateTimeUTC": "2018-01-11T04:54:39.8348597",
    "httpStatusCode": "OK",
    "pagination": null,
    "problem": null,
    "earningsRate": {
        "earningsRateID": "7ce2c7d3-6503-451a-a8da-751baccf3aa1",
        "name": "Regular Hours",
        "earningsType": "RegularEarnings",
        "rateType": "RatePerUnit",
        "typeOfUnits": "hours",
        "currentRecord": true,
        "expenseAccountID": "f30eb980-23b1-4e3e-b707-a15fe4be1182"
    }
}
```


## POST an Earnings Rate


`POST https://api.xero.com/payroll.xro/2.0/earningsRates`

Add an earnings rate

### Elements of an Earnings Rate in the Request

_The following elements are **required** to add a new earnings rate_

|  |  |
| --- | --- |
| Name | Name of the earning rate |
| EarningsType | Indicates how an employee will be paid when taking this type of earning |
| RateType | Indicates the type of the earning rate |
| TypeOfUnits | The type of units used to record earnings. Not Required for Earnings Type Fixed Amount |
| ExpenseAccountID | The account that will be used for the earnings rate |

_The following is **optional** when creating a new earnings rate._

|  |  |
| --- | --- |
| CurrentRecord | Indicates whether an earning type is active |
| RatePerUnit | Default rate per unit (optional). Only applicable if RateType is RatePerUnit |
| MultipleOfOrdinaryEarningsRate | This is the multiplier used to calculate the rate per unit, based on the employee’s ordinary earnings rate. For example, for time and a half enter 1.5. Only applicable if RateType is MultipleOfOrdinaryEarningsRate |
| FixedAmount | Optional Fixed Rate Amount. Applicable for FixedAmount Rate |

### Earnings Types allowed

|  |
| --- |
| `OvertimeEarnings` |
| `Allowance` |
| `RegularEarnings` |
| `Commission` |
| `Bonus` |
| `Tips(Direct)` |
| `Tips(Non-Direct)` |
| `Backpay` |
| `OtherEarnings` |
| `LumpSum` |
| `TerminationPay` |

### Rate Types allowed for each Earnings Type

|  |  |
| --- | --- |
| Earnings Type | Rate Type |
| OvertimeEarnings | RatePerUnit; MultipleOfOrdinaryEarningsRate |
| Allowance | FixedAmount; RatePerUnit |
| RegularEarnings | RatePerUnit |
| Commission | FixedAmount |
| Bonus | FixedAmount |
| Tips(Direct) | FixedAmount |
| Tips(Non-Direct) | FixedAmount |
| Backpay | FixedAmount |
| OtherEarnings | RatePerUnit |
| LumpSum | FixedAmount |
| TerminationPay | FixedAmount |

Example for POST a Earnings Rate with minimum elements required – 200 OK Response

```
POST https://api.xero.com/payroll.xro/2.0/earningsRates
```


Request Body

```
{
    "name": "Regular Hours",
    "earningsType": "RegularEarnings",
    "rateType": "RatePerUnit",
    "ExpenseAccountID": "f30eb980-23b1-4e3e-b707-a15fe4be1182"
}
```


Response Body

```
{
    "id": "b8b53ce8-f735-4e4a-9d94-ae89c9e111eb",
    "name": "Regular Hours",
    "earningsType": "RegularEarnings",
    "typeOfUnits": "AnyTyhlaksdaldspe",
    "rateType": "RatePerUnit",
    "currentRecord": true,
    "expenseAccountID": "f30eb980-23b1-4e3e-b707-a15fe4be1182"
}
```


Example for POST a Earnings Rate – 400 Bad Request Response

```
POST https://api.xero.com/payroll.xro/2.0/earningsRates
```


Request Body

```
{
    "name": "Regular Hours with Invalid expense account",
    "earningsType": "RegularEarnings",
    "rateType": "RatePerUnit",
    "ExpenseAccountID": "f30eb980-23b1-4e3e-b707-a15fe4be1182"
}
```


Response Body

```
{
    "type": "application/problem+json",
    "title": "BadRequest",
    "status": 400,
    "detail": "Expense account with ExpenseAccountID f30eb980-23b1-4e3e-b707-a15fe1be1182 cannot be found",
    "instance": null,
    "invalidFields": null
}
```
