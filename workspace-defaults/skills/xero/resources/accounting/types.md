# Types and Codes

## Overview


Below is a detailed list of all the types and codes the Xero API uses:

## Accounts


### Account Class Types

|  |
| --- |
| ASSET |
| EQUITY |
| EXPENSE |
| LIABILITY |
| REVENUE |

### Account Types

|  |  |
| --- | --- |
| BANK | Bank account |
| CURRENT | Current Asset account |
| CURRLIAB | Current Liability account |
| DEPRECIATN | Depreciation account |
| DIRECTCOSTS | Direct Costs account |
| EQUITY | Equity account |
| EXPENSE | Expense account |
| FIXED | Fixed Asset account |
| INVENTORY | Inventory Asset account |
| LIABILITY | Liability account |
| NONCURRENT | Non-current Asset account |
| OTHERINCOME | Other Income account |
| OVERHEADS | Overhead account |
| PREPAYMENT | Prepayment account |
| REVENUE | Revenue account |
| SALES | Sale account |
| TERMLIAB | Non-current Liability account |

### Account Status Codes

|  |
| --- |
| ACTIVE |
| ARCHIVED |

### Bank Account Types

|  |  |
| --- | --- |
| BANK | Bank account |
| CREDITCARD | Credit card account |
| PAYPAL | Paypal account |

### System Accounts

|  |  |
| --- | --- |
| **Default account name** | **SystemAccount attribute value** |
| Accounts Receivable | DEBTORS |
| Accounts Payable | CREDITORS |
| Bank Revaluations | BANKCURRENCYGAIN |
| CIS Assets (UK Only) | CISASSETS |
| CIS Labour Expense (UK Only) | CISLABOUREXPENSE |
| CIS Labour Income (UK Only) | CISLABOURINCOME |
| CIS Liability (UK Only) | CISLIABILITY |
| CIS Materials (UK Only) | CISMATERIALS |
| GST / VAT | GST |
| GST On Imports | GSTONIMPORTS |
| Historical Adjustment | HISTORICAL |
| Realised Currency Gains | REALISEDCURRENCYGAIN |
| Retained Earnings | RETAINEDEARNINGS |
| Rounding | ROUNDING |
| Tracking Transfers | TRACKINGTRANSFERS |
| Unpaid Expense Claims | UNPAIDEXPCLM |
| Unrealised Currency Gains | UNREALISEDCURRENCYGAIN |
| Wages Payable | WAGEPAYABLES |

## Addresses


### Addresses

|  |  |
| --- | --- |
| AddressType |  |
| AddressLine 1,2,3,4 | max length = 500 |
| City | max length = 255 |
| Region | max length = 255 |
| PostalCode | max length = 50 |
| Country | max length = 50, `[A-Z]`, `[a-z]` only |
| AttentionTo | max length = 255 |

### Address Types

|  |  |
| --- | --- |
| POBOX | The default mailing address for invoices |
| STREET |  |
| DELIVERY | Read-only via the GET endpoint (if set). The delivery address of the Xero organisation. DELIVERY address type is not valid for Contacts. |

## Bank Transactions


### Types

|  |
| --- |
| RECEIVE |
| RECEIVE-OVERPAYMENT |
| RECEIVE-PREPAYMENT |
| SPEND |
| SPEND-OVERPAYMENT |
| SPEND-PREPAYMENT |
| _The following values are only supported via the GET method at the moment_ |
| RECEIVE-TRANSFER |
| SPEND-TRANSFER |

### Bank Transaction Status Codes

|  |
| --- |
| AUTHORISED |
| DELETED |

## Contacts


### Contact Status Codes

|  |  |
| --- | --- |
| ACTIVE | The Contact is active and can be used in transactions |
| ARCHIVED | The Contact is archived and can no longer be used in transactions |
| GDPRREQUEST | The Contact is the subject of a GDPR erasure request and can no longer be used in tranasctions |

### Contact US Tax Number Type

|  |  |
| --- | --- |
| SSN | Social Security Number |
| ITIN | Individual Taxpayer Identification Number |
| ATIN | Adoption Tax Identification Number |
| EIN | Employer Identification Number |

## Credit Notes


