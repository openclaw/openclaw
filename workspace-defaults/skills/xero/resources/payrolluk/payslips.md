# Payslips

## Overview


|  |  |
| --- | --- |
| URLs | `https://api.xero.com/payroll.xro/2.0/paySlips/{PayslipID}`<br>`https://api.xero.com/payroll.xro/2.0/paySlips?payrunId={PayrunID}` |
| Methods Supported | GET |
| Description | Allows you to retrieve a Payroll Payslip in a Xero organisation <br>Allows you to retrieve Payroll Payslips by Payrun in a Xero organisation |

## GET Payslip by identifier


`https://api.xero.com/payroll.xro/2.0/paySlips/{PayslipID}`

Retrieve a particular payslip

### Elements for a Payslip

|  |  |
| --- | --- |
| PaySlipID | The Xero identifier for a Payslip |
| EmployeeID | The Xero identifier for payroll employee |
| PayRunID | The Xero identifier for the associated payrun |
| LastEdited | The date payslip was last updated |
| FirstName | Employee first name |
| LastName | Employee last name |
| TotalEarnings | Total earnings before any deductions. Same as gross earnings for UK. |
| GrossEarnings | Total earnings before any deductions. Same as total earnings for UK. |
| TotalPay | The employee net pay |
| TotalEmployerTaxes | The employer's tax obligation |
| TotalEmployeeTaxes | The part of an employee's earnings that is deducted for tax purposes |
| TotalDeductions | Total amount subtracted from an employee's earnings to reach total pay |
| TotalReimbursements | Total reimbursements are nontaxable payments to an employee used to repay out-of-pocket expenses when the person incurs those expenses through employment |
| TotalCourtOrders | Total amounts required by law to subtract from the employee's earnings |
| TotalBenefits | Benefits (also called fringe benefits, perquisites or perks) are various non-earnings compensations provided to employees in addition to their normal earnings or salaries |
| BacsHash | BACS Service User Number |
| PaymentMethod | The method used to pay the employee |
| EarningsLines | See EarningsLines |
| LeaveEarningsLines | See LeaveEarningsLines |
| TimesheetEarningsLines | See TimesheetEarningsLines |
| DeductionLines | See DeductionLines |
| ReimbursementLines | See ReimbursementLines |
| LeaveAccrualLines | See LeaveAccrualLines |
| BenefitLines | See BenefitLines |
| PaymentLines | See PaymentLines |
| TaxLines | See TaxLines |
| CourtOrderLines | See CourtOrderLines |

### Elements for Earnings Line

|  |  |
| --- | --- |
| EarningsRateID | Xero identifier for payroll earnings rate |
| RatePerUnit | Rate per unit for earnings line |
| NumberOfUnits | Earnings number of units |
| FixedAmount | Earnings fixed amount. Only applicable if the EarningsRate RateType is Fixed |
| Amount | The amount of the earnings line. |
| IsLinkedToTimesheet | Identifies if the earnings is taken from the timesheet. False for earnings line |

### Elements for Leave Earnings Line

|  |  |
| --- | --- |
| EarningsRateID | Xero identifier for payroll leave earnings rate |
| RatePerUnit | Rate per unit for leave earnings line |
| NumberOfUnits | Leave earnings number of units |
| FixedAmount | Leave earnings fixed amount. Only applicable if the EarningsRate RateType is Fixed |
| Amount | The amount of the leave earnings line. |
| IsLinkedToTimesheet | Identifies if the leave earnings is taken from the timesheet. False for leave earnings line |

### Elements for Timesheet Earnings Line

|  |  |
| --- | --- |
| EarningsRateID | Xero identifier for payroll timesheet earnings rate |
| RatePerUnit | Rate per unit for timesheet earnings line |
| NumberOfUnits | Timesheet earnings number of units |
| FixedAmount | Timesheet earnings fixed amount. Only applicable if the EarningsRate RateType is Fixed |
| Amount | The amount of the timesheet earnings line. |
| IsLinkedToTimesheet | Identifies if the timesheet earnings is taken from the timesheet. True for timesheet earnings line |

### Elements for Deduction Line

|  |  |
| --- | --- |
| DeductionTypeID | Xero identifier for payroll deduction |
| Amount | The amount of the deduction line |
| SubjectToTax | Identifies if the deduction is subject to tax |
| Percentage | Deduction rate percentage |

