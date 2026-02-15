# Organisation


## Overview


| Property | Description |
| --- | --- |
| URL | [https://api.xero.com/api.xro/2.0/Organisation](https://api.xero.com/api.xro/2.0/Organisation) |
| Methods Supported | GET |
| Description | Returns information about a Xero organisation. The organisation will be the one specified in the xero-tenant-id header, or in the case of a custom connection, the organisation connected to the app. |

## GET Organisation


The following elements are returned in a response

| Property | Description |
| --- | --- |
| APIKey | Display a unique key used for [Xero-to-Xero transactions](http://help.xero.com/#X2XSendKey) |
| Name | Display name of organisation shown in Xero |
| LegalName | Organisation name shown on Reports |
| PaysTax | Boolean to describe if organisation is registered with a local tax authority i.e. true, false |
| Version | See Version Types |
| OrganisationType | Organisation Type |
| BaseCurrency | Default currency for organisation. See [ISO 4217 Currency Codes](http://www.xe.com/iso4217.php) |
| CountryCode | Country code for organisation. See [ISO 3166-2 Country Codes](http://countrycode.org/) |
| IsDemoCompany | Boolean to describe if organisation is a demo company. |
| OrganisationStatus | Will be set to ACTIVE if you can connect to organisation via the Xero API |
| RegistrationNumber | Shows for New Zealand, Australian and UK organisations |
| EmployerIdentificationNumber | Shown if set. US Only. |
| TaxNumber | Shown if set. Displays in the Xero UI as Tax File Number (AU), GST Number (NZ), VAT Number (UK) and Tax ID Number (US & Global). |
| FinancialYearEndDay | Calendar day e.g. 0-31 |
| FinancialYearEndMonth | Calendar Month e.g. 1-12 |
| SalesTaxBasis | The accounting basis used for tax returns. See Sales Tax Basis |
| SalesTaxPeriod | The frequency with which tax returns are processed. See Sales Tax Period |
| DefaultSalesTax | The default for LineAmountTypes on sales transactions |
| DefaultPurchasesTax | The default for LineAmountTypes on purchase transactions |
| PeriodLockDate | Shown if set. See [lock dates](http://help.xero.com/#Settings_LockDate) |
| EndOfYearLockDate | Shown if set. See [lock dates](http://help.xero.com/#Settings_LockDate) |
| CreatedDateUTC | Timestamp when the organisation was created in Xero |
| Timezone | [Timezone specifications](https://github.com/XeroAPI/XeroAPI-Schemas/blob/master/src/main/resources/XeroSchemas/v2.00/Timezone.xsd) |
| OrganisationEntityType | Organisation Type |
| ShortCode | A unique identifier for the organisation. Used in a number of [potential use cases](https://developer.xero.com/community-forum-archive) such as deep linking. |
| OrganisationID | The Xero generated unique identifier for the organisation. . |
| Edition | BUSINESS or PARTNER. [Partner edition](https://www.xero.com/features-and-tools/practice-tools/ledger-cashbook/) organisations are sold exclusively through accounting partners and have restricted functionality (e.g. no access to invoicing) . |
| Class | Organisation Classes describe which plan the Xero organisation is on (e.g. DEMO, TRIAL, PREMIUM). |
| LineOfBusiness | Description of business type as defined in [Organisation settings](https://go.xero.com/Settings/Organisation) |
| Addresses | Address details for organisation – see Addresses |
| Phones | Phones details for organisation – see Phones |
| ExternalLinks | Organisation profile links for popular services such as Facebook, Twitter, GooglePlus and LinkedIn. You can also add link to your website here. Shown if [Organisation settings](https://go.xero.com/Settings/Organisation) is updated in Xero. See ExternalLinks below |
| PaymentTerms | Default payment terms for the organisation if set – See Payment Terms below |

Elements for PaymentTerms

| Property | Description |
| --- | --- |
| Bills | Default payment terms for bills (accounts payable) |
| Sales | Default payment terms for sales invoices (accounts receivable) |

Elements for Bills and Sales

| Property | Description |
| --- | --- |
| Day | Day of Month (0-31) |
| Type | The type of payment term – see Payment Terms |

Elements for ExternalLinks

| Property | Description |
| --- | --- |
| LinkType | See External link types |
| Url | URL for service e.g. [http://twitter.com/xeroapi](http://twitter.com/xeroapi) |

Example response for GET Organisation

```
GET https://api.xero.com/api.xro/2.0/Organisation
```


```
{
  "Organisations": [
    {
      "APIKey": "PV1PS57LYQ7VDJYTGCUI99A6YJI1WZ",
      "Name": "Demo Company (NZ)",
      "LegalName": "Demo Company (NZ)",
      "PaysTax": true,
      "Version": "NZ",
      "OrganisationType": "COMPANY",
      "BaseCurrency": "NZD",
      "CountryCode": "NZ",
      "IsDemoCompany": true,
      "OrganisationStatus": "ACTIVE",
      "TaxNumber": "101-2-303",
      "FinancialYearEndDay": 31,
      "FinancialYearEndMonth": 3,
      "SalesTaxBasis": "PAYMENTS",
      "SalesTaxPeriod": "TWOMONTHS",
      "PeriodLockDate": "\/Date(1254268800000+0000)\/",
      "CreatedDateUTC": "\/Date(1488338543217)\/",
      "OrganisationEntityType": "COMPANY",
      "Timezone": "NEWZEALANDSTANDARDTIME",
      "ShortCode": "!23eYt",
      "OrganisationID": "c3d5e782-2153-4cda-bdb4-cec791ceb90d",
      "Edition": "BUSINESS",
      "Class": "DEMO",
      "Addresses": [
        {
          "AddressType": "POBOX",
          "AddressLine1": "3 Market Place",
          "AddressLine2": "Twizel 7901",
          "City": "Twizel",
          "PostalCode": "7901",
          "Country": "New Zealand",
          "AttentionTo": "Bentley Rhythm Ace"
        }
      ],
      "ExternalLinks": [
        {
          "LinkType": "Facebook",
          "Url": "http://facebook.com/Xero.Accounting"
        },
        {
          "LinkType": "Twitter",
          "Url": "http://twitter.com/xeroapi"
        },
        {
          "LinkType": "GooglePlus",
          "Url": "https://plus.google.com/u/0/105727595143346068928/"
        },
        {
          "LinkType": "LinkedIn",
          "Url": "http://www.linkedin.com/company/xero"
        }
      ],
      "PaymentTerms": {
        "Bills": {
          "Day": 5,
          "Type": "OFCURRENTMONTH"
        },
        "Sales": {
          "Day": 20,
          "Type": "OFFOLLOWINGMONTH"
        }
      }
    }
  ]
}
```


## GET Organisation Actions


Retrieve a list of the key actions your app has permission to perform in the connected organisation. An action will be ALLOWED if the right feature is available in the organisation's plan and the user, who made the connection, has permission to perform that action e.g. 'CreateApprovedInvoice'.

This is not meant to represent a comprehensive list of all the actions that can be performed via the Accounting API. These particular actions have been exposed because they differ between Xero plans (and impact integrations) most frequently.

| Property | Description |
| --- | --- |
| Actions | Actions that are available in the organisation |

Elements for Actions

| Property | Description |
| --- | --- |
| Name | Name of the action. For e.g 'CreateApprovedInvoice' |
| Status | Status of the access to the action. Returns either ALLOWED or NOT-ALLOWED. |

Example response for GET Organisation Actions

```
GET https://api.xero.com/api.xro/2.0/Organisation/Actions
```


```
{
 "Actions": [
    {
      "Name": "ViewBillableExpenses",
      "Status": "ALLOWED"
    },
    {
      "Name": "DeleteBillableExpense",
      "Status": "ALLOWED"
    },
    {
      "Name": "ViewBrandingThemePaymentServices",
      "Status": "ALLOWED"
    },
    {
      "Name": "ViewBASReport",
      "Status": "ALLOWED"
    },
    {
      "Name": "ViewTenNinetyNineReport",
      "Status": "ALLOWED"
    },
    {
      "Name": "ViewBrandingThemes",
      "Status": "ALLOWED"
    },
    {
      "Name": "CreateBillableExpense",
      "Status": "ALLOWED"
    },
    {
      "Name": "ViewProfitAndLossReport",
      "Status": "ALLOWED"
    },
    {
      "Name": "UseMulticurrency",
      "Status": "ALLOWED"
    },
    {
      "Name": "ViewPayments",
      "Status": "ALLOWED"
    },
    {
      "Name": "ViewInvoices",
      "Status": "ALLOWED"
    },
    {
      "Name": "CreateDraftPurchaseOrder",
      "Status": "ALLOWED"
    },
    {
      "Name": "CreateBillPayment",
      "Status": "ALLOWED"
    },
    {
      "Name": "CreateARCreditAllocation",
      "Status": "ALLOWED"
    },
    {
      "Name": "CreateAPCreditAllocation",
      "Status": "ALLOWED"
    },
    {
      "Name": "VoidBill",
      "Status": "ALLOWED"
    },
    {
      "Name": "DeleteRepeatingInvoice",
      "Status": "ALLOWED"
    },
    {
      "Name": "CreateDraftBill",
      "Status": "ALLOWED"
    },
    {
      "Name": "CreateApprovedBill",
      "Status": "ALLOWED"
    },
    {
      "Name": "UpdatePaidInvoice",
      "Status": "ALLOWED"
    },
    {
      "Name": "ViewExecutiveSummaryReport",
      "Status": "ALLOWED"
    },
    {
      "Name": "AdministerPayroll",
      "Status": "NOT-ALLOWED"
    },
    {
      "Name": "ViewTrialBalanceReport",
      "Status": "ALLOWED"
    },
    {
      "Name": "ViewAgedReceivablesByContactReport",
      "Status": "ALLOWED"
    },
    {
      "Name": "ApproveTransactionsBeforePeriodLockDate",
      "Status": "ALLOWED"
    },
    {
      "Name": "CreatePaymentService",
      "Status": "ALLOWED"
    },
    {
      "Name": "DeleteDraftInvoice",
      "Status": "ALLOWED"
    },
    {
      "Name": "CreateSentQuote",
      "Status": "ALLOWED"
    },
    {
      "Name": "CreateApprovedInvoice",
      "Status": "ALLOWED"
    },
    {
      "Name": "UpdateBillableExpense",
      "Status": "ALLOWED"
    },
    {
      "Name": "UpdateBrandingThemePaymentServices",
      "Status": "ALLOWED"
    },
    {
      "Name": "ViewAgedPayablesByContactReport",
      "Status": "ALLOWED"
    },
    {
      "Name": "CreateDraftQuote",
      "Status": "ALLOWED"
    },
    {
      "Name": "DeleteDraftBill",
      "Status": "ALLOWED"
    },
    {
      "Name": "ViewGSTReport",
      "Status": "ALLOWED"
    },
    {
      "Name": "CreateApprovedPurchaseOrder",
      "Status": "ALLOWED"
    },
    {
      "Name": "CreateInvoicePayment",
      "Status": "ALLOWED"
    },
    {
      "Name": "ViewBalanceSheetReport",
      "Status": "ALLOWED"
    },
    {
      "Name": "CreateDraftInvoice",
      "Status": "ALLOWED"
    },
    {
      "Name": "ViewBudgetSummaryReport",
      "Status": "ALLOWED"
    },
    {
      "Name": "ViewPaymentServices",
      "Status": "ALLOWED"
    },
    {
      "Name": "VoidInvoice",
      "Status": "ALLOWED"
    },
    {
      "Name": "ViewBankSummaryReport",
      "Status": "ALLOWED"
    },
    {
      "Name": "ViewBills",
      "Status": "ALLOWED"
    },
    {
      "Name": "CreateRepeatingInvoice",
      "Status": "ALLOWED"
    },
    {
      "Name": "ViewContacts",
      "Status": "ALLOWED"
    },
    {
      "Name": "CreateContact",
      "Status": "ALLOWED"
    },
    {
      "Name": "ArchiveContact",
      "Status": "ALLOWED"
    },
    {
      "Name": "UpdateContact",
      "Status": "ALLOWED"
    },
    {
      "Name": "ViewContactsWithUSTaxIdentities",
      "Status": "ALLOWED"
    },
    {
      "Name": "UpdateContactUSTaxIdentity",
      "Status": "ALLOWED"
    }
  ]
}
```


## CIS Settings (UK)


To verify if an organisation is using contruction industry scheme, you can retrieve the CIS settings for the organistaion.

To retrieve CIS details, you have to do a GET request with OrganisationID and need to additionally specify CISSettings in your url. Refer to the request and response sample.

The following is returned for the CIS settings of an Organisation

| Property | Description |
| --- | --- |
| CISContractorEnabled | true or false – Boolean that describes if the organisation is a CIS Contractor |
| CISSubContractorEnabled | true or false – Boolean that describes if the organisation is a CIS SubContractor |

Example of retrieving CIS settings for an organisation

```
GET https://api.xero.com/api.xro/2.0/Organisation/bd2270c3-8706-4c11-9cfb-000b551c3f51/CISSettings
```


```
{
  "CISContractorEnabled": true,
  "CISSubContractorEnabled": true
}
```