### Credit Note Types

|  |  |
| --- | --- |
| **ACCPAYCREDIT** | An Accounts Payable(supplier) Credit Note |
| **ACCRECCREDIT** | An Account Receivable(customer) Credit Note |

All other types eg. status code and line amount are identical to Invoices.

## Expense Claims


### Expense Claim Status Codes

( Refer to expense claims for details of usage )

|  |  |
| --- | --- |
| **SUBMITTED** | An expense claim has been submitted for approval ( _default_) |
| **AUTHORISED** | An expense claim has been authorised for payment |
| **PAID** | An expense claim has been paid |

## ExternalLinks


### External Link Types

|  |
| --- |
| **Facebook** |
| **GooglePlus** |
| **LinkedIn** |
| **Twitter** |
| **Website** |

## Invoices


### Invoice Types

|  |  |
| --- | --- |
| **ACCPAY** | A bill – commonly known as an Accounts Payable or supplier invoice |
| **ACCREC** | A sales invoice – commonly known as an Accounts Receivable or customer invoice |

### Invoice Status Codes

( Refer to invoices for details of usage )

|  |  |
| --- | --- |
| **DRAFT** | A Draft Invoice ( _default_) |
| **SUBMITTED** | An Awaiting Approval Invoice |
| **DELETED** | A Deleted Invoice |
| **AUTHORISED** | An Invoice that is Approved and Awaiting Payment OR partially paid |
| **PAID** | An Invoice that is completely Paid |
| **VOIDED** | A Voided Invoice |

### LineAmount Types

|  |  |
| --- | --- |
| **Exclusive** | Line items are exclusive of tax |
| **Inclusive** | Line items are inclusive tax |
| **NoTax** | Line have no tax |

### Tax calculation types

|  |  |
| --- | --- |
| **TAXCALC/AUTO** | Tax was calculated using auto sales tax |

## Journals


### Journal Source Types

|  |  |
| --- | --- |
| **ACCREC** | Accounts Receivable Invoice |
| **ACCPAY** | Accounts Payable Invoice |
| **ACCRECCREDIT** | Accounts Receivable Credit Note |
| **ACCPAYCREDIT** | Accounts Payable Credit Note |
| **ACCRECPAYMENT** | Payment on an Accounts Receivable Invoice |
| **ACCPAYPAYMENT** | Payment on an Accounts Payable Invoice |
| **ARCREDITPAYMENT** | Accounts Receivable Credit Note Payment |
| **APCREDITPAYMENT** | Accounts Payable Credit Note Payment |
| **CASHREC** | Receive Money Bank Transaction |
| **CASHPAID** | Spend Money Bank Transaction |
| **TRANSFER** | Bank Transfer |
| **ARPREPAYMENT** | Accounts Receivable Prepayment |
| **APPREPAYMENT** | Accounts Payable Prepayment |
| **AROVERPAYMENT** | Accounts Receivable Overpayment |
| **APOVERPAYMENT** | Accounts Payable Overpayment |
| **EXPCLAIM** | Expense Claim |
| **EXPPAYMENT** | Expense Claim Payment |
| **MANJOURNAL** | Manual Journal |
| **PAYSLIP** | Payslip |
| **WAGEPAYABLE** | Payroll Payable |
| **INTEGRATEDPAYROLLPE** | Payroll Expense |
| **INTEGRATEDPAYROLLPT** | Payroll Payment |
| **EXTERNALSPENDMONEY** | Payroll Employee Payment |
| **INTEGRATEDPAYROLLPTPAYMENT** | Payroll Tax Payment |
| **INTEGRATEDPAYROLLCN** | Payroll Credit Note |

Note – Journals created by conversion balances, payruns, bank reconciliation adjustments and fixed assets will not return a SourceType or SourceID

## Linked Transactions


### Linked Transaction Status Codes

|  |  |
| --- | --- |
| **DRAFT** | The source transaction is in a draft status. The linked transaction has not been allocated to target transaction |
| **APPROVED** | The source transaction is in a authorised status. The linked transaction has not been allocated to target transaction |
| **ONDRAFT** | The linked transaction has been allocated to target transaction in draft status |
| **BILLED** | The linked transaction has been allocated to a target transaction in authorised status |
| **VOIDED** | The source transaction has been voided |