### Elements for Reimbursement Line

|  |  |
| --- | --- |
| ReimbursementTypeID | Xero identifier for payroll reimbursement |
| Description | Reimbursement line description |
| Amount | Reimbursement amount |

### Elements for Leave Accrual Line

|  |  |
| --- | --- |
| LeaveTypeID | Xero identifier for the Leave type |
| NumberOfUnits | Leave accrual number of units |

### Elements for Benefit Line

|  |  |
| --- | --- |
| BenefitTypeID | Xero identifier for payroll benefit type |
| DisplayName | Benefit display name |
| Amount | The amount of the benefit line |
| FixedAmount | Benefit fixed amount |
| Percentage | Benefit rate percentage |

### Elements for Payment Line

|  |  |
| --- | --- |
| PaymentLineID | Xero identifier for payroll payment line |
| Amount | The amount of the payment line |
| AccountNumber | The account number |
| SortCode | The account sort code |
| AccountName | The account name |

### Elements for Tax Line

|  |  |
| --- | --- |
| TaxLineID | Xero identifier for payroll tax line |
| Description | Tax line description |
| IsEmployerTax | Identifies if the amount is paid for by the employee or employer. True if employer pays the tax |
| Amount | The amount of the tax line |

### Elements for Court Order Line

|  |  |
| --- | --- |
| CourtOrderTypeID | Xero identifier for payroll court order type |
| Amount | The amount of the court order line |

Example response for GET payslip – 200 OK Response

```
GET https://api.xero.com/payroll.xro/2.0/paySlips/6c4f8dd3-696b-43fd-8a1a-a31768beb9cf
```


```
{
    "id": "c4be24e5-e840-4c92-9eaa-2d86cd596314",
    "providerName": "Payroll Test",
    "dateTimeUTC": "2017-09-19T04:05:59.7955577",
    "httpStatusCode": "OK",
    "pagination": null,
    "problem": null,
    "paySlip": {
        "paySlipID": "6c4f8dd3-696b-43fd-8a1a-a31768beb9cf",
        "employeeID": "e0562b49-e3e4-44b0-a9b3-98c5ab671f2e",
        "payRunID": "a11bca31-fc67-4217-89dc-f53a1956d404",
        "lastEdited": null,
        "firstName": "One Test",
        "lastName": "Tester",
        "totalEarnings": 229,
        "grossEarnings": 229,
        "totalPay": 102.94,
        "totalEmployerTaxes": 27.19,
        "totalEmployeeTaxes": 94.44,
        "totalDeductions": 125,
        "totalReimbursements": 112.5,
        "totalCourtOrders": 19.12,
        "totalBenefits": 125,
        "bacsHash": null,
        "paymentMethod": "Electronically",
        "earningsLines": [
            {
                "earningsRateID": "00303a3f-b3df-48d6-907e-b3b7da2e6f19",
                "ratePerUnit": null,
                "numberOfUnits": null,
                "fixedAmount": 25,
                "amount": 25,
                "isLinkedToTimesheet": false
            }
        ],
        "leaveEarningsLines": [
            {
                "earningsRateID": "2dd9e09c-56be-4dcf-b89d-6b0415e93c02",
                "ratePerUnit": 34,
                "numberOfUnits": 0,
                "fixedAmount": null,
                "amount": 0,
                "isLinkedToTimesheet": false
            }
        ],
        "timesheetEarningsLines": [
            {
                "earningsRateID": "c0c5feff-43c3-4338-b106-408654409fe7",
                "ratePerUnit": 51,
                "numberOfUnits": 4,
                "fixedAmount": null,
                "amount": 204,
                "isLinkedToTimesheet": true
            }
        ],
        "deductionLines": [
            {
                "deductionTypeID": "0475defb-b053-46c8-b0ea-64c1ce825ca3",
                "amount": 125,
                "subjectToTax": null,
                "percentage": null
            }
        ],
        "reimbursementLines": [
            {
                "reimbursementTypeID": "8031f32c-f75b-44bc-bca8-55d1d4a0d5fa",
                "description": "Trip to London",
                "amount": 100
            },
            {
                "reimbursementTypeID": "e0cb87af-c5a7-4ad3-8c17-d5da7cde8e60",
                "description": "Pens",
                "amount": 12.5
            }
        ],
        "leaveAccrualLines": [
            {
                "leaveTypeID": "2d8fc263-9620-47a4-b071-15d67c45a0ce",
                "numberOfUnits": 6.7308
            },
            {
                "leaveTypeID": "0624ce8e-6561-4811-88b6-ad8ebfa74ac4",
                "numberOfUnits": 0
            }
        ],
        "benefitLines": [
            {
                "benefitTypeID": "10de5975-b9d0-4b9a-a2b5-d6287cf5c12b",
                "displayName": "Employer Paid Health Insurance",
                "amount": 125,
                "fixedAmount": 125,
                "percentage": null
            }
        ],
        "paymentLines": [
            {
                "paymentLineID": "381821eb-8e04-4104-826c-8655a04c25dc",
                "amount": 102.94,
                "accountNumber": "12312312",
                "sortCode": "000201",
                "accountName": "Test One Tester"
            }
        ],
        "taxLines": [
            {
                "taxLineID": "ca6f9af4-1a40-4470-bedc-8fbd7a7e2a61",
                "description": "Employee National Insurance Contribution - A",
                "isEmployerTax": false,
                "amount": 23.64
            },
            {
                "taxLineID": "918d9390-7bc0-433c-a05b-1f143142c6ec",
                "description": "Employer National Insurance Contribution - A",
                "isEmployerTax": true,
                "amount": 27.19
            },
            {
                "taxLineID": "d86558ec-5b07-4443-af55-12e8a130192c",
                "description": "PAYE",
                "isEmployerTax": false,
                "amount": 70.8
            }
        ],
        "courtOrderLines": [
            {
                "courtOrderTypeID": "7120524c-2be0-4247-a79b-a1f62728495d",
                "amount": 9.56
            },
            {
                "courtOrderTypeID": "0c71b2ff-552b-461e-99fc-0f0bedd0a4a6",
                "amount": 9.56
            }
        ]
    }
}
```


