# Invoice Reminders

## Overview


|  |  |
| --- | --- |
| URL | [https://api.xero.com/api.xro/2.0/InvoiceReminders/Settings](https://api.xero.com/api.xro/2.0/InvoiceReminders/Settings) |
| Methods Supported | GET |
| Description | Returns whether invoice reminders are enabled. Let us know if there are [additional settings](https://xero.uservoice.com/forums/5528-xero-accounting-api/suggestions/11385666-expose-more-invoice-reminder-settings) you'd like exposed in the API. |

## GET InvoiceReminders/Settings


Use this method to check if invoice reminders are enabled.

|  |  |
| --- | --- |
| Enabled | Returns true/false to indicate if invoice reminders are enabled for a Xero organisation |

Example response for GET InvoiceReminders/Settings

```
GET https://api.xero.com/api.xro/2.0/InvoiceReminders/Settings
```


```
{
  "InvoiceReminders": [{
    "Enabled": false
    }]
}
```


### Invoice Reminder functionality NOT available via the API

This is a very basic endpoint but we're keen to know what functionality you'd like to see added. We've started some user voice pages to track demand. Please add more pages if your requests aren't covered by the below:

- Expose [more invoice reminder settings](https://xero.uservoice.com/forums/5528-xero-accounting-api/suggestions/11385666-expose-more-invoice-reminder-settings) (rules, templates etc).
- Expose whether [invoice reminders are enabled for a particular invoice](https://xero.uservoice.com/forums/5528-xero-accounting-api/suggestions/11385714-expose-whether-invoice-reminders-are-enabled-for-a).
- Expose whether [invoice reminders are enabled for a particular contact](https://xero.uservoice.com/forums/5528-xero-accounting-api/suggestions/11385726-expose-whether-invoice-reminders-are-enabled-for-a).