## Manual Journals


### Manual Journal Status Codes

|  |  |
| --- | --- |
| **DRAFT** | A Draft ManualJournal ( _default_) |
| **POSTED** | A Posted ManualJournal |
| **DELETED** | A Deleted Draft ManualJournal |
| **VOIDED** | A Voided Posted ManualJournal |

## Organisation


### Version Types

Business editions

|  |
| --- |
| AU |
| NZ |
| GLOBAL |
| UK |
| US |

Partner & Cashbook editions. NOTE: Authorization on Cashbook edition has to be approved by partners

|  |
| --- |
| AUONRAMP |
| NZONRAMP |
| GLOBALONRAMP |
| UKONRAMP |
| USONRAMP |

### Organisation Types

|  |
| --- |
| **ACCOUNTING\_PRACTICE** |
| **CHARITY** |
| **CLUB\_OR\_SOCIETY** |
| **COMPANY** |
| **INDIVIDUAL** |
| **LOOK\_THROUGH\_COMPANY** |
| **NOT\_FOR\_PROFIT** |
| **PARTNERSHIP** |
| **S\_CORPORATION** |
| **SELF\_MANAGED\_SUPERANNUATION\_FUND** |
| **SOLE\_TRADER** |
| **SUPERANNUATION\_FUND** |
| **TRUST** |

### Organisation Classes

|  |
| --- |
| **DEMO** |
| **TRIAL** |
| **STARTER** |
| **STANDARD** |
| **PREMIUM** |
| **PREMIUM\_20** |
| **PREMIUM\_50** |
| **PREMIUM\_100** |
| **LEDGER** |
| **GST\_CASHBOOK** |
| **NON\_GST\_CASHBOOK** |
| **ULTIMATE** |
| **LITE** |
| **ULTIMATE\_10** |
| **ULTIMATE\_20** |
| **ULTIMATE\_50** |
| **ULTIMATE\_100** |
| **IGNITE** |
| **GROW** |
| **COMPREHENSIVE** |
| **SIMPLE** |

## Overpayments


### Types

|  |
| --- |
| RECEIVE-OVERPAYMENT |
| SPEND-OVERPAYMENT |

### Overpayment Status Codes

|  |
| --- |
| **AUTHORISED** |
| **PAID** |
| **VOIDED** |

## Prepayments


### Types

|  |
| --- |
| RECEIVE-PREPAYMENT |
| SPEND-PREPAYMENT |

### Prepayment Status Codes

|  |
| --- |
| **AUTHORISED** |
| **PAID** |
| **VOIDED** |

## Payments


### Payment Status Codes

|  |
| --- |
| **AUTHORISED** |
| **DELETED** |

### Payment Terms

|  |  |
| --- | --- |
| **DAYSAFTERBILLDATE** | day(s) after bill date |
| **DAYSAFTERBILLMONTH** | day(s) after bill month |
| **OFCURRENTMONTH** | of the current month |
| **OFFOLLOWINGMONTH** | of the following month |

### Payment Types

|  |  |
| --- | --- |
| **ACCRECPAYMENT** | Accounts Receivable Payment |
| **ACCPAYPAYMENT** | Accounts Payable Payment |
| **ARCREDITPAYMENT** | Accounts Receivable Credit Payment (Refund) |
| **APCREDITPAYMENT** | Accounts Payable Credit Payment (Refund) |
| **AROVERPAYMENTPAYMENT** | Accounts Receivable Overpayment Payment (Refund) |
| **ARPREPAYMENTPAYMENT** | Accounts Receivable Prepayment Payment (Refund) |
| **APPREPAYMENTPAYMENT** | Accounts Payable Prepayment Payment (Refund) |
| **APOVERPAYMENTPAYMENT** | Accounts Payable Overpayment Payment (Refund) |

## Phones


|  |  |
| --- | --- |
| PhoneType |  |
| PhoneNumber | max length = 50 |
| PhoneAreaCode | max length = 10 |
| PhoneCountryCode | max length = 20 |

### Phone Types

|  |
| --- |
| **DEFAULT** |
| **DDI** |
| **MOBILE** |
| **FAX** |