Example response for GET payslip, not existing payslip – 404 Not Found Response

```
GET https://api.xero.com/payroll.xro/2.0/paySlips/6c4f8dd3-696b-43fd-8a1a-a31768beb9c0
```


```
{
    "id": "c4be24e5-e840-4c92-9eaa-2d86cd596314",
    "providerName": "Payroll Test",
    "dateTimeUTC": "2017-09-19T04:17:11.7993767",
    "httpStatusCode": "NotFound",
    "pagination": null,
    "problem": {
        "type": "http://payroll.xero.com/errors/object-not-found",
        "title": null,
        "status": 0,
        "detail": "f488c51b-afc1-4567-b749-6aaa418cc706",
        "instance": null,
        "invalidFields": null
    },
    "paySlip": null
}
```


## GET Payslips By PayrunID


`GET https://api.xero.com/payroll.xro/2.0/payslips?payrunId={PayrunID}`

Retrieves detailed information for payslips in the payrun

### Required parameter for GET Payslip

|  |  |
| --- | --- |
| PayrunID | PayrunID which specifies the containing payrun of payslips to retrieve. <br>By default, the API does not group payslips by payrun. <br>Example: `https://.../2.0/paySlips?payrunId={PayrunID}` to get payslips of the specific payrun. |

### Optional Parameters

|  |  |
| --- | --- |
| Page | Page number which specifies the set of records to retrieve. <br>By default the number of the records per set is 100. <br>Example: `https://.../2.0/paySlips?payrunId={PayrunID}&page=1` to get the second set of the records. <br>When page value is not a number or a negative number, by default, the first set of records is returned. |

### Elements for Payslips

List of PaySlip(s).

Example for GET PaySlips by PayrunID – 200 OK Response

```
GET https://api.xero.com/payroll.xro/2.0/paySlips?payrunId=1f6702cb-5b30-4d3e-8962-3380a7ad44e1
```


```
{
    "id": "ea249b3c-e7c1-f96d-2d22-0651326ce29b",
    "providerName": "Example Provider",
    "dateTimeUTC": "2017-09-13T06:21:31.4746406",
    "httpStatusCode": "OK",
    "pagination": {
        "page": 1,
        "pageSize": 10,
        "pageCount": 1,
        "itemCount": 7
    },
    "problem": null,
    "paySlips": [ ... ]
}
```
