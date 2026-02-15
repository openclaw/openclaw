# Reports


## Overview


Xero's most commonly viewed reports (listed below) can be retrieved using the Xero API. These reports typically contain a summary of data that may be useful for your own application. e.g. it may be more easier and more efficient to use a Report endpoint to fetch data rather than retrieve individual invoices and total these yourself.

### Endpoints

Each report has its own endpoint e.g. `https://api.xero.com/api.xro/2.0/Reports/[Report Name]` and can be returned in either XML (default) or JSON format.

### Permissions

An application that has been authorised by a Standard user with the "No reports" role will not be able to access the Reports or Journals endpoints (A HTTP 403 error will be returned in this case).

### Parameters

Each report has different optional parameters. The report parameters should be added as a separate query strings. For example:

GET [https://api.xero.com/api.xro/2.0/Reports/AgedReceivablesByContact?fromDate=2010-01-01&toDate=2011-01-01](https://api.xero.com/api.xro/2.0/Reports/AgedReceivablesByContact?fromDate=2010-01-01&toDate=2011-01-01)

### Layout

The layout of each report is a collection of rows and cells. Rows can be of various types (e.g. header, section, row and summary row elements). Cells can contain values and attributes with nested values.

Try the [API Explorer](https://api-explorer.xero.com/) to get familiar with the response format for each report or see the Trial Balance example below.

More details about each reporting endpoint are listed below. To learn more about the composition of specific reports refer to the [Report Centre](https://go.xero.com/Reports/Default.aspx).

|  |
| --- |
| 1099 Report (US organisations only) |
| Aged Payables By Contact |
| Aged Receivables By Contact |
| Balance Sheet |
| Bank Summary |
| BAS Report (Australia organisations only) |
| Budget Summary |
| Executive Summary |
| GST Report (New Zealand organisations only) |
| Profit And Loss |
| Trial Balance |

## 1099 Report


|  |  |
| --- | --- |
| URL | [https://api.xero.com/api.xro/2.0/Reports/TenNinetyNine](https://api.xero.com/api.xro/2.0/Reports/TenNinetyNine) |
| Methods Supported | GET |
| Description | Returns the 1099 report, for all years from 2012, as configured by the rules in the Xero app.<br>The 1099 report includes both the 1099-NEC and 1099-MISC forms for all reports in years 2020 onward. For reports 2019 and prior, only the 1099-MISC form applies.<br>This report is available to US organizations only. To access this report, the user must have the advisor user role in the organization. |

### Optional parameters for GET 1099

|  |  |
| --- | --- |
| reportYear | Year of the report e.g. 2025 |

List of supported Federal Tax Classification values:

- SOLE\_PROPRIETOR
- PARTNERSHIP
- TRUST\_OR\_ESTATE
- NONPROFIT
- C\_CORP
- S\_CORP
- OTHER

Example response for GET TenNinetyNine (2025 and after)

```
GET https://api.xero.com/api.xro/2.0/Reports/TenNinetyNine?reportYear=2025
```


```
{
  "Id": "8b474ddb-9ef4-457c-8640-1c0e3670ea0e",
  "Status": "OK",
  "ProviderName": "Hornblower Enterprises",
  "DateTimeUTC": "/Date(1768435200)/",
  "Reports": [
    {
      "ReportName": "1099-NEC report",
      "ReportDate": "1 Jan 2025 to 31 Dec 2025",
      "Fields": [],
      "Contacts": [
        {
          "Box1": 0.0,
          "Box2": 0.0,
          "Box3": 0.0,
          "Box4": 1000.0,
          "Name": "Bank West",
          "FederalTaxIDType": "SSN",
          "City": "Pinehaven",
          "Zip": "12345",
          "State": "CA",
          "Email": "test_one@example.com",
          "StreetAddress": "Procurement Services\r\nGPO 1234\r\n\r\n\r\n",
          "TaxID": "234-22-2223",
          "ContactId": "81d5706a-8057-4338-8511-747cd85f4c68",
          "LegalName": "Test One",
          "BusinessName": "Bank West",
          "FederalTaxClassification": "SOLE_PROPRIETOR"
        },
        {
          "Box1": 0.0,
          "Box2": 0.0,
          "Box3": 0.0,
          "Box4": 1000.0,
          "Name": "Hoyt Productions",
          "FederalTaxIDType": "SSN",
          "City": "Oaktown",
          "Zip": "45123",
          "State": "NY",
          "Email": "test_two@example.com",
          "StreetAddress": "100 Rusty Ridge Road\r\nSuite 100\r\n\r\n\r\n",
          "TaxID": "123-45-6780",
          "ContactId": "19732b6a-9a5c-4651-b33c-3f8f682e2a2b",
          "LegalName": "Test Two",
          "BusinessName": "Hoyt Productions",
          "FederalTaxClassification": "SOLE_PROPRIETOR"
        },
        {
          "Box1": 1000.0,
          "Box2": 0.0,
          "Box3": 0.0,
          "Box4": 0.0,
          "Name": "Truxton Property Management",
          "FederalTaxIDType": "EIN",
          "City": "Coppertown",
          "Zip": "21321",
          "State": "FL",
          "Email": "test_three@example.com",
          "StreetAddress": "1000 Copper Avenue\r\nSuite 1000\r\n\r\n\r\n",
          "TaxID": "33-3332233",
          "ContactId": "018355fc-c67e-4352-b443-ef3873031983",
          "LegalName": "Test Three",
          "BusinessName": "Truxton Property Management",
          "FederalTaxClassification": "SOLE_PROPRIETOR"
        }
      ]
    },
    {
      "ReportName": "1099-MISC report",
      "ReportDate": "1 Jan 2025 to 31 Dec 2025",
      "Fields": [],
      "Contacts": [
        {
          "Box1": 5543.75,
          "Box2": 0.0,
          "Box3": 0.0,
          "Box4": 0.0,
          "Box5": 0.0,
          "Box6": 0.0,
          "Box7": 0.0,
          "Box8": 0.0,
          "Box9": 0.0,
          "Box10": 0.0,
          "Box11": 0.0,
          "Name": "Bank West",
          "FederalTaxIDType": "SSN",
          "City": "Pinehaven",
          "Zip": "12345",
          "State": "CA",
          "Email": "test_one@example.com",
          "StreetAddress": "Procurement Services\r\nGPO 1234\r\n\r\n\r\n",
          "TaxID": "234-22-2223",
          "ContactId": "81d5706a-8057-4338-8511-747cd85f4c68",
          "LegalName": "Test One",
          "BusinessName": "Bank West",
          "FederalTaxClassification": "SOLE_PROPRIETOR"
        },
        {
          "Box1": 0.0,
          "Box2": 0.0,
          "Box3": 600.0,
          "Box4": 0.0,
          "Box5": 0.0,
          "Box6": 0.0,
          "Box7": 0.0,
          "Box8": 0.0,
          "Box9": 0.0,
          "Box10": 0.0,
          "Box11": 0.0,
          "Name": "Hoyt Productions",
          "FederalTaxIDType": "SSN",
          "City": "Oaktown",
          "Zip": "45123",
          "State": "NY",
          "Email": "test_two@example.com",
          "StreetAddress": "100 Rusty Ridge Road\r\nSuite 100\r\n\r\n\r\n",
          "TaxID": "123-45-6780",
          "ContactId": "19732b6a-9a5c-4651-b33c-3f8f682e2a2b",
          "LegalName": "Test Two",
          "BusinessName": "Hoyt Productions",
          "FederalTaxClassification": "SOLE_PROPRIETOR"
        },
        {
          "Box1": 0.0,
          "Box2": 0.0,
          "Box3": 0.0,
          "Box4": 0.0,
          "Box5": 2100.0,
          "Box6": 0.0,
          "Box7": 0.0,
          "Box8": 0.0,
          "Box9": 0.0,
          "Box10": 0.0,
          "Box11": 0.0,
          "Name": "Truxton Property Management",
          "FederalTaxIDType": "EIN",
          "City": "Coppertown",
          "Zip": "21321",
          "State": "FL",
          "Email": "test_three@example.com",
          "StreetAddress": "1000 Copper Avenue\r\nSuite 1000\r\n\r\n\r\n",
          "TaxID": "33-3332233",
          "ContactId": "018355fc-c67e-4352-b443-ef3873031983",
          "LegalName": "Test Three",
          "BusinessName": "Truxton Property Management",
          "FederalTaxClassification": "SOLE_PROPRIETOR"
        }
      ]
    }
  ]
}
```


Example response for GET TenNinetyNine (2022, 2023, and 2024)

```
GET https://api.xero.com/api.xro/2.0/Reports/TenNinetyNine?reportYear=2022
```


```
{
  "Id": "8b474ddb-9ef4-457c-8640-1c0e3670ea0e",
  "Status": "OK",
  "ProviderName": "Hornblower Enterprises",
  "DateTimeUTC": "/Date(1662597051457)/",
  "Reports": [
    {
      "ReportName": "1099-NEC report",
      "ReportDate": "1 Jan 2022 to 31 Dec 2022",
      "Fields": [],
      "Contacts": [
        {
          "Box1": 0.0,
          "Box2": 0.0,
          "Box4": 1000.0,
          "Name": "Bank West",
          "FederalTaxIDType": "SSN",
          "City": "Pinehaven",
          "Zip": "12345",
          "State": "CA",
          "Email": "test_one@example.com",
          "StreetAddress": "Procurement Services\r\nGPO 1234\r\n\r\n\r\n",
          "TaxID": "234-22-2223",
          "ContactId": "81d5706a-8057-4338-8511-747cd85f4c68",
          "LegalName": "Test One",
          "BusinessName": "Bank West",
          "FederalTaxClassification": "SOLE_PROPRIETOR"
        },
        {
          "Box1": 0.0,
          "Box2": 0.0,
          "Box4": 1000.0,
          "Name": "Hoyt Productions",
          "FederalTaxIDType": "SSN",
          "City": "Oaktown",
          "Zip": "45123",
          "State": "NY",
          "Email": "test_two@example.com",
          "StreetAddress": "100 Rusty Ridge Road\r\nSuite 100\r\n\r\n\r\n",
          "TaxID": "123-45-6780",
          "ContactId": "19732b6a-9a5c-4651-b33c-3f8f682e2a2b",
          "LegalName": "Test Two",
          "BusinessName": "Hoyt Productions",
          "FederalTaxClassification": "SOLE_PROPRIETOR"
        },
        {
          "Box1": 0.0,
          "Box2": 0.0,
          "Box4": 1000.0,
          "Name": "Truxton Property Management",
          "FederalTaxIDType": "EIN",
          "City": "Coppertown",
          "Zip": "21321",
          "State": "FL",
          "Email": "test_three@example.com",
          "StreetAddress": "1000 Copper Avenue\r\nSuite 1000\r\n\r\n\r\n",
          "TaxID": "33-3332233",
          "ContactId": "018355fc-c67e-4352-b443-ef3873031983",
          "LegalName": "Test Three",
          "BusinessName": "Truxton Property Management",
          "FederalTaxClassification": "SOLE_PROPRIETOR"
        }
      ]
    },
    {
      "ReportName": "1099-MISC report",
      "ReportDate": "1 Jan 2022 to 31 Dec 2022",
      "Fields": [],
      "Contacts": [
        {
          "Box1": 5543.75,
          "Box2": 0.0,
          "Box3": 0.0,
          "Box4": 0.0,
          "Box5": 0.0,
          "Box6": 0.0,
          "Box7": 0.0,
          "Box8": 0.0,
          "Box9": 0.0,
          "Box10": 0.0,
          "Box11": 0.0,
          "Box14": 0.0,
          "Name": "Bank West",
          "FederalTaxIDType": "SSN",
          "City": "Pinehaven",
          "Zip": "12345",
          "State": "CA",
          "Email": "test_one@example.com",
          "StreetAddress": "Procurement Services\r\nGPO 1234\r\n\r\n\r\n",
          "TaxID": "234-22-2223",
          "ContactId": "81d5706a-8057-4338-8511-747cd85f4c68",
          "LegalName": "Test One",
          "BusinessName": "Bank West",
          "FederalTaxClassification": "SOLE_PROPRIETOR"
        },
        {
          "Box1": 5543.75,
          "Box2": 0.0,
          "Box3": 0.0,
          "Box4": 0.0,
          "Box5": 0.0,
          "Box6": 0.0,
          "Box7": 0.0,
          "Box8": 0.0,
          "Box9": 0.0,
          "Box10": 0.0,
          "Box11": 0.0,
          "Box14": 0.0,
          "Name": "Hoyt Productions",
          "FederalTaxIDType": "SSN",
          "City": "Oaktown",
          "Zip": "45123",
          "State": "NY",
          "Email": "test_two@example.com",
          "StreetAddress": "100 Rusty Ridge Road\r\nSuite 100\r\n\r\n\r\n",
          "TaxID": "123-45-6780",
          "ContactId": "19732b6a-9a5c-4651-b33c-3f8f682e2a2b",
          "LegalName": "Test Two",
          "BusinessName": "Hoyt Productions",
          "FederalTaxClassification": "SOLE_PROPRIETOR"
        },
        {
          "Box1": 5543.75,
          "Box2": 0.0,
          "Box3": 0.0,
          "Box4": 0.0,
          "Box5": 0.0,
          "Box6": 0.0,
          "Box7": 0.0,
          "Box8": 0.0,
          "Box9": 0.0,
          "Box10": 0.0,
          "Box11": 0.0,
          "Box14": 0.0,
          "Name": "Truxton Property Management",
          "FederalTaxIDType": "EIN",
          "City": "Coppertown",
          "Zip": "21321",
          "State": "FL",
          "Email": "test_three@example.com",
          "StreetAddress": "1000 Copper Avenue\r\nSuite 1000\r\n\r\n\r\n",
          "TaxID": "33-3332233",
          "ContactId": "018355fc-c67e-4352-b443-ef3873031983",
          "LegalName": "Test Three",
          "BusinessName": "Truxton Property Management",
          "FederalTaxClassification": "SOLE_PROPRIETOR"
        }
      ]
    }
  ]
}
```


Example response for GET TenNinetyNine (2021)

```
GET https://api.xero.com/api.xro/2.0/Reports/TenNinetyNine?reportYear=2021
```


```
{
  "Id": "8b474ddb-9ef4-457c-8640-1c0e3670ea0e",
  "Status": "OK",
  "ProviderName": "Hornblower Enterprises",
  "DateTimeUTC": "/Date(1631061090000)/",
  "Reports": [
    {
      "ReportName": "1099-NEC report",
      "ReportDate": "1 Jan 2021 to 31 Dec 2021",
      "Fields": [],
      "Contacts": [
        {
          "Box1": 0.0,
          "Box2": 0.0,
          "Box4": 1000.0,
          "Name": "Bank West",
          "FederalTaxIDType": "SSN",
          "City": "Pinehaven",
          "Zip": "12345",
          "State": "CA",
          "Email": "test_one@example.com",
          "StreetAddress": "Procurement Services\r\nGPO 1234\r\n\r\n\r\n",
          "TaxID": "234-22-2223",
          "ContactId": "81d5706a-8057-4338-8511-747cd85f4c68",
          "LegalName": "Test One",
          "BusinessName": "Bank West",
          "FederalTaxClassification": "SOLE_PROPRIETOR"
        },
        {
          "Box1": 0.0,
          "Box2": 0.0,
          "Box4": 1000.0,
          "Name": "Hoyt Productions",
          "FederalTaxIDType": "SSN",
          "City": "Oaktown",
          "Zip": "45123",
          "State": "NY",
          "Email": "test_two@example.com",
          "StreetAddress": "100 Rusty Ridge Road\r\nSuite 100\r\n\r\n\r\n",
          "TaxID": "123-45-6780",
          "ContactId": "19732b6a-9a5c-4651-b33c-3f8f682e2a2b",
          "LegalName": "Test Two",
          "BusinessName": "Hoyt Productions",
          "FederalTaxClassification": "SOLE_PROPRIETOR"
        },
        {
          "Box1": 0.0,
          "Box2": 0.0,
          "Box4": 1000.0,
          "Name": "Truxton Property Management",
          "FederalTaxIDType": "EIN",
          "City": "Coppertown",
          "Zip": "21321",
          "State": "FL",
          "Email": "test_three@example.com",
          "StreetAddress": "1000 Copper Avenue\r\nSuite 1000\r\n\r\n\r\n",
          "TaxID": "33-3332233",
          "ContactId": "018355fc-c67e-4352-b443-ef3873031983",
          "LegalName": "Test Three",
          "BusinessName": "Truxton Property Management",
          "FederalTaxClassification": "SOLE_PROPRIETOR"
        }
      ]
    },
    {
      "ReportName": "1099-MISC report",
      "ReportDate": "1 Jan 2021 to 31 Dec 2021",
      "Fields": [],
      "Contacts": [
        {
          "Box1": 5543.75,
          "Box2": 0.0,
          "Box3": 0.0,
          "Box4": 0.0,
          "Box5": 0.0,
          "Box6": 0.0,
          "Box7": 0.0,
          "Box8": 0.0,
          "Box9": 0.0,
          "Box10": 0.0,
          "Box11": 0.0,
          "Box13": 0.0,
          "Name": "Bank West",
          "FederalTaxIDType": "SSN",
          "City": "Pinehaven",
          "Zip": "12345",
          "State": "CA",
          "Email": "test_one@example.com",
          "StreetAddress": "Procurement Services\r\nGPO 1234\r\n\r\n\r\n",
          "TaxID": "234-22-2223",
          "ContactId": "81d5706a-8057-4338-8511-747cd85f4c68",
          "LegalName": "Test One",
          "BusinessName": "Bank West",
          "FederalTaxClassification": "SOLE_PROPRIETOR"
        },
        {
          "Box1": 5543.75,
          "Box2": 0.0,
          "Box3": 0.0,
          "Box4": 0.0,
          "Box5": 0.0,
          "Box6": 0.0,
          "Box7": 0.0,
          "Box8": 0.0,
          "Box9": 0.0,
          "Box10": 0.0,
          "Box11": 0.0,
          "Box13": 0.0,
          "Name": "Hoyt Productions",
          "FederalTaxIDType": "SSN",
          "City": "Oaktown",
          "Zip": "45123",
          "State": "NY",
          "Email": "test_two@example.com",
          "StreetAddress": "100 Rusty Ridge Road\r\nSuite 100\r\n\r\n\r\n",
          "TaxID": "123-45-6780",
          "ContactId": "19732b6a-9a5c-4651-b33c-3f8f682e2a2b",
          "LegalName": "Test Two",
          "BusinessName": "Hoyt Productions",
          "FederalTaxClassification": "SOLE_PROPRIETOR"
        },
        {
          "Box1": 5543.75,
          "Box2": 0.0,
          "Box3": 0.0,
          "Box4": 0.0,
          "Box5": 0.0,
          "Box6": 0.0,
          "Box7": 0.0,
          "Box8": 0.0,
          "Box9": 0.0,
          "Box10": 0.0,
          "Box11": 0.0,
          "Box13": 0.0,
          "Name": "Truxton Property Management",
          "FederalTaxIDType": "EIN",
          "City": "Coppertown",
          "Zip": "21321",
          "State": "FL",
          "Email": "test_three@example.com",
          "StreetAddress": "1000 Copper Avenue\r\nSuite 1000\r\n\r\n\r\n",
          "TaxID": "33-3332233",
          "ContactId": "018355fc-c67e-4352-b443-ef3873031983",
          "LegalName": "Test Three",
          "BusinessName": "Truxton Property Management",
          "FederalTaxClassification": "SOLE_PROPRIETOR"
        }
      ]
    }
  ]
}
```


## Aged Payables By Contact


|  |  |
| --- | --- |
| URL | [https://api.xero.com/api.xro/2.0/Reports/AgedPayablesByContact](https://api.xero.com/api.xro/2.0/Reports/AgedPayablesByContact) |
| Methods Supported | GET |
| Description | Returns aged payables up to the end of the current month by default |

### Required parameters for GET AgedPayablesByContact

|  |  |
| --- | --- |
| contactID | Contact ID e.g. 5040915e-8ce7-4177-8d08-fde416232f18 |

### Optional parameters for GET AgedPayablesByContact

|  |  |
| --- | --- |
| date | Shows payments up to this date e.g. 2014-04-30. Defaults to end of the current month |
| fromDate | Show all payable invoices from this date for contact |
| toDate | Show all payable invoices to this date for the contact |

Example response for GET AgedPayablesByContact

```
GET https://api.xero.com/api.xro/2.0/Reports/AgedPayablesByContact?ContactID=5040915e-8ce7-4177-8d08-fde416232f18
```


```
{
  "Reports": [
    {
      "ReportID": "AgedPayablesByContact",
      "ReportName": "Aged Payables By Contact",
      "ReportType": "AgedPayablesByContact",
      "ReportTitles": [
        "Invoices",
        "Xero",
        "To 28 February 2018",
        "Showing payments to 28 February 2018"
      ],
      "ReportDate": "23 February 2018",
      "UpdatedDateUTC": "\/Date(1519357171249)\/",
      "Rows": [
        {
          "RowType": "Header",
          "Cells": [
            { "Value": "Date" },
            { "Value": "Reference" },
            { "Value": "Due Date" },
            { "Value": "" },
            { "Value": "Total" },
            { "Value": "Paid" },
            { "Value": "Credited" },
            { "Value": "Due" }
          ]
        },{
          "RowType": "Section",
          "Rows": [
            {
              "RowType": "Row",
              "Cells": [
                {
                  "Value": "2018-01-15T00:00:00",
                  "Attributes": [
                    {
                      "Value": "935fc854-8037-4111-8d91-993010c331cc",
                      "Id": "invoiceID"
                    }
                  ]
                },
                {
                  "Value": "",
                  "Attributes": [
                    {
                      "Value": "935fc854-8037-4111-8d91-993010c331cc",
                      "Id": "invoiceID"
                    }
                  ]
                },{
                  "Value": "2018-01-15T00:00:00",
                  "Attributes": [
                    {
                      "Value": "935fc854-8037-4111-8d91-993010c331cc",
                      "Id": "invoiceID"
                    }
                  ]
                },{
                  "Value": "",
                  "Attributes": [
                    {
                      "Value": "935fc854-8037-4111-8d91-993010c331cc",
                      "Id": "invoiceID"
                    }
                  ]
                },{
                  "Value": "53.90",
                  "Attributes": [
                    {
                      "Value": "935fc854-8037-4111-8d91-993010c331cc",
                      "Id": "invoiceID"
                    }
                  ]
                },{
                  "Value": "53.90",
                  "Attributes": [
                    {
                      "Value": "935fc854-8037-4111-8d91-993010c331cc",
                      "Id": "invoiceID"
                    }
                  ]
                },{
                  "Value": "0.00",
                  "Attributes": [
                    {
                      "Value": "935fc854-8037-4111-8d91-993010c331cc",
                      "Id": "invoiceID"
                    }
                  ]
                },{
                  "Value": "0.00",
                  "Attributes": [
                    {
                      "Value": "935fc854-8037-4111-8d91-993010c331cc",
                      "Id": "invoiceID"
                    }
                  ]
                }
              ]
            },{
              "RowType": "Row",
              "Cells": [
                {
                  "Value": "2018-02-14T00:00:00",
                  "Attributes": [
                    {
                      "Value": "024d7994-a26c-4c20-9894-13934840fc31",
                      "Id": "invoiceID"
                    }
                  ]
                },{
                  "Value": "",
                  "Attributes": [
                    {
                      "Value": "024d7994-a26c-4c20-9894-13934840fc31",
                      "Id": "invoiceID"
                    }
                  ]
                },{
                  "Value": "2018-02-14T00:00:00",
                  "Attributes": [
                    {
                      "Value": "024d7994-a26c-4c20-9894-13934840fc31",
                      "Id": "invoiceID"
                    }
                  ]
                },{
                  "Value": "",
                  "Attributes": [
                    {
                      "Value": "024d7994-a26c-4c20-9894-13934840fc31",
                      "Id": "invoiceID"
                    }
                  ]
                },{
                  "Value": "53.90",
                  "Attributes": [
                    {
                      "Value": "024d7994-a26c-4c20-9894-13934840fc31",
                      "Id": "invoiceID"
                    }
                  ]
                },{
                  "Value": "53.90",
                  "Attributes": [
                    {
                      "Value": "024d7994-a26c-4c20-9894-13934840fc31",
                      "Id": "invoiceID"
                    }
                  ]
                },{
                  "Value": "0.00",
                  "Attributes": [
                    {
                      "Value": "024d7994-a26c-4c20-9894-13934840fc31",
                      "Id": "invoiceID"
                    }
                  ]
                },{
                  "Value": "0.00",
                  "Attributes": [
                    {
                      "Value": "024d7994-a26c-4c20-9894-13934840fc31",
                      "Id": "invoiceID"
                    }
                  ]
                }
              ]
            },{
              "RowType": "SummaryRow",
              "Cells": [
                { "Value": "Total" },
                { "Value": "" },
                { "Value": "" },
                { "Value": "" },
                { "Value": "107.80" },
                { "Value": "107.80" },
                { "Value": "0.00" },
                { "Value": "0.00" }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```


## Aged Receivables By Contact


|  |  |
| --- | --- |
| URL | [https://api.xero.com/api.xro/2.0/Reports/AgedReceivablesByContact](https://api.xero.com/api.xro/2.0/Reports/AgedReceivablesByContact) |
| Methods Supported | GET |
| Description | Returns aged receivables up to the end of the current month by default |

### Required parameters for GET AgedReceivablesByContact

|  |  |
| --- | --- |
| contactID | Contact ID e.g. 5040915e-8ce7-4177-8d08-fde416232f18 |

### Optional parameters for GET AgedReceivablesByContact

|  |  |
| --- | --- |
| date | Shows payments up to this date e.g. 2014-04-30. Defaults to end of the current month |
| fromDate | Show all receivable invoices from this date for contact |
| toDate | Show all receivable invoices to this date for the contact |

## Balance Sheet


|  |  |
| --- | --- |
| URL | [https://api.xero.com/api.xro/2.0/Reports/BalanceSheet](https://api.xero.com/api.xro/2.0/Reports/BalanceSheet) |
| Methods Supported | GET |
|  |  |
| Description | Returns a balance sheet for the end of the month of the specified date. It also returns the value at the end of the same month for the previous year. |

### Optional parameters for GET BalanceSheet

|  |  |
| --- | --- |
| date | e.g. 2014-04-30 |
| periods | The number of periods to compare (integer between 1 and 11) |
| timeframe | The period size to compare to (MONTH, QUARTER, YEAR) |
| trackingOptionID1 | The balance sheet will be filtered by this option if supplied. Note you cannot filter just by the TrackingCategory. |
| trackingOptionID2 | If you want to filter by more than one tracking category option then you can specify a second option too. See the Balance Sheet report in Xero learn more about this behavior when filtering by tracking category options |
| standardLayout | If you set this parameter to "true" then no custom report layouts will be applied to response |
| paymentsOnly | Set this to true to get cash transactions only |

Example response for GET BalanceSheet

```
GET https://api.xero.com/api.xro/2.0/Reports/BalanceSheet
```


```
{
  "Reports": [
    {
      "ReportID": "BalanceSheet",
      "ReportName": "Balance Sheet",
      "ReportType": "BalanceSheet",
      "ReportTitles": [
        "Balance Sheet",
        "Demo Company (AU)",
        "As at 28 February 2018"
      ],
      "ReportDate": "23 February 2018",
      "UpdatedDateUTC": "\/Date(1519358515899)\/",
      "Rows": [
        {
          "RowType": "Header",
          "Cells": [
            { "Value": "" },
            { "Value": "28 Feb 2018" },
            { "Value": "28 Feb 2017" }
          ]
        },
        {
          "RowType": "Section",
          "Title": "Assets"
        },
        {
          "RowType": "Section",
          "Title": "Bank",
          "Rows": [
            {
              "RowType": "Row",
              "Cells": [
                {
                  "Value": "Business Bank Account",
                  "Attributes": [
                    {
                      "Value": "13918178-849a-4823-9a31-57b7eac713d7",
                      "Id": "account"
                    }
                  ]
                },{
                  "Value": "-2894.08",
                  "Attributes": [
                    {
                      "Value": "13918178-849a-4823-9a31-57b7eac713d7",
                      "Id": "account"
                    }
                  ]
                },{
                  "Value": "0.00",
                  "Attributes": [
                    {
                      "Value": "13918178-849a-4823-9a31-57b7eac713d7",
                      "Id": "account"
                    }
                  ]
                }
              ]
            },{
              "RowType": "Row",
              "Cells": [
                {
                  "Value": "Business Savings Account",
                  "Attributes": [
                    {
                      "Value": "26028d3a-f981-44d6-a9ed-a522198870f8",
                      "Id": "account"
                    }
                  ]
                },{
                  "Value": "6878.28",
                  "Attributes": [
                    {
                      "Value": "26028d3a-f981-44d6-a9ed-a522198870f8",
                      "Id": "account"
                    }
                  ]
                },{
                  "Value": "0.00",
                  "Attributes": [
                    {
                      "Value": "26028d3a-f981-44d6-a9ed-a522198870f8",
                      "Id": "account"
                    }
                  ]
                }
              ]
            },{
              "RowType": "SummaryRow",
              "Cells": [
                { "Value": "Total Bank" },
                { "Value": "3984.20" },
                { "Value": "0.00" }
              ]
            }
          ]
        },{
          ...
        }
      ]
    }
  ]
}
```


## Bank Summary


|  |  |
| --- | --- |
| URL | [https://api.xero.com/api.xro/2.0/Reports/BankSummary](https://api.xero.com/api.xro/2.0/Reports/BankSummary) |
| Methods Supported | GET |
| Description | Returns the balances and cash movements for each bank account |

### Optional parameters for GET BankSummary

|  |  |
| --- | --- |
| fromDate | e.g. 2014-03-01 |
| toDate | e.g. 2014-03-31 |

## BAS Report


|  |  |
| --- | --- |
| URL | [https://api.xero.com/api.xro/2.0/Reports](https://api.xero.com/api.xro/2.0/Reports) |
| Methods Supported | GET |
| Description | Returns a list of published BAS reports. NB This works for Australia based organisations only |

### Optional parameters for GET BAS Report

|  |  |
| --- | --- |
| ReportID | Add the ReportID to the end of the url to retrieve the details of a specific BAS Report |

Example response for an individual published BAS Report

```
GET https://api.xero.com/api.xro/2.0/Reports/3d0a1240-e606-4fae-a823-77bcf79d5e79
```


```
{
  "Reports": [
    {
      "ReportID": "3d0a1240-e606-4fae-a823-77bcf79d5e79",
      "ReportName": "Activity Statement",
      "ReportType": "SalesTaxReturn",
      "ReportDate": "1 Nov 2011 to 30 Nov 2011",
      "UpdatedDateUTC": "\/Date(1519357171249)\/",
      "Attributes": [
        {
          "Name": "fromDate",
          "Description": "From",
          "Value": "2011-11-01T00:00:00"
        },
        {
          "Name": "dateTo",
          "Description": "To",
          "Value": "2011-11-30T00:00:00"
        }
      ],
      "Fields": [
        {
          "FieldID": "ABN",
          "Description": "ABN",
          "Value": "53003086616"
        },{
          "FieldID": "GSTBasis",
          "Description": "GST Accounting Method",
          "Value": "Accruals Basis"
        },{
          "FieldID": "W1",
          "Description": "Total salary, wages and other payments",
          "Value": "0"
        },{
          "FieldID": "W2",
          "Description": "Amount withheld from payments shown at W1",
          "Value": "0"
        },{
          "FieldID": "W4",
          "Description": "Amount withheld where no ABN is quoted",
          "Value": "0"
        },{
          "FieldID": "W3",
          "Description": "Other amounts withheld (excluding any amount shown in W2 or W4)",
          "Value": "0"
        },{
          "FieldID": "W5",
          "Description": "Total amounts withheld (W2 + W4 + W3)",
          "Value": "0"
        },{
          "FieldID": "4",
          "Description": "PAYG tax withheld",
          "Value": "0"
        },{
          "FieldID": "7",
          "Description": "Deferred company/fund instalment",
          "Value": "0"
        },{
          "FieldID": "8A",
          "Description": "4+7",
          "Value": "0"
        },{
          "FieldID": "8B",
          "Value": "0"
        },{
          "FieldID": "9",
          "Description": "Your refund",
          "Value": "0"
        }
      ]
    }
  ]
}
```


## Budget Summary


|  |  |
| --- | --- |
| URL | [https://api.xero.com/api.xro/2.0/Reports/BudgetSummary](https://api.xero.com/api.xro/2.0/Reports/BudgetSummary) |
| Methods Supported | GET |
| Description | Returns a summary of your monthly budget |

### Optional parameters for GET BudgetSummary

|  |  |
| --- | --- |
| date | e.g. 2014-04-30 |
| periods | The number of periods to compare (integer between 1 and 12) |
| timeframe | The period size to compare to (1=month, 3=quarter, 12=year) |

## Executive Summary


|  |  |
| --- | --- |
| URL | [https://api.xero.com/api.xro/2.0/Reports/ExecutiveSummary](https://api.xero.com/api.xro/2.0/Reports/ExecutiveSummary) |
| Methods Supported | GET |
| Description | A summary including monthly totals and some common business ratios |

### Optional parameters for GET ExecutiveSummary

|  |  |
| --- | --- |
| date | e.g. 2014-03-31 |

## GST Report


|  |  |
| --- | --- |
| URL | [https://api.xero.com/api.xro/2.0/Reports](https://api.xero.com/api.xro/2.0/Reports) |
| Methods Supported | GET |
| Description | Returns a list of finalised GST reports. NB This currently works for New Zealand based organisations only. Published GST Reports before 11 Nov 2013 will also be returned |

### Optional parameters for GET GST Report

|  |  |
| --- | --- |
| ReportID | Add the ReportID to the end of the url to retrieve the details of a published GST Report |

Example response for an individual published GST Report

```
GET https://api.xero.com/api.xro/2.0/Reports/2be4a28b-467a-4bd1-baf8-8d6622a5b930
```


```
{
  "Reports": [
    {
      "ReportID": "86894",
      "ReportName": "GST and Provisional Tax Return",
      "ReportType": "GSTReturn",
      "ReportDate": "01 Jul 2016 to 31 Dec 2016",
      "UpdatedDateUTC": "\/Date(1519596630000)\/",
      "Fields": [
        {
          "FieldID": "1",
          "Description": "Registration number",
          "Value": "111-111-111"
        },{
          "FieldID": "GSTBasis",
          "Description": "GST basis",
          "Value": "Invoice Basis"
        },{
          "FieldID": "PeriodCovered",
          "Description": "Period covered by the return",
          "Value": "2 Monthly"
        },{
        "FieldID": "From",
        "Description": "From",
        "Value": "2016-07-01T00:00:00"
        },{
          "FieldID": "2",
          "Description": "To",
          "Value": "2016-8-31T00:00:00"
        },{
          "FieldID": "5",
          "Description": "Total sales and income for the period (including GST and zero-rated Supplies)",
          "Value": "115.00"
        },{
          ...
        }
      ]
    }
  ]
}
```


## Profit And Loss


|  |  |
| --- | --- |
| URL | [https://api.xero.com/api.xro/2.0/Reports/ProfitAndLoss](https://api.xero.com/api.xro/2.0/Reports/ProfitAndLoss) |
| Methods Supported | GET |
| Description | Returns a profit and loss for the current month by default. An alternate date range can also be specified using the optional parameters listed below. |

### Optional parameters for GET ProfitAndLoss

|  |  |
| --- | --- |
| fromDate | The date the report starts e.g. 2021-03-01. Defaults to the begining of the current month if not provided. |
| toDate | The date the report ends e.g. 2021-03-31. Defaults to the end of the current month if not provided. |
| periods | The number of periods to compare (integer between 1 and 11)<br>**Note:** If you use the periods parameter in combination with the fromDate and toDate parameters then the specified date range will apply to each period (i.e. if the specified date range is for a 30 day month, each prior period will only include the first 30 days). To ensure you always get a full month of data in previous periods you would need to start in a month with 31 days (e.g. start in July instead of June) |
| timeframe | The period size to compare to (MONTH, QUARTER, YEAR) |
| trackingCategoryID | If you specify the trackingCategoryID parameter then the Profit and Loss Report will show figures for each of the options in the category as separate columns. See the Profit and Loss Report in Xero to learn more about this behavior when filtering by a tracking category. |
| trackingOptionID | if you specify this parameter in addition to the trackingCategoryID then just one option will be returned (i.e. 1 column only) |
| trackingCategoryID2 | If you specify a second trackingCategoryID parameter then the Profit and Loss Report will show figures for each combination of options from the two categories as separate columns. See the Profit and Loss Report in Xero to learn more about this behaviour when filtering by two tracking categories. |
| trackingOptionID2 | if you specify this parameter in addition to a second trackingCategoryID then just one option will be returned combined with the option/s from the first tracking category |
| standardLayout | If you set this parameter to "true" then no custom report layouts will be applied to response |
| paymentsOnly | Set this to true to get cash transactions only |

### Multi-Currency System Accounts – FXGROUPID

For organisations in most regions, the standard layout of the profit and loss report will group [multi currency system accounts](https://help.xero.com/nz/CurrencySettings$BK_FXSystem) into a single line with a Value of FXGROUPID (instead of an AccountID).

This is not the case for US organisations and Australian demo companies. Multi-currency system accounts will be displayed separately with their respective AccountIDs.

Example response from GET ProfitAndLoss

```
GET https://api.xero.com/api.xro/2.0/Reports/ProfitAndLoss?fromDate=2017-02-01&toDate=2017-02-28
```


```
{
  "Reports": [
    {
      "ReportID": "ProfitAndLoss",
      "ReportName": "Profit and Loss",
      "ReportType": "ProfitAndLoss",
      "ReportTitles": [
        "Profit & Loss",
        "Demo Company (AU)",
        "1 February 2018 to 28 February 2018"
      ],
      "ReportDate": "25 February 2018",
      "UpdatedDateUTC": "\/Date(1519593468971)\/",
      "Rows": [
        {
          "RowType": "Header",
          "Cells": [
            { "Value": "" },
            { "Value": "28 Feb 18" }
          ]
        },
        {
          "RowType": "Section",
          "Title": " Income",
          "Rows": [
            {
              "RowType": "Row",
              "Cells": [
                {
                  "Value": "Sales",
                  "Attributes": [
                    {
                      "Value": "e2bacdc6-2006-43c2-a5da-3c0e5f43b452",
                      "Id": "account"
                    }
                  ]
                },{
                  "Value": "9220.05",
                  "Attributes": [
                    {
                      "Value": "e2bacdc6-2006-43c2-a5da-3c0e5f43b452",
                      "Id": "account"
                    }
                  ]
                }
              ]
            },
            {
              "RowType": "SummaryRow",
              "Cells": [
                { "Value": "Total Income" },
                { "Value": "9220.05" }
              ]
            }
          ]
        },{
          ...
        },{
          "RowType": "Section",
          "Rows": [
            {
              "RowType": "Row",
              "Cells": [
                { "Value": "NET PROFIT" },
                { "Value": "-6250.09" }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```


## Trial Balance


|  |  |
| --- | --- |
| URL | [https://api.xero.com/api.xro/2.0/Reports/TrialBalance](https://api.xero.com/api.xro/2.0/Reports/TrialBalance) |
| Methods Supported | GET |
| Description | Returns a trial balance for the current month up to the date specified. YTD values are shown too. |

### Optional parameters for GET TrialBalance

|  |  |
| --- | --- |
| date | As at date e.g. 2014-10-31 |
| paymentsOnly | Set this to true to get cash transactions only |

Example response for GET TrialBalance

```
GET https://api.xero.com/api.xro/2.0/Reports/TrialBalance
```


```
{
  "Reports": [
    {
      "ReportID": "TrialBalance",
      "ReportName": "Trial Balance",
      "ReportType": "TrialBalance",
      "ReportTitles": [
        "Trial Balance",
        "Demo Company (NZ)",
        "As at 30 August 2010"
      ],
      "ReportDate": "21 February 2011",
      "UpdatedDateUTC": "\/Date(1519357171249)\/",
      "Rows": [
        {
          "RowType": "Header",
          "Cells": [
            { "Value": "Account" },
            { "Value": "Debit" },
            { "Value": "Credit" },
            { "Value": "YTD Debit" },
            { "Value": "YTD Credit" }
          ]
        },{
          "RowType": "Section",
          "Title": "Revenue",
          "Rows": [
            {
              "RowType": "Row",
              "Cells": [
                {
                  "Value": "Interest Income (270)",
                  "Attributes": [
                    {
                      "Value": "e9482110-7245-4a76-bfe2-14500495a076",
                      "Id": "account"
                    }
                  ]
                },{
                  "Attributes": [
                    {
                      "Value": "e9482110-7245-4a76-bfe2-14500495a076",
                      "Id": "account"
                    }
                  ]
                },{
                  "Value": "0.00",
                  "Attributes": [
                    {
                      "Value": "e9482110-7245-4a76-bfe2-14500495a076",
                      "Id": "account"
                    }
                  ]
                },
                {
                  "Attributes": [
                    {
                      "Value": "e9482110-7245-4a76-bfe2-14500495a076",
                      "Id": "account"
                    }
                  ]
                },
                {
                  "Value": "500.00",
                  "Attributes": [
                    {
                      "Value": "e9482110-7245-4a76-bfe2-14500495a076",
                      "Id": "account"
                    }
                  ]
                }
              ]
            },{
              "RowType": "Row",
              "Cells": [
                {
                  "Value": "Sales (200)",
                  "Attributes": [
                    {
                      "Value": "5040915e-8ce7-4177-8d08-fde416232f18",
                      "Id": "account"
                    }
                  ]
                },{
                  "Attributes": [
                    {
                      "Value": "5040915e-8ce7-4177-8d08-fde416232f18",
                      "Id": "account"
                    }
                  ]
                },{
                  "Value": "12180.25",
                  "Attributes": [
                    {
                      "Value": "5040915e-8ce7-4177-8d08-fde416232f18",
                      "Id": "account"
                    }
                  ]
                },{
                  "Attributes": [
                    {
                      "Value": "5040915e-8ce7-4177-8d08-fde416232f18",
                      "Id": "account"
                    }
                  ]
                },{
                  "Value": "20775.53",
                  "Attributes": [
                    {
                      "Value": "5040915e-8ce7-4177-8d08-fde416232f18",
                      "Id": "account"
                    }
                  ]
                }
              ]
            }
          ]
        },{
          "RowType": "Section",
          "Rows": [
            {
              "RowType": "SummaryRow",
              "Cells": [
                { "Value": "Total" },
                { "Value": "17447.02" },
                { "Value": "17447.02" },
                { "Value": "33459.76" },
                { "Value": "33459.76" }
              ]
            }
          ]
        },{
          ...
        }
      ]
    }
  ]
}
```