## Purchase Orders


### Purchase Order Statuses

|  |  |
| --- | --- |
| DRAFT |  |
| SUBMITTED |  |
| AUTHORISED |  |
| BILLED |  |
| DELETED |  |

### Quote Status Codes

|  |  |
| --- | --- |
| **DRAFT** | A draft quote ( _default_) |
| **DELETED** | A deleted quote |
| **SENT** | A quote that is marked as sent |
| **DECLINED** | A quote that was declined by the customer |
| **ACCEPTED** | A quote that was accepted by the customer |
| **INVOICED** | A quote that has been invoiced |

## Receipts


### Receipt Status Codes

( Refer to receipts for details of usage )

|  |  |
| --- | --- |
| **DRAFT** | A draft receipt ( _default_) |
| **SUBMITTED** | Receipt has been submitted as part of an expense claim |
| **AUTHORISED** | Receipt has been authorised in the Xero app |
| **DECLINED** | Receipt has been declined in the Xero app |

## Report Tax Types


Below are a list of Report Tax Types included by default in each version of Xero for AU, NZ and UK

### Australia

|  |
| --- |
| _The following can be used for creating and updating tax rates_ |
| OUTPUT |
| INPUT |
| EXEMPTOUTPUT |
| INPUTTAXED |
| BASEXCLUDED |
| EXEMPTEXPENSES |
| _The following are used for system tax rates and only returned on GET requests_ |
| EXEMPTCAPITAL |
| EXEMPTEXPORT |
| CAPITALEXINPUT |
| GSTONCAPITALIMPORTS |
| GSTONIMPORTS |

### New Zealand

|  |
| --- |
| _The following can be used for creating and updating tax rates_ |
| OUTPUT |
| INPUT |
| EXEMPTOUTPUT |
| EXEMPTINPUT |
| _The following are used for system tax rates and only returned on GET requests_ |
| NONE |
| GSTONIMPORTS |

### UK

|  |
| --- |
| _The following can be used for creating and updating tax rates_ |
| OUTPUT |
| INPUT |
| EXEMPTOUTPUT |
| EXEMPTINPUT |
| ECOUTPUT |
| ECOUTPUTSERVICES |
| ECINPUT |
| ECACQUISITIONS |
| CAPITALSALESOUTPUT |
| CAPITALEXPENSESINPUT |
| MOSSSALES |
| _The following are not yet available for create and update via the API. They are returned on GET requests_ |
| REVERSECHARGES |
| _The following are used for system tax rates and only returned on GET requests_ |
| NONE |
| GSTONIMPORTS |

### US

|  |
| --- |
| _The following are not yet available for create and update via the API. They are returned on GET requests_ |
| USSALESTAX |
| AVALARA |

## Sales Tax Basis


Below are a list of Sales Tax Basis values included in each version of Xero

### New Zealand

|  |  |
| --- | --- |
| **PAYMENTS** | Payments Basis |
| **INVOICE** | Invoice Basis |
| **NONE** | None |

### United Kingdom

|  |  |
| --- | --- |
| **CASH** | Cash Scheme |
| **ACCRUAL** | Accrual Scheme |
| **FLATRATECASH** | Flat Rate Cash Scheme |
| **FLATRATEACCRUAL** | Flat Rate Accrual Scheme |
| **NONE** | None |

### Australia, US & Global

|  |  |
| --- | --- |
| **CASH** | Cash Basis |
| **ACCRUALS** | Accruals Basis |
| **NONE** | None |

## Sales Tax Periods


Below are a list of Sales Tax Periods included in each version of Xero

### Australia

|  |  |
| --- | --- |
| **MONTHLY** | Monthly |
| **QUARTERLY1** | Quarterly (Option1) |
| **QUARTERLY2** | Quarterly (Option2) |
| **QUARTERLY3** | Quarterly (Option3) |
| **ANNUALLY** | Annually |

### New Zealand

|  |  |
| --- | --- |
| **ONEMONTHS** | Monthly |
| **TWOMONTHS** | 2 Monthly |
| **SIXMONTHS** | 6 Monthly |

### US & Global

