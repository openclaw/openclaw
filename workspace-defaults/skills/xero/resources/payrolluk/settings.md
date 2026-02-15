# Settings

## Overview


|  |  |
| --- | --- |
| URLs | `https://api.xero.com/payroll.xro/2.0/Settings` |
| Methods Supported | GET, PUT |
| Description | Allows you to retrieve and update Account Settings information from a Xero organisation.<br>Each account is comprised of an AccountID, Type, Code and Name |

## Elements for Account


|  |  |
| --- | --- |
| AccountID | The Xero identifier for the Account. |
| Type | The assigned AccountType. |
| Code | A unique-per-organization, 3 digit number identifying the Account. |
| Name | Name of the Account. |

## GET Settings


`https://api.xero.com/payroll.xro/2.0/Settings`

### Elements for GET Settings

|  |  |
| --- | --- |
| Accounts | An array of Accounts. |

### Example GET Settings

Request:

```
GET https://api.xero.com/payroll.xro/2.0/Settings
```


Response:

```
{
    "id": "d35de0f1-6fe4-4841-a4d6-f6a785e0c4b7",
    "providerName": "asdffd",
    "dateTimeUTC": "2017-09-01T01:22:07.6950615",
    "httpStatusCode": "OK",
    "pagination": null,
    "problem": null,
    "settings": {
        "accounts": [
            {
                "accountID": "1fa68c8f-5e91-475c-a949-06c92844b4d5",
                "type": "WAGESPAYABLE",
                "code": "850",
                "name": "Suspense"
            },
            {
                "accountID": "e294218e-7fee-4612-b277-acf4374dd173",
                "type": "WAGESEXPENSE",
                "code": "477",
                "name": "Salaries"
            },
            {
                "accountID": "a9b57152-0023-48fe-b53c-81e78925bbdc",
                "type": "BANK",
                "code": "090",
                "name": "Personal Bank Account"
            },
            {
                "accountID": "cb629c71-63e1-4e67-a61a-c0e142a4ce8e",
                "type": "PAYELIABILITY",
                "code": "825",
                "name": "PAYE Payable"
            },
            {
                "accountID": "cb629c71-63e1-4e67-a61a-c0e142a4ce8e",
                "type": "NICLIABILITY",
                "code": "825",
                "name": "PAYE Payable"
            },
            {
                "accountID": "84c7d576-6137-4154-a1f5-da8c520dbac1",
                "type": "EMPLOYERSNIC",
                "code": "404",
                "name": "Bank Fees"
            },
            {
                "accountID": "d36d84e8-ab1c-4c95-8843-46dcd79af51b",
                "type": "PAYEECONTRIBUTION",
                "code": "815",
                "name": "Employee contribution to benefits"
            }
        ]
    }
}
```


## PUT Settings


`https://api.xero.com/payroll.xro/2.0/Settings`

### Elements for PUT Settings

|  |  |
| --- | --- |
| Accounts | An updated array of Accounts.<br> The array should contain one instance each of the BANK, PAYELIABILITY, WAGESEXPENSE, WAGESPAYABLE, NICLIABILITY, EMPLOYERSNIC and PAYEECONTRIBUTION Account Types. |

### Example PUT Settings

Request:

```
PUT https://api.xero.com/payroll.xro/2.0/Settings
```


```
{
    "accounts": [
        {
            "accountID": "1fa68c8f-5e91-475c-a949-06c92844b4d5",
            "type": "WAGESPAYABLE",
            "code": "850",
            "name": "Suspense"
        },
        {
            "accountID": "e294218e-7fee-4612-b277-acf4374dd173",
            "type": "WAGESEXPENSE",
            "code": "477",
            "name": "Salaries"
        },
        {
            "accountID": "eeb4831b-72ef-47a3-87f6-c8cab1372602",
            "type": "BANK",
            "code": "091",
            "name": "Personal Savings Account"
        },
        {
            "accountID": "cb629c71-63e1-4e67-a61a-c0e142a4ce8e",
            "type": "PAYELIABILITY",
            "code": "825",
            "name": "PAYE Payable"
        },
        {
            "accountID": "cb629c71-63e1-4e67-a61a-c0e142a4ce8e",
            "type": "NICLIABILITY",
            "code": "825",
            "name": "PAYE Payable"
        },
        {
            "accountID": "84c7d576-6137-4154-a1f5-da8c520dbac1",
            "type": "EMPLOYERSNIC",
            "code": "404",
            "name": "Bank Fees"
        },
        {
            "accountID": "d36d84e8-ab1c-4c95-8843-46dcd79af51b",
            "type": "PAYEECONTRIBUTION",
            "code": "815",
            "name": "Employee contribution to benefits"
        }
    ]
}
```


Response:

```
{
    "id": "f71edffb-17e4-4ef7-822a-4d5425e1ae9c",
    "providerName": "asdffd",
    "dateTimeUTC": "2017-09-01T01:22:07.6950615",
    "httpStatusCode": "OK",
    "pagination": null,
    "problem": null,
    "settings": {
        "accounts": [
            {
                "accountID": "1fa68c8f-5e91-475c-a949-06c92844b4d5",
                "type": "WAGESPAYABLE",
                "code": "850",
                "name": "Suspense"
            },
            {
                "accountID": "e294218e-7fee-4612-b277-acf4374dd173",
                "type": "WAGESEXPENSE",
                "code": "477",
                "name": "Salaries"
            },
            {
                "accountID": "eeb4831b-72ef-47a3-87f6-c8cab1372602",
                "type": "BANK",
                "code": "091",
                "name": "Personal Savings Account"
            },
            {
                "accountID": "cb629c71-63e1-4e67-a61a-c0e142a4ce8e",
                "type": "PAYELIABILITY",
                "code": "825",
                "name": "PAYE Payable"
            },
            {
                "accountID": "cb629c71-63e1-4e67-a61a-c0e142a4ce8e",
                "type": "NICLIABILITY",
                "code": "825",
                "name": "PAYE Payable"
            },
            {
                "accountID": "84c7d576-6137-4154-a1f5-da8c520dbac1",
                "type": "EMPLOYERSNIC",
                "code": "404",
                "name": "Bank Fees"
            },
            {
                "accountID": "d36d84e8-ab1c-4c95-8843-46dcd79af51b",
                "type": "PAYEECONTRIBUTION",
                "code": "815",
                "name": "Employee contribution to benefits"
            }
        ]
    }
}
```
