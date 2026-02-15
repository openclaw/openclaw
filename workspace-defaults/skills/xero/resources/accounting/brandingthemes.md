# Branding Themes


## Overview


|  |  |
| --- | --- |
| URL | [https://api.xero.com/api.xro/2.0/BrandingThemes](https://api.xero.com/api.xro/2.0/BrandingThemes)<br>[https://api.xero.com/api.xro/2.0/BrandingThemes/{BrandingThemeID}/PaymentServices](https://api.xero.com/api.xro/2.0/BrandingThemes/%7BBrandingThemeID%7D/PaymentServices) |
| Methods Supported | GET, POST |
| Description | Retrieve a list of branding themes <br>Apply a payment service to a branding theme <br>Retrieve the payment services applied to a branding theme |

Payment service details can only be accessed by specifically certified payment service partners. See our payment services integration guide for more details.

## GET BrandingThemes


The following elements are returned in a GET BrandingThemes response

|  |  |
| --- | --- |
| BrandingThemeID | Xero identifier (unique within organisations) |
| Name | Name of branding theme |
| LogoUrl | The URL of the logo used on the branding theme |
| Type | The type of document that the branding theme can be applied to |
| SortOrder | Integer – ranked order of branding theme. The default branding theme has a value of 0 |
| CreatedDateUTC | UTC timestamp of creation date of branding theme |

Example response for BrandingThemes

```
GET https://api.xero.com/api.xro/2.0/BrandingThemes
```


```
{
  "BrandingThemes": [{
    "BrandingThemeID": "aefae6d5-7bbe-4e2e-aadc-302cd07a0fc1",
    "Name": "Standard",
    "Type": "INVOICE",
    "SortOrder": 0,
    "CreatedDateUTC": "\/Date(1277835396270+0000)\/"
  },
  {
    "BrandingThemeID": "dfe23d27-a3a6-4ef3-a5ca-b9e02b142dde",
    "Name": "Special Projects",
    "LogoUrl": "https://in.xero.com/logo?id=ZXcwS0lDQWlieUk2SUNJME5XVTBOekE0WlMxa09EWXlMVFF4TVRFdFlXSXpZUzFrWkRoalpEQXpPVEV6WlRFaUxBMEtJQ0FpWmlJNklDSXhOalJtWVRRelpDMWlOamsyTFRRNVlqSXRPR1F5TWkwMFpqTXlOamxtTnpWbU1XRWlEUXA5LVU0Zkh4TVNiYVRzPQ",
    "Type": "INVOICE",
    "SortOrder": 1,
    "CreatedDateUTC": "\/Date(946684800000+0000)\/"
  },
  {
    "BrandingThemeID": "2ced98b8-3be9-42c4-ae79-fe3c8bca3490",
    "Name": "Very orange invoice!",
    "Type": "INVOICE",
    "SortOrder": 2,
    "CreatedDateUTC": "\/Date(1357339258680+0000)\/"
  }]
}
```


Example response for an individual BrandingTheme

```
GET https://api.xero.com/api.xro/2.0/BrandingThemes/a94a78db-5cc6-4e26-a52b-045237e56e6e
```


```
{
  "BrandingThemes": [{
    "BrandingThemeID": "dfe23d27-a3a6-4ef3-a5ca-b9e02b142dde",
    "Name": "Special Projects",
    "LogoUrl": "https://in.xero.com/logo?id=ZXcwS0lDQWlieUk2SUNJME5XVTBOekE0WlMxa09EWXlMVFF4TVRFdFlXSXpZUzFrWkRoalpEQXpPVEV6WlRFaUxBMEtJQ0FpWmlJNklDSXhOalJtWVRRelpDMWlOamsyTFRRNVlqSXRPR1F5TWkwMFpqTXlOamxtTnpWbU1XRWlEUXA5LVU0Zkh4TVNiYVRzPQ",
    "Type": "INVOICE",
    "SortOrder": 1,
    "CreatedDateUTC": "\/Date(946684800000+0000)\/"
  }]
}
```


## GET PaymentServices


Use this method to retrieve the payment services applied to a branding theme.

The following elements are returned in the response

|  |  |
| --- | --- |
| PaymentServiceID | The Xero generated identifier for the payment service |
| PaymentServiceName | The name of the payment service. Must be unique in a Xero Organisation |
| PaymentServiceUrl | The custom payment URL. This URL should contain placeholders that will be replaced with relevant invoice data. These placeholders are `[INVOICENUMBER]`, `[CURRENCY]`, `[AMOUNTDUE]` & `[SHORTCODE]` |
| PayNowText | The text displayed on the Pay Now button in Xero Online Invoicing. If this is not set it will default to ‘Pay by credit card’ |
| PaymentServiceType | This will always be CUSTOM for payment services created via the API. |

Example response retrieving the payment services on a branding theme

```
GET https://api.xero.com/api.xro/2.0/BrandingThemes/{BrandingThemeID}/PaymentServices
```


```
{
  "PaymentServices": [{
    "PaymentServiceID": "0751da5f-8b28-4f93-b05e-1b85bedfd900",
    "PaymentServiceName": "DONOTPAYTHISISFAKE@fakedemoaccount.com",
    "PaymentServiceType": "PayPal"
  },
  {
    "PaymentServiceID": "7f0f43b1-9ba9-4ba4-a785-e677652c7d7e",
    "PaymentServiceName": "Awesome Pay",
    "PaymentServiceUrl": "https://www.awesomepay.com/?invoiceNo=[INVOICENUMBER]&currency=[CURRENCY]&amount=[AMOUNTDUE]&shortCode=[SHORTCODE]",
    "PayNowText": "Pay via AwesomePay",
    "PaymentServiceType": "Custom"
  }]
}
```


## POST PaymentServices


Use this method to apply a payment service to a branding theme

The following elements are required to apply a payment service to a branding theme

|  |  |
| --- | --- |
| PaymentServiceID | The identifier for the payment service being applied to the branding theme |

You may associate more than one CUSTOM payment services to a branding theme. However, only last payment services in the request will be taken as a custom payment for online invoices.

Example request to apply a payment service to a branding theme

```
POST https://api.xero.com/api.xro/2.0/BrandingThemes/{BrandingThemeID}/PaymentServices
```


```
{
"PaymentServices": [{
  "PaymentServiceID": "de5c978d-3cbf-4ebb-9ca9-20d7cb196ab1"
  }]
}
```