|  |  |
| --- | --- |
| **1MONTHLY** | Monthly |
| **2MONTHLY** | 2 Monthly |
| **3MONTHLY** | 3 Monthly |
| **6MONTHLY** | 6 Monthly |
| **ANNUALLY** | Annually |

### United Kingdom

|  |  |
| --- | --- |
| **MONTHLY** | Monthly |
| **QUARTERLY** | Quarterly |
| **YEARLY** | Yearly |

## Tax Rates


### Tax Status Codes

|  |  |
| --- | --- |
| **ACTIVE** | The tax rate is active and can be used in transactions |
| **DELETED** | The tax rate is deleted and cannot be restored or used on transactions |
| **ARCHIVED** | The tax rate has been used on a transaction (e.g. an invoice) but has since been deleted. ARCHIVED tax rates cannot be restored or used on transactions. |

### Tax Types

New tax rates can be setup for a Xero organisation. All new tax rates added have a TaxType of the format TAX001, TAX002 etc.

Below are a list of Tax Types included by default in each version of Xero. Tax Types that are system defined cannot be updated via the API.

### Australia

|  |  |  |  |
| --- | --- | --- | --- |
| **TAX TYPE** | **RATE** | **NAME** | **SYSTEM DEFINED** |
| OUTPUT | 10.00 | GST on Income |  |
| INPUT | 10.00 | GST on Expenses |  |
| EXEMPTEXPENSES | 0.00 | GST Free Expenses | Yes |
| EXEMPTOUTPUT | 0.00 | GST Free Income |  |
| BASEXCLUDED | 0.00 | BAS Excluded |  |
| GSTONIMPORTS | 0.00 | GST on Imports | Yes |

### Global

|  |  |  |  |
| --- | --- | --- | --- |
| **TAX TYPE** | **RATE** | **NAME** | **SYSTEM DEFINED** |
| INPUT | 0.00 | Tax on Purchases |  |
| NONE | 0.00 | Tax Exempt | Yes |
| OUTPUT | 0.00 | Tax on Sales |  |
| GSTONIMPORTS | 0.00 | Sales Tax on Imports | Yes |

### New Zealand

|  |  |  |  |
| --- | --- | --- | --- |
| **TAX TYPE** | **RATE** | **NAME** | **SYSTEM DEFINED** |
| INPUT2 | 15.00 | GST on Expenses |  |
| NONE | 0.00 | No GST | Yes |
| ZERORATED | 0.00 | Zero Rated |  |
| OUTPUT2 | 15.00 | GST on Income |  |
| GSTONIMPORTS | 0.00 | GST on Imports | Yes |

### United Kingdom

|  |  |  |  |
| --- | --- | --- | --- |
| **TAX TYPE** | **RATE** | **NAME** | **SYSTEM DEFINED** |
| CAPEXINPUT | 17.50 | 17.5% (VAT on Capital Purchases) | Yes |
| CAPEXINPUT2 | 20.00 | 20% (VAT on Capital Purchases) | Yes |
| CAPEXOUTPUT | 17.50 | 17.5% (VAT on Capital Sales) | Yes |
| CAPEXOUTPUT2 | 20.00 | 20% (VAT on Capital Sales) | Yes |
| CAPEXSRINPUT | 15.00 | 15% (VAT on Capital Purchases) | Yes |
| CAPEXSROUTPUT | 15.00 | 15% (VAT on Capital Sales) | Yes |
| ECACQUISITIONS | 20.00 | EC Acquisitions (20%) |  |
| ECZRINPUT | 0.00 | Zero Rated EC Expenses |  |
| ECZROUTPUT | 0.00 | Zero Rated EC Goods Income |  |
| ECZROUTPUTSERVICES | 0.00 | Zero Rated EC Services |  |
| EXEMPTINPUT | 0.00 | Exempt Expenses |  |
| EXEMPTOUTPUT | 0.00 | Exempt Income |  |
| GSTONIMPORTS | 0.00 | VAT on Imports | Yes |
| INPUT2 | 20.00 | 20% (VAT on Expenses) |  |
| NONE | 0.00 | No VAT | Yes |
| OUTPUT2 | 20.0 | 20% (VAT on Income) |  |
| REVERSECHARGES | 20.00 | Reverse Charge Expenses (20%) |  |
| RRINPUT | 5.00 | 5% (VAT on Expenses) |  |
| RROUTPUT | 5.00 | 5% (VAT on Income) |  |
| SRINPUT | 15.00 | 15% (VAT on Expenses) |  |
| SROUTPUT | 15.00 | 15% (VAT on Income) |  |
| ZERORATEDINPUT | 0.00 | Zero Rated Expenses |  |
| ZERORATEDOUTPUT | 0.00 | Zero Rated Income |  |

