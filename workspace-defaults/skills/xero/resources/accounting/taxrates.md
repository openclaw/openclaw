# Tax Rates


## Overview


|  |  |
| --- | --- |
| URL | [https://api.xero.com/api.xro/2.0/TaxRates](https://api.xero.com/api.xro/2.0/TaxRates) |
| Methods Supported | GET, PUT, POST |
| Description | Returns tax rates for a Xero organisation <br>Allows you to add a new tax rate for a Xero organisation <br>Allows you to update a tax rate for a Xero organisation |

## GET TaxRates


Elements for Tax Rates

|  |  |
| --- | --- |
| Name | Name of tax rate |
| TaxType | See Tax Types – can only be used on update calls |
| TaxComponents | See Tax Components |
| Status | See Status Codes |
| ReportTaxType | See ReportTaxTypes |
| CanApplyToAssets | Boolean to describe if tax rate can be used for asset accounts i.e. true,false |
| CanApplyToEquity | Boolean to describe if tax rate can be used for equity accounts i.e. true,false |
| CanApplyToExpenses | Boolean to describe if tax rate can be used for expense accounts i.e. true,false |
| CanApplyToLiabilities | Boolean to describe if tax rate can be used for liability accounts i.e. true,false |
| CanApplyToRevenue | Boolean to describe if tax rate can be used for revenue accounts i.e. true,false |
| DisplayTaxRate | Tax Rate (decimal to 4dp) e.g 12.5000 |
| EffectiveRate | Effective Tax Rate (decimal to 4dp) e.g 12.5000 |

Elements for Tax Components

|  |  |
| --- | --- |
| Name | Name of Tax Component |
| Rate | Tax Rate (up to 4dp) |
| IsCompound | Boolean to describe if tax component is compounded. [Learn more](https://central.xero.com/s/topic/0TO1N0000017kpZWAQ/tax-rates) |
| IsNonRecoverable | Boolean to describe if tax component is non-recoverable. Non-recoverable rates are only applicable to Canadian organisations. [Learn more](https://central.xero.com/s/topic/0TO1N0000017kpZWAQ/tax-rates) |

### Optional parameters for GET TaxRates

|  |  |
| --- | --- |
| Where | Filter by any element ( _see Filters_ ) |
| order | Order by any element returned ( _see Order By_ ) |

### Record filtering

You can specify an individual Tax Rate by appending a valid Tax Type to the endpoint URL path, i.e. `GET .../TaxRates/INPUT2`

Example response for GET TaxRates

```
GET https://api.xero.com/api.xro/2.0/TaxRates
```


```
{
  "TaxRates": [
    {
      "Name": "15% GST on Expenses",
      "TaxType": "INPUT2",
      "CanApplyToAssets": "true",
      "CanApplyToEquity": "true",
      "CanApplyToExpenses": "true",
      "CanApplyToLiabilities": "true",
      "CanApplyToRevenue": "false",
      "DisplayTaxRate": "15.0000",
      "EffectiveRate": "15.0000",
      "Status": "ACTIVE",
      "TaxComponents": [
        {
          "Name": "GST",
          "Rate": "15.0000",
          "IsCompound": "false",
          "IsNonRecoverable": "false"
        }
      ]
    },
    {
      "Name": "15% GST on Income",
      "TaxType": "OUTPUT2",
      "CanApplyToAssets": "true",
      "CanApplyToEquity": "true",
      "CanApplyToExpenses": "false",
      "CanApplyToLiabilities": "true",
      "CanApplyToRevenue": "true",
      "DisplayTaxRate": "15.0000",
      "EffectiveRate": "15.0000",
      "Status": "ACTIVE",
      "TaxComponents": [
        {
          "Name": "GST",
          "Rate": "15.0000",
          "IsCompound": "false",
          "IsNonRecoverable": "false"
        }
      ]
    },
    {
      "Name": "GST on Imports",
      "TaxType": "GSTONIMPORTS",
      "CanApplyToAssets": "false",
      "CanApplyToEquity": "false",
      "CanApplyToExpenses": "false",
      "CanApplyToLiabilities": "true",
      "CanApplyToRevenue": "false",
      "DisplayTaxRate": "0.0000",
      "EffectiveRate": "0.0000",
      "Status": "ACTIVE",
      "TaxComponents": [
        {
          "Name": "GST",
          "Rate": "0.0000",
          "IsCompound": "false",
          "IsNonRecoverable": "false"
        }
      ]
    }
  ]
}
```


## POST TaxRates


Use this method to create or update a tax rate. Only one tax rate can be created or updated per request. Please note that system defined tax rates can't be updated.

All the existing tax components must be supplied when updating a tax rate. Note that tax components cannot be renamed and that tax components may be added but cannot be removed.

The following elements can be used in a POST request

|  |  |
| --- | --- |
| Name | Name of tax rate |
| TaxType | See Tax Types – can only be used on update calls |
| TaxComponents | See Tax Components |
| Status | See Status Codes |
| ReportTaxType | See ReportTaxTypes. Required when creating tax rates for AU, NZ and UK orgs. |

Elements for TaxComponents

|  |  |
| --- | --- |
| Name | Name of Tax Component |
| Rate | Tax Rate (up to 4dp) |
| IsCompound | Boolean to describe if tax component is compounded. [Learn more](https://central.xero.com/s/topic/0TO1N0000017kpZWAQ/tax-rates) |
| IsNonRecoverable | Boolean to describe if tax component is non-recoverable. This element will default to false if not provided. Non-recoverable rates are only applicable to Canadian organisations. [Learn more](https://central.xero.com/s/topic/0TO1N0000017kpZWAQ/tax-rates) |

Example request to create a Tax Rate

```
POST https://api.xero.com/api.xro/2.0/TaxRates
```


```
{
  "Name": "Oakdale Sales Tax",
  "TaxComponents": [
    {
      "Name": "State Tax",
      "Rate": "7.5",
      "IsCompound": "false",
      "IsNonRecoverable": "false"
    },
    {
      "Name": "Local Sales Tax",
      "Rate": "0.625",
      "IsCompound": "false",
      "IsNonRecoverable": "false"
    }
  ]
}
```


Example request to update a Tax Rate Status to DELETED.

```
POST https://api.xero.com/api.xro/2.0/TaxRates
```


```
{
  "Name": "Sales Tax",
  "Status": "DELETED"
}
```


## PUT TaxRates


The PUT method is similar to the POST TaxRates method, however you can only create new tax rates with this method.

## Tax Rate Constraints


In order to properly complete tax forms, certain tax rates can only be used with certain account types. This will vary depending on the rate and country. Sending a line item with a tax rate that can't be used with the line's account code will generate the error "The TaxType code 'xxx' cannot be used with account code 'xxx'."

Below is a list of the default rates that Xero organisations start with. Please note that users can edit the names and create their own rates in Xero so this is only a guide – you'll need to do a GET of tax rates to know for certain what rate can be paired with what account type in the organisation you're connecting to.

### Australia

| TaxType | TaxName | Assets | Equity | Expenses | Liabilities | Revenue |
| --- | --- | --- | --- | --- | --- | --- |
| BASEXCLUDED | BAS Excluded | true | true | true | true | true |
| EXEMPTCAPITAL | GST Free Capital | true | true | true | true | false |
| EXEMPTEXPENSES | GST Free Expenses | true | true | true | true | false |
| EXEMPTEXPORT | GST Free Exports | true | true | false | true | true |
| EXEMPTOUTPUT | GST Free Income | true | true | false | true | true |
| CAPEXINPUT | GST on Capital | true | true | true | true | false |
| GSTONCAPIMPORTS | GST on Capital Imports | false | false | false | true | false |
| INPUT | GST on Expenses | true | true | true | true | false |
| GSTONIMPORTS | GST on Imports | false | false | false | true | false |
| OUTPUT | GST on Income | true | true | false | true | true |
| INPUTTAXED | Input Taxed | true | true | true | true | true |

### Canada

| TaxType | TaxName | Assets | Equity | Expenses | Liabilities | Revenue |
| --- | --- | --- | --- | --- | --- | --- |
| CAN001 | AB - GST on Purchases | true | true | true | true | false |
| CAN002 | BC - GST/PST on Purchases | true | true | true | true | false |
| CAN003 | MB - GST/RST on Purchases (pre 1 July '19) | true | true | true | true | false |
| CAN004 | NB - HST on Purchases | true | true | true | true | false |
| CAN005 | NL - HST on Purchases | true | true | true | true | false |
| CAN006 | NS - HST on Purchases (pre 1 April '25) | true | true | true | true | false |
| CAN007 | ON - HST on Purchases | true | true | true | true | false |
| CAN008 | PE - HST on Purchases | true | true | true | true | false |
| CAN010 | SK - GST/PST on Purchases | true | true | true | true | false |
| CAN011 | NT - GST on Purchases | true | true | true | true | false |
| CAN012 | YT - GST on Purchases | true | true | true | true | false |
| CAN013 | NU - GST on Purchases | true | true | true | true | false |
| CAN014 | AB - GST on Sales | true | true | false | true | true |
| CAN015 | BC - GST/PST on Sales | true | true | false | true | true |
| CAN016 | MB - GST/RST on Sales (pre 1 July '19) | true | true | false | true | true |
| CAN017 | NB - HST on Sales | true | true | false | true | true |
| CAN018 | NL - HST on Sales | true | true | false | true | true |
| CAN019 | NS - HST on Sales (pre 1 April '25) | true | true | false | true | true |
| CAN020 | ON - HST on Sales | true | true | false | true | true |
| CAN021 | PE - HST on Sales | true | true | false | true | true |
| CAN022 | QC - GST/QST on Sales | true | true | false | true | true |
| CAN023 | SK - GST/PST on Sales | true | true | false | true | true |
| CAN024 | NT - GST on Sales | true | true | false | true | true |
| CAN025 | YT - GST on Sales | true | true | false | true | true |
| CAN026 | NU - GST on Sales | true | true | false | true | true |
| CAN027 | QC - GST/QST on Purchases | true | true | true | true | false |
| CAN028 | MB - GST/RST on Sales | true | true | false | true | true |
| CAN029 | MB - GST/RST on Purchases | true | true | true | true | false |
| CAN030 | Exempt Sales | true | true | false | true | true |
| CAN031 | NS - HST on Purchases | true | true | true | true | false |
| CAN032 | NS - HST on Sales | true | true | false | true | true |
| GSTONIMPORTS | Sales Tax on Imports | false | false | false | true | false |
| INPUT | Tax on Purchases | true | true | true | true | true |
| NONE | Tax Exempt | true | true | true | true | true |
| OUTPUT | Tax on Sales | true | true | true | true | true |

### Global

| TaxType | TaxName | Assets | Equity | Expenses | Liabilities | Revenue |
| --- | --- | --- | --- | --- | --- | --- |
| GSTONIMPORTS | Sales Tax on Imports | false | false | false | true | false |
| NONE | Tax Exempt | true | true | true | true | true |
| OUTPUT | Tax on Consulting | true | true | true | true | true |
| INPUT | Tax on Purchases | true | true | true | true | true |

### New Zealand

| TaxType | TaxName | Assets | Equity | Expenses | Liabilities | Revenue |
| --- | --- | --- | --- | --- | --- | --- |
| INPUT | GST on Expenses | true | true | true | true | true |
| OUTPUT | GST on Income | true | true | false | true | true |
| INPUT2 | GST on Expenses | true | true | true | true | false |
| OUTPUT2 | GST on Income | true | true | false | true | true |
| GSTONIMPORTS | GST on Imports | true | true | false | true | false |
| NONE | No GST | true | true | true | true | true |
| ZERORATED | Zero Rated | false | false | false | true | true |

### Singapore

| TaxType | TaxName | Assets | Equity | Expenses | Liabilities | Revenue |
| --- | --- | --- | --- | --- | --- | --- |
| BADDEBTRECOVERY | 2022 Bad Debt Recovery | true | true | true | true | true |
| BADDEBTRELIEF | 2022 Bad Debt Relief | true | true | true | true | true |
| TXCA | 2022 Customer Accounting Purchases | true | true | true | true | false |
| DSOUTPUT | 2022 Deemed Supplies | true | true | false | true | true |
| BLINPUT2 | 2022 Disallowed Expenses | true | true | true | true | false |
| BLINPUT3 | 2022 Disallowed Expenses | true | true | true | true | false |
| IMINPUT2 | 2022 Imports | true | true | true | true | false |
| IGDSINPUT2 | 2022 Imports under IGDS (input tax claim) | true | true | true | true | false |
| IGDSINPUT3 | 2022 Imports under IGDS (no input tax claim) | true | true | true | true | false |
| IMN33 | 2022 Imports: non-regulation 33 exempt supplies | true | true | true | true | false |
| IMESS | 2022 Imports: regulation 33 exempt supplies | true | true | true | true | false |
| IMRE | 2022 Imports: taxable & exempt supplies | true | true | true | true | false |
| IM | 2022 Imports: taxable supplies | true | true | true | true | false |
| TXN33INPUT | 2022 PartiallyExemptTrader NonRegulation 33 Exempt | true | true | true | true | false |
| TXESSINPUT | 2022 PartiallyExemptTrader Regulation 33 Exempt | true | true | true | true | false |
| TXREINPUT | 2022 PartiallyExemptTrader Residual Input tax | true | true | true | true | false |
| TXPETINPUT | 2022 PartiallyExemptTrader Standard-Rated Purchase | true | true | true | true | false |
| TXRCN33 | 2022 Reverse charge: NonRegulation33 exempt supply | true | true | true | true | false |
| TXRCESS | 2022 Reverse charge: Regulation 33 exempt supply | true | true | true | true | false |
| TXRCRE | 2022 Reverse charge: taxable & exempt supply | true | true | true | true | false |
| TXRCTS | 2022 Reverse charge: taxable supply @ 7% | true | true | true | true | false |
| INPUT | 2022 Standard-Rated Purchases | true | true | true | true | false |
| OUTPUT | 2022 Standard-Rated Supplies | true | true | false | true | true |
| BADDEBTRECOVERYY23 | 2023 Bad Debt Recovery | true | true | true | true | true |
| BADDEBTRELIEFY23 | 2023 Bad Debt Relief | true | true | true | true | true |
| TXCAY23 | 2023 Customer Accounting Purchases | true | true | true | true | false |
| DSOUTPUTY23 | 2023 Deemed Supplies | true | true | false | true | true |
| BLINPUT3Y23 | 2023 Disallowed Expenses | true | true | true | true | false |
| IMINPUT2Y23 | 2023 Imports | true | true | true | true | false |
| IGDSINPUT2Y23 | 2023 Imports under IGDS (input tax claim) | true | true | true | true | false |
| IGDSINPUT3Y23 | 2023 Imports under IGDS (no input tax claim) | true | true | true | true | false |
| IMN33Y23 | 2023 Imports: non-regulation 33 exempt supplies | true | true | true | true | false |
| IMESSY23 | 2023 Imports: regulation 33 exempt supplies | true | true | true | true | false |
| IMREY23 | 2023 Imports: taxable & exempt supplies | true | true | true | true | false |
| IMY23 | 2023 Imports: taxable supplies | true | true | true | true | false |
| SROVRLVGY23 | 2023 LVG - electronic marketplace/redeliverer | true | true | false | true | true |
| SRLVGY23 | 2023 LVG - own supply | true | true | false | true | true |
| OSOUTPUT | 2023 Out Of Scope Supplies | true | true | true | true | true |
| SROVR | 2023 Overseas Vendor Registration Scheme Supplies | true | true | false | true | true |
| TXN33INPUTY23 | 2023 PartiallyExemptTrader NonRegulation 33 Exempt | true | true | true | true | false |
| TXESSINPUTY23 | 2023 PartiallyExemptTrader Regulation 33 Exempt | true | true | true | true | false |
| TXREINPUTY23 | 2023 PartiallyExemptTrader Residual Input tax | true | true | true | true | false |
| TXPETINPUTY23 | 2023 PartiallyExemptTrader Standard-Rated Purchase | true | true | true | true | false |
| SROVRRSY23 | 2023 Remote services - electronic marketplace | true | true | false | true | true |
| TXRCN33Y23 | 2023 Reverse charge: NonRegulation33 exempt supply | true | true | true | true | false |
| TXRCESSY23 | 2023 Reverse charge: Regulation 33 exempt supply | true | true | true | true | false |
| TXRCREY23 | 2023 Reverse charge: taxable & exempt supply | true | true | true | true | false |
| TXRCTSY23 | 2023 Reverse charge: taxable supply @ 8% | true | true | true | true | false |
| INPUTY23 | 2023 Standard-Rated Purchases | true | true | true | true | false |
| OUTPUTY23 | 2023 Standard-Rated Supplies | true | true | false | true | true |
| BADDEBTRECOVERYY24 | Bad Debt Recovery | true | true | true | true | true |
| BADDEBTRELIEFY24 | Bad Debt Relief | true | true | true | true | true |
| TXCAY24 | Customer Accounting Purchases | true | true | true | true | false |
| SRCAS | Customer Accounting Supplies by supplier | true | true | false | true | true |
| DSOUTPUTY24 | Deemed Supplies | true | true | false | true | true |
| BLINPUT3Y24 | Disallowed Expenses | true | true | true | true | false |
| EPINPUT | Exempt Purchases | true | true | true | true | false |
| MEINPUT | Imports under a Special Scheme | true | true | true | true | false |
| IGDSINPUT2Y24 | Imports under IGDS (input tax claim) | true | true | true | true | false |
| IGDSINPUT3Y24 | Imports under IGDS (no input tax claim) | true | true | true | true | false |
| IMN33Y24 | Imports: non-regulation 33 exempt supplies | true | true | true | true | false |
| IMESSY24 | Imports: regulation 33 exempt supplies | true | true | true | true | false |
| IMREY24 | Imports: taxable & exempt supplies | true | true | true | true | false |
| IMY24 | Imports: taxable supplies | true | true | true | true | false |
| SROVRLVGY24 | LVG - electronic marketplace/redeliverer | true | true | false | true | true |
| SRLVGY24 | LVG - own supply | true | true | false | true | true |
| NONE | No Tax | true | true | true | true | true |
| ESN33OUTPUT | Non-Regulation 33 Exempt Supplies | true | true | true | true | true |
| OPINPUT | Out Of Scope Purchases | true | true | true | true | false |
| OSOUTPUT2 | Out Of Scope Supplies | false | true | false | true | true |
| TXN33INPUTY24 | Partially Exempt Traders Non-Regulation 33 Exempt | true | true | true | true | false |
| TXESSINPUTY24 | Partially Exempt Traders Regulation 33 Exempt | true | true | true | true | false |
| TXREINPUTY24 | Partially Exempt Traders Residual Input tax | true | true | true | true | false |
| TXPETINPUTY24 | Partially Exempt Traders Standard-Rated Purchases | true | true | true | true | false |
| NRINPUT | Purchases from Non-GST Registered Suppliers | true | true | true | true | false |
| ES33OUTPUT | Regulation 33 Exempt Supplies | true | true | true | true | true |
| SROVRRSY24 | Remote services - electronic marketplace | true | true | false | true | true |
| TXRCN33Y24 | Reverse charge: NonRegulation33 exempt supply | true | true | true | true | false |
| TXRCESSY24 | Reverse charge: Regulation 33 exempt supply | true | true | true | true | false |
| TXRCREY24 | Reverse charge: taxable & exempt supply | true | true | true | true | false |
| TXRCTSY24 | Reverse charge: taxable supply @ 9% | true | true | true | true | false |
| INPUTY24 | Standard-Rated Purchases | true | true | true | true | false |
| OUTPUTY24 | Standard-Rated Supplies | true | true | false | true | true |
| TOURISTREFUND | Tourist Refund Claim | true | true | true | true | true |
| ZERORATEDINPUT | Zero-Rated Purchases | true | true | true | true | false |
| ZERORATEDOUTPUT | Zero-Rated Supplies | true | true | false | true | true |

### South Africa

| TaxType | TaxName | Assets | Equity | Expenses | Liabilities | Revenue |
| --- | --- | --- | --- | --- | --- | --- |
| GSTONCAPIMPORTS | Capital Goods Imported | true | true | true | true | false |
| INPUT4 | Change in Use | true | true | true | false | false |
| OUTPUT4 | Change in use and Export of Second-hand Goods | false | true | false | true | true |
| EXEMPTOUTPUT | Exempt and Non-Supplies | false | true | false | true | true |
| IMINPUT | Goods and Services Imported | true | true | true | true | false |
| NONE | No VAT | true | true | true | true | true |
| INPUT2 | Old 14% Change in Use | true | true | true | false | false |
| INPUT | Old 14% Standard Rate Purchases | true | true | true | false | false |
| CAPEXINPUT | Old 14% Standard Rate Purchases - Capital Goods | true | true | true | false | false |
| OUTPUT | Old 14% Standard Rate Sales | false | true | false | true | true |
| SROUTPUT | Old 14% Standard Rate Sales - Capital Goods | false | true | false | true | true |
| INPUT3 | Standard Rate Purchases | true | true | true | false | false |
| CAPEXINPUT2 | Standard Rate Purchases - Capital Goods | true | true | true | false | false |
| OUTPUT3 | Standard Rate Sales | false | true | false | true | true |
| SROUTPUT2 | Standard Rate Sales - Capital Goods | false | true | false | true | true |
| ZERORATED | Zero rate (Excluding Goods Exported) | false | true | false | true | true |
| ZERORATEDOUTPUT | Zero Rate (only Exported Goods) | false | true | false | true | true |

### United Kingdom

| TaxType | TaxName | Assets | Equity | Expenses | Liabilities | Revenue |
| --- | --- | --- | --- | --- | --- | --- |
| CAPEXSRINPUT | 15% (VAT on Capital Purchases) | true | false | false | false | false |
| CAPEXSROUTPUT | 15% (VAT on Capital Sales) | true | false | false | false | false |
| CAPEXINPUT | 17.5% (VAT on Capital Purchases) | true | false | false | false | false |
| CAPEXOUTPUT | 17.5% (VAT on Capital Sales) | true | false | false | false | false |
| CAPEXINPUT2 | 20% (VAT on Capital Purchases) | true | false | false | false | false |
| CAPEXOUTPUT2 | 20% (VAT on Capital Sales) | true | false | false | false | false |
| INPUT2 | 20% (VAT on Expenses) | true | true | true | true | false |
| OUTPUT2 | 20% (VAT on Income) | true | true | false | true | true |
| RRINPUT | 5% (VAT on Expenses) | true | true | true | true | false |
| RROUTPUT | 5% (VAT on Income) | true | true | false | true | true |
| ECACQUISITIONS | EC Acquisitions (20%) | true | true | true | true | false |
| ECZRACQUISITIONS | EC Acquisitions (Zero Rated) | true | true | true | true | false |
| EXEMPTINPUT | Exempt Expenses | true | true | true | true | false |
| EXEMPTOUTPUT | Exempt Income | true | true | false | true | true |
| NONE | No VAT | true | true | true | true | true |
| REVERSECHARGES | Reverse Charge Expenses (20%) | true | true | true | true | false |
| GSTONIMPORTS | VAT on Imports | false | false | false | true | false |
| ECZROUTPUT | Zero Rated EC Goods Income | true | true | false | true | true |
| ECZROUTPUTSERVICES | Zero Rated EC Services | true | true | false | true | true |
| ZERORATEDINPUT | Zero Rated Expenses | true | true | true | true | false |
| ZERORATEDOUTPUT | Zero Rated Income | true | true | false | true | true |
| DRCHARGESUPPLY5 | Domestic Reverse Charge @ 5% (VAT on Expenses) | true | true | true | true | false |
| DRCHARGE5 | Domestic Reverse Charge @ 5% (VAT on Income) | true | true | false | true | true |
| DRCHARGESUPPLY20 | Domestic Reverse Charge @ 20% (VAT on Expenses) | true | true | true | true | false |
| DRCHARGE20 | Domestic Reverse Charge @ 20% (VAT on Income) | true | true | false | true | true |

### United States

| TaxType | TaxName | Assets | Equity | Expenses | Liabilities | Revenue |
| --- | --- | --- | --- | --- | --- | --- |
| AVALARA | Auto Look Up (DO NOT USE) | true | true | true | true | true |
| GSTONIMPORTS | Sales Tax on Imports | false | false | false | true | false |
| NONE | Tax Exempt | true | true | true | true | true |
| OUTPUT | Tax on Sales | true | true | true | true | true |
| INPUT | Tax on Purchases | true | true | true | true | true |

**Note:** The Avalara tax rate look up feature does not work for transactions imported through the API. A different rate should be used.

Tax Rates that have ReportTaxType = USSALESTAX do not work for transactions imported through the API. A different rate should be used.
