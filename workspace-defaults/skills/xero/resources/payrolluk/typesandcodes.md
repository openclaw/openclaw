# Types and Codes

Below is a detailed list of all the types and codes the Xero Payroll API uses

## Timesheets


### Status

|  |  |
| --- | --- |
| Draft | Timesheet entry is still in draft and has not been submitted for approval |
| Requested | Timesheet entry has been submitted for approval |
| Approved | Timesheet entry has been approved but the pay run has not been posted |
| Declined | Timesheet entry has been submitted for approval and declined by the approver |
| Completed | Timesheet entry has been approved and the pay run has been posted |

## Payment Methods


|  |  |
| --- | --- |
| Cheque | Payment is given via a cheque |
| Electronically | Payment is transferred to bank account |
| Manual | Payment is given in cash |

## Period


### PeriodStatus

|  |  |
| --- | --- |
| Approved | Leave is already approved but the payrun has not been posted |
| Completed | Leave is already approved and the payrun posted |

## Leave Types


### ScheduleOfAccrual

|  |  |
| --- | --- |
| BeginningOfCalendarYear | Leave is accrued at the start of the calendar year |
| OnAnniversaryDate | Leave is accrued every anniversary date |
| EachPayPeriod | Leave is accrued every pay period |
| OnHourWorked | Leave is accrued for every hour worked |

## Settings


### Account Types

| Value | Description | Requirements |
| --- | --- | --- |
| BANK | Bank account. | Must be BANK Account Type, must be current. |
| PAYELIABILITY | PAYE Liability account. | Must be LIABILITY Class Type. |
| WAGESEXPENSE | Wages Expense account. | Must be EXPENSE Class Type. |
| WAGESPAYABLE | Wages Payable account. | Must be LIABILITY Class Type. |
| NICLIABILITY | NIC Liability account. | Must be LIABILITY Class Type. |
| EMPLOYERSNIC | Employer's NIC account. | Must be EXPENSE Class Type. |
| PAYEECONTRIBUTION | Benefit employee contribution account. | Must be LIABILITY Class Type. |

## Payruns


### Payrun Status

|  |  |
| --- | --- |
| Draft | The pay run is in draft and has not been posted. |
| Posted | The pay run has been posted. |

### Payrun Types

|  |  |
| --- | --- |
| Scheduled | Pay run that is using the normal pay run period. |
| Unscheduled | Pay run that is not using the normal pay run period. |
| EarlierYearUpdate | Pay run that is of Earlier Year Update. |

### Payrun Calendar Types

|  |  |
| --- | --- |
| Weekly | Weekly Payroll Calendar. |
| Fortnightly | Fortnightly Payroll Calendar. |
| FourWeekly | Four Weekly Payroll Calendar. |
| Monthly | Monthly Payroll Calendar. |
| Annual | Annual Payroll Calendar. |
| Quarterly | Quarterly Payroll Calendar. |

## Deductions


### Deduction Categories

|  |  |
| --- | --- |
| StakeholderPension | Pre-Tax Pension (NPA) |
| StakeholderPensionPostTax | Post-Tax Pension (RAS) |
| ChildCareVoucher | Child Care Voucher |
| SalarySacrifice | Salary Sacrifice |
| PostgraduateLoanDeductions | Postgraduate Loan Deductions |
| MakingGood | Making Good |
| PrivateUsePayments | Payments for Private Use Deductions |
| CapitalContributions | Capital Contributions Deductions |
| UkOther | Other for UK |

### Statutory Deduction Categories

|  |  |
| --- | --- |
| PriorityOrder | Priority Order |
| NonPriorityOrder | Non-Priority Order |
| TableBased | Table Based |
| ChildSupport | Child Support |
| CourtFines | Court Fines |
| InlandRevenueArrears | Inland Revenue Arrears |
| MsdRepayments | Ministry of Social Management(MSD) Repayments |
| StudentLoan | Student Loan |
| AdditionalStudentLoan | Additional Student Loan |
| VoluntaryStudentLoan | Voluntary Student Loan |
| KiwiSaver | KiwiSaver |