### United States

|  |  |  |  |
| --- | --- | --- | --- |
| **TAX TYPE** | **RATE** | **NAME** | **SYSTEM DEFINED** |
| INPUT | 0.00 | Tax on Purchases |  |
| NONE | 0.00 | Tax Exempt | Yes |
| OUTPUT | 0.00 | Tax on Sales |  |
| GSTONIMPORTS | 0.00 | Sales Tax on Imports | Yes |

All tax types with a ReportTaxType of 'USSALESTAX' are system defined. They have a system generated tax type (Guid), rate and name.

### Singapore

|  |  |  |
| --- | --- | --- |
| **TAX TYPE** | **RATE** | **NAME** |
| BADDEBTRECOVERY | 7.00 | 2022 Bad Debt Recovery |
| BADDEBTRELIEF | 7.00 | 2022 Bad Debt Relief |
| TXCA | 0.00 | 2022 Customer Accounting Purchases |
| DSOUTPUT | 7.00 | 2022 Deemed Supplies |
| BLINPUT2 | 0.00 | 2022 Disallowed Expenses |
| BLINPUT3 | 7.00 | 2022 Disallowed Expenses |
| IMINPUT2 | 0.00 | 2022 Imports |
| IGDSINPUT2 | 0.00 | 2022 Imports under IGDS (input tax claim) |
| IGDSINPUT3 | 0.00 | 2022 Imports under IGDS (no input tax claim) |
| IMN33 | 0.00 | 2022 Imports: non-regulation 33 exempt supplies |
| IMESS | 0.00 | 2022 Imports: regulation 33 exempt supplies |
| IMRE | 0.00 | 2022 Imports: taxable & exempt supplies |
| IM | 0.00 | 2022 Imports: taxable supplies |
| TXN33INPUT | 7.00 | 2022 PartiallyExemptTrader NonRegulation 33 Exempt |
| TXESSINPUT | 7.00 | 2022 PartiallyExemptTrader Regulation 33 Exempt |
| TXREINPUT | 7.00 | 2022 PartiallyExemptTrader Residual Input tax |
| TXPETINPUT | 7.00 | 2022 PartiallyExemptTrader Standard-Rated Purchase |
| TXRCN33 | 0.00 | 2022 Reverse charge: NonRegulation33 exempt supply |
| TXRCESS | 0.00 | 2022 Reverse charge: Regulation 33 exempt supply |
| TXRCRE | 0.00 | 2022 Reverse charge: taxable & exempt supply |
| TXRCTS | 0.00 | 2022 Reverse charge: taxable supply @ 7% |
| INPUT | 7.00 | 2022 Standard-Rated Purchases |
| OUTPUT | 7.00 | 2022 Standard-Rated Supplies |
| BADDEBTRECOVERYY23 | 8.00 | 2023 Bad Debt Recovery |
| BADDEBTRELIEFY23 | 8.00 | 2023 Bad Debt Relief |
| TXCAY23 | 0.00 | 2023 Customer Accounting Purchases |
| DSOUTPUTY23 | 8.00 | 2023 Deemed Supplies |
| BLINPUT3Y23 | 8.00 | 2023 Disallowed Expenses |
| IMINPUT2Y23 | 0.00 | 2023 Imports |
| IGDSINPUT2Y23 | 0.00 | 2023 Imports under IGDS (input tax claim) |
| IGDSINPUT3Y23 | 0.00 | 2023 Imports under IGDS (no input tax claim) |
| IMN33Y23 | 0.00 | 2023 Imports: non-regulation 33 exempt supplies |
| IMESSY23 | 0.00 | 2023 Imports: regulation 33 exempt supplies |
| IMREY23 | 0.00 | 2023 Imports: taxable & exempt supplies |
| IMY23 | 0.00 | 2023 Imports: taxable supplies |
| SROVRLVGY23 | 8.00 | 2023 LVG - electronic marketplace/redeliverer |
| SRLVGY23 | 8.00 | 2023 LVG - own supply |
| OSOUTPUT | 0.00 | 2023 Out Of Scope Supplies |
| SROVR | 7.00 | 2023 Overseas Vendor Registration Scheme Supplies |
| TXN33INPUTY23 | 8.00 | 2023 PartiallyExemptTrader NonRegulation 33 Exempt |
| TXESSINPUTY23 | 8.00 | 2023 PartiallyExemptTrader Regulation 33 Exempt |
| TXREINPUTY23 | 8.00 | 2023 PartiallyExemptTrader Residual Input tax |
| TXPETINPUTY23 | 8.00 | 2023 PartiallyExemptTrader Standard-Rated Purchase |
| SROVRRSY23 | 8.00 | 2023 Remote services - electronic marketplace |
| TXRCN33Y23 | 0.00 | 2023 Reverse charge: NonRegulation33 exempt supply |
| TXRCESSY23 | 0.00 | 2023 Reverse charge: Regulation 33 exempt supply |
| TXRCREY23 | 0.00 | 2023 Reverse charge: taxable & exempt supply |
| TXRCTSY23 | 0.00 | 2023 Reverse charge: taxable supply @ 8% |
| INPUTY23 | 8.00 | 2023 Standard-Rated Purchases |
| OUTPUTY23 | 8.00 | 2023 Standard-Rated Supplies |
| BADDEBTRECOVERYY24 | 9.00 | Bad Debt Recovery |
| BADDEBTRELIEFY24 | 9.00 | Bad Debt Relief |
| TXCAY24 | 0.00 | Customer Accounting Purchases |
| SRCAS | 0.00 | Customer Accounting Supplies by supplier |
| DSOUTPUTY24 | 9.00 | Deemed Supplies |
| BLINPUT3Y24 | 9.00 | Disallowed Expenses |
| EPINPUT | 0.00 | Exempt Purchases |
| MEINPUT | 0.00 | Imports under a Special Scheme |
| IGDSINPUT2Y24 | 0.00 | Imports under IGDS (input tax claim) |
| IGDSINPUT3Y24 | 0.00 | Imports under IGDS (no input tax claim) |
| IMN33Y24 | 0.00 | Imports: non-regulation 33 exempt supplies |
| IMESSY24 | 0.00 | Imports: regulation 33 exempt supplies |
| IMREY24 | 0.00 | Imports: taxable & exempt supplies |
| IMY24 | 0.00 | Imports: taxable supplies |
| SROVRLVGY24 | 9.00 | LVG - electronic marketplace/redeliverer |
| SRLVGY24 | 9.00 | LVG - own supply |
| NONE | 0.00 | No Tax |
| ESN33OUTPUT | 0.00 | Non-Regulation 33 Exempt Supplies |
| OPINPUT | 0.00 | Out Of Scope Purchases |
| OSOUTPUT2 | 0.00 | Out Of Scope Supplies |
| TXN33INPUTY24 | 9.00 | Partially Exempt Traders Non-Regulation 33 Exempt |
| TXESSINPUTY24 | 9.00 | Partially Exempt Traders Regulation 33 Exempt |
| TXREINPUTY24 | 9.00 | Partially Exempt Traders Residual Input tax |
| TXPETINPUTY24 | 9.00 | Partially Exempt Traders Standard-Rated Purchases |
| NRINPUT | 0.00 | Purchases from Non-GST Registered Suppliers |
| ES33OUTPUT | 0.00 | Regulation 33 Exempt Supplies |
| SROVRRSY24 | 9.00 | Remote services - electronic marketplace |
| TXRCN33Y24 | 0.00 | Reverse charge: NonRegulation33 exempt supply |
| TXRCESSY24 | 0.00 | Reverse charge: Regulation 33 exempt supply |
| TXRCREY24 | 0.00 | Reverse charge: taxable & exempt supply |
| TXRCTSY24 | 0.00 | Reverse charge: taxable supply @ 9% |
| INPUTY24 | 9.00 | Standard-Rated Purchases |
| OUTPUTY24 | 9.00 | Standard-Rated Supplies |
| TOURISTREFUND | 0.00 | Tourist Refund Claim |
| ZERORATEDINPUT | 0.00 | Zero-Rated Purchases |
| ZERORATEDOUTPUT | 0.00 | Zero-Rated Supplies |

