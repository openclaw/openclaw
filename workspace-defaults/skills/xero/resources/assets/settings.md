# Settings

## Overview


|  |  |
| --- | --- |
| URL | `https://api.xero.com/assets.xro/1.0/Settings` |
| Methods Supported | GET |
| Description | Allows you to retrieve the organisation settings for fixed assets |

### GET Settings

The following elements are returned when retrieving Settings

|  |  |
| --- | --- |
| assetNumberPrefix | The prefix used for fixed asset numbers (“FA-” by default) |
| assetNumberSequence | The next available sequence number |
| assetStartDate | The date depreciation calculations started on registered fixed assets in Xero |
| lastDepreciationDate | The last depreciation date |
| defaultGainOnDisposalAccountId | Default account that gains are posted to |
| defaultLossOnDisposalAccountId | Default account that losses are posted to |
| defaultCapitalGainOnDisposalAccountId | Default account that capital gains are posted to |
| optInForTax |  |

Example response for retrieving settings

```
GET https://api.xero.com/assets.xro/1.0/Settings
```


```
{
      "assetNumberPrefix": "FA-",
      "assetNumberSequence": "0022",
      "assetStartDate": "2015-07-01T00:00:00",
      "lastDepreciationDate": "2015-07-31T00:00:00",
      "defaultGainOnDisposalAccountId": "346ddb97-739a-4274-b43b-66aa3218d17c",
      "defaultLossOnDisposalAccountId": "1b798541-24e2-4855-9309-c023a0b576f3",
      "defaultCapitalGainOnDisposalAccountId": "6d6a0bdb-e118-45d8-a023-2ad617ec1cb7",
      "optInForTax": false
}
```
