# Payment Services

## Overview


Payment service details can only be accessed by specifically certified payment service partners. See our payment services integration guide for more details.

|  |  |
| --- | --- |
| URL | [https://api.xero.com/api.xro/2.0/PaymentServices](https://api.xero.com/api.xro/2.0/PaymentServices) |
| Methods Supported | GET, PUT |
| Description | Create payment services <br>Retrieve payment services |

## GET PaymentServices


The following elements are returned in the PaymentServices response

|  |  |
| --- | --- |
| PaymentServiceID | The Xero generated identifier for the payments service (unique within organisations) |
| PaymentServiceName | The name of the payment service. Must be unique in a Xero Organisation |
| PaymentServiceUrl | The custom payment URL. This URL should contain placeholders that will be replaced with relevant invoice data. These placeholders are `[INVOICENUMBER]`, `[CURRENCY]`, `[AMOUNTDUE]` & `[SHORTCODE]` |
| PayNowText | The text displayed on the Pay Now button in Xero Online Invoicing (max length = 255). If this is not set it will default to ‘Pay by credit card’. |
| PaymentServiceType | This will always be CUSTOM for payment services created via the API. |

Example response for GET PaymentServices

```
GET https://api.xero.com/api.xro/2.0/PaymentServices
```


```
{
  "PaymentServices": [{
    "PaymentServiceID": "7f0f43b1-9ba9-4ba4-a785-e677652c7d7e",
    "PaymentServiceName": "Awesome Pay",
    "PaymentServiceUrl": "https://www.awesomepay.com/?invoiceNo=[INVOICENUMBER]&currency=[CURRENCY]&amount=[AMOUNTDUE]&shortCode=[SHORTCODE]",
    "PayNowText": "Pay via AwesomePay",
    "PaymentServiceType": "Custom"
  }]
}
```


## PUT PaymentServices


Use this method to create new payment services
The following elements are required to create a payment service

|  |  |
| --- | --- |
| PaymentServiceName | The name of the payment service. Must be unique in a Xero Organisation |
| PaymentServiceUrl | The custom payment URL. This URL should contain placeholders that will be replaced with relevant invoice data. These placeholders are `[INVOICENUMBER]`, `[CURRENCY]`, `[AMOUNTDUE]` & `[SHORTCODE]` |
| PayNowText | The text displayed on the Pay Now button in Xero Online Invoicing. If this is not set it will default to ‘Pay by credit card’ |

Example request for PUT PaymentServices

```
PUT https://api.xero.com/api.xro/2.0/PaymentServices
```


```
{
  "PaymentServiceName": "Awesome Pay",
  "PaymentServiceUrl": "https://www.awesomepay.com/?invoiceNo=[INVOICENUMBER]&currency=[CURRENCY]&amount=[AMOUNTDUE]&shortCode=[SHORTCODE]",
  "PayNowText": "Pay via AwesomePay"
}
```