### South Africa

|  |  |  |
| --- | --- | --- |
| **TAX TYPE** | **RATE** | **NAME** |
| ACC28PLUS | 15.00 | Accommodation exceeding 28 days |
| ACCUPTO28 | 15.00 | Accommodation under 28 days |
| BADDEBT | 15.00 | Bad Debt |
| CAPEXINPUT | 14.00 | Old Standard Rate Purchases - Capital Goods |
| CAPEXINPUT2 | 15.00 | Standard Rate Purchases - Capital Goods |
| EXEMPTINPUT | 0.00 | Exempt Purchases |
| EXEMPTOUTPUT | 0.00 | Exempt and Non-Supplies |
| GSTONCAPIMPORTS | 0.00 | Capital Goods Imported |
| IMINPUT | 0.00 | Goods and Services Imported |
| INPUT | 14.00 | Old Standard Rate Purchases |
| INPUT2 | 14.00 | Old Change in Use |
| INPUT3 | 15.00 | Standard Rate Purchases |
| INPUT4 | 15.00 | Change in Use |
| NONE | 0.00 | No VAT |
| OUTPUT | 14.00 | Old Standard Rate Sales |
| OTHERINPUT | 0.00 | Other Purchase |
| OTHEROUTPUT | 0.00 | Other Sales |
| OUTPUT | 14.00 | Old Standard Rate Sales |
| OUTPUT2 | 14.00 | Old Change in use and Export of Second-hand Goods |
| OUTPUT3 | 15.00 | Standard Rate Sales |
| OUTPUT4 | 15.00 | Change in use and Export of Second-hand Goods |
| SHOUTPUT | 15.00 | Export of Second-hand Goods |
| SROUTPUT | 14.00 | Old Standard Rate Sales - Capital Goods |
| SROUTPUT2 | 15.00 | Standard Rate Sales - Capital Goods |
| ZERORATED | 0.00 | Zero rate (Excluding Goods Exported) |
| ZERORATEDOUTPUT | 0.00 | Zero Rate (only Exported Goods) |
| ZRINPUT | 0.00 | Zero Rated Purchases |

