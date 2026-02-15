# Earnings Orders

## Overview


|  |  |
| --- | --- |
| URL | `https://api.xero.com/payroll.xro/2.0/earningsOrders` |
| Methods Supported | GET |
| Description | Allows you to retrieve all the earnings orders (statutory deductions) in Payroll for a Xero organisation. <br>Allows you to retrieve details of an earnings order (statutory deduction) in a Xero organisation |

## GET All Earnings Orders (Statutory Deductions)


`GET https://api.xero.com/payroll.xro/2.0/earningsOrders`

Retrieves all the earnings orders for an organisation

### Optional Parameters

|  |  |
| --- | --- |
| Page | Page number which specifies the set of records to retrieve. <br>By default the number of the records per set is 100. <br>Example: `https://api.xero.com/payroll.xro/2.0/earningsOrders?page=2` to get the second set of the records. <br>When page value is not a number or a negative number, by default, the first set of records is returned. |

### Elements for Earnings Orders (Statutory Deductions)

|  |  |
| --- | --- |
| Id | The Xero identifier for earnings order |
| Name | Name of the earnings order |
| StatutoryDeductionCategory | Statutory Deduction Category, see Statutory Deduction Categories |
| LiabilityAccoutId | Xero identifier for Liability Account |
| CurrentRecord | Identifier of a record is active or not. |

Example for GET earnings orders – 200 OK Response

```
GET https://api.xero.com/payroll.xro/2.0/earningsOrders
```


```
{
    "id": "e2eac02f-ebb3-3279-c6a0-3e8a748b9855",
    "providerName": "Payroll Test",
    "dateTimeUTC": "2018-02-07T03:14:25.6452078",
    "httpStatusCode": "OK",
    "pagination": {
        "page": 1,
        "pageSize": 100,
        "pageCount": 1,
        "itemCount": 8
    },
    "problem": null,
    "statutoryDeductions": [
        {
            "id": "e84aef9d-27a7-4f25-9e67-22c3045f34c2",
            "name": "AEO (maintenance)",
            "liabilityAccountId": "b60ab41d-1388-4f82-85e1-462df91015d3",
            "statutoryDeductionCategory": "PriorityOrder",
            "currentRecord": true
        },
        {
            "id": "ee2d8145-5a7b-43cc-9ce4-3dc8dd6cfbb7",
            "name": "AEO (fines)",
            "liabilityAccountId": "b60ab41d-1388-4f82-85e1-462df91015d3",
            "statutoryDeductionCategory": "PriorityOrder",
            "currentRecord": true
        },
        {
            "id": "ce05bf89-b28b-457f-ae36-19665d3b5b15",
            "name": "AEO (civil debts)",
            "liabilityAccountId": "b60ab41d-1388-4f82-85e1-462df91015d3",
            "statutoryDeductionCategory": "NonPriorityOrder",
            "currentRecord": true
        },
        {
            "id": "f3e73f40-216d-4268-b50d-21cce97618bc",
            "name": "CTAEO",
            "liabilityAccountId": "b60ab41d-1388-4f82-85e1-462df91015d3",
            "statutoryDeductionCategory": "PriorityOrder",
            "currentRecord": true
        },
        {
            "id": "4add8456-69a9-431f-9949-c6f73fc2a87e",
            "name": "Child Support DEO",
            "liabilityAccountId": "b60ab41d-1388-4f82-85e1-462df91015d3",
            "statutoryDeductionCategory": "PriorityOrder",
            "currentRecord": true
        },
        {
            "id": "bea7bd45-dbbd-46d3-ba9f-54d3c88f0085",
            "name": "Earnings Arrestment (Scotland)",
            "liabilityAccountId": "b60ab41d-1388-4f82-85e1-462df91015d3",
            "statutoryDeductionCategory": "TableBased",
            "currentRecord": true
        },
        {
            "id": "9d7941dc-20f3-4dc2-9690-da862972f9e1",
            "name": "Conjoined Arrestment Order (Scotland)",
            "liabilityAccountId": "b60ab41d-1388-4f82-85e1-462df91015d3",
            "statutoryDeductionCategory": "TableBased",
            "currentRecord": true
        },
        {
            "id": "131f2226-edc9-402f-8a58-8bc2d85eb4dd",
            "name": "Current Maintenance Arrest (Scotland)",
            "liabilityAccountId": "b60ab41d-1388-4f82-85e1-462df91015d3",
            "statutoryDeductionCategory": "NonPriorityOrder",
            "currentRecord": true
        }
    ]
}
```


## GET Statutory Deduction By ID


`GET https://api.xero.com/payroll.xro/2.0/earningsorder/{EarningsOrderID}`

Retrieves detailed information for a earnings order by its unique identifier

### Elements for Earnings Order (Statutory Deduction)

|  |  |
| --- | --- |
| Id | The Xero identifier for earnings order |
| Name | Name of the earnings order |
| StatutoryDeductionCategory | Statutory Deduction Category, see Statutory Deduction Categories |
| LiabilityAccoutId | Xero identifier for Liability Account |
| CurrentRecord | Identifier of a record is active or not. |

Example response for GET Earnings Order by ID – 200 OK Response

```
GET https://api.xero.com/payroll.xro/2.0/statutorydeductions/580e99a8-33f4-4c20-ba0c-7fc29c3db0ce
```


```
{
    "id": "08eeda52-97a9-26c8-6f77-2eceed659e51",
    "providerName": "Payroll Test",
    "dateTimeUTC": "2018-02-08T03:35:44.9848005",
    "httpStatusCode": "OK",
    "pagination": null,
    "problem": null,
    "statutoryDeduction": {
        "id": "580e99a8-33f4-4c20-ba0c-7fc29c3db0ce",
        "name": "AEO (maintenance)",
        "liabilityAccountId": "b60ab41d-1388-4f82-85e1-462df91015d3",
        "statutoryDeductionCategory": "PriorityOrder",
        "currentRecord": true
    }
}
```


Example response for GET Earnings Order by ID – 404 Not Found Response

```
GET https://api.xero.com/payroll.xro/2.0/employees/d90457c4-f1be-4f2e-b4e3-f766390a7e31
```


```

{
    "id": "4893485d-d04a-41d2-9ce8-2be3ac40c1df",
    "providerName": "Payroll Test",
    "dateTimeUTC": "2018-02-08T03:33:09.9335513",
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
    "statutoryDeduction": null
}
```