## Tracking Categories


### Tracking Categories Status Codes

|  |  |
| --- | --- |
| **ACTIVE** | The tracking category is active and can be used in transactions. |
| **ARCHIVED** | The tracking category has been used on a transaction (e.g. an invoice) but has since been deleted |

Note: A Xero organisation can have a maximum of two ACTIVE tracking categories and four tracking categories total (2 ACTIVE and 2 ARCHIVED)

### Tracking Options Status Codes

|  |  |
| --- | --- |
| **ACTIVE** | The tracking option is active and can be used in transactions. |
| **ARCHIVED** | The tracking option has been used on a transaction (e.g. an invoice) but has since been deleted |

## User Roles


|  |  |
| --- | --- |
| **READONLY** | Read only user – [Further info](http://help.xero.com/#Settings_UsersRoles$BK_Read) |
| **INVOICEONLY** | Invoice only user – [Further info](http://help.xero.com/#Settings_UsersRoles$BK_Employee) |
| **STANDARD** | Standard user – [Further info](http://help.xero.com/#Settings_UsersRoles$BK_Standard) |
| **FINANCIALADVISER** | Financial adviser role – [Further info](http://help.xero.com/#Settings_UsersRoles$BK_FAAE) |
| **MANAGEDCLIENT** | Managed client role (Partner Edition only) – [Further info](http://help.xero.com/#Settings_UsersRoles$BK_ManagedClient) |
| **CASHBOOKCLIENT** | Cashbook client role (Partner Edition only) – [Further info](http://help.xero.com/#Settings_UsersRoles$BK_CashClient) |
