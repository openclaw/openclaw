# Assets

## Overview


|  |  |
| --- | --- |
| URL | [https://api.xero.com/assets.xro/1.0/Assets](https://api.xero.com/assets.xro/1.0/Assets) |
| Methods Supported | GET, POST |
| Description | Allows you to retrieve assets <br>Allows you to create and update draft assets |

## GET Assets


The following elements are returned in the asset response

|  |  |
| --- | --- |
| assetId | The Xero-generated Id for the asset |
| assetName | The name of the asset |
| assetNumber | Must be unique. |
| purchaseDate | The date the asset was purchased YYYY-MM-DD |
| purchasePrice | The purchase price of the asset |
| disposalPrice | The price the asset was disposed at |
| assetStatus | See Asset Status Codes. |
| warrantyExpiryDate | The date the asset’s warranty expires (if needed) YYYY-MM-DD |
| serialNumber | The asset's serial number |
| bookDepreciationSettings | See Elements for Book Depreciation Settings |
| bookDepreciationDetail | See Elements for Book Depreciation Detail |
| canRollBack | Boolean to indicate whether depreciation can be rolled back for this asset individually. This is true if it doesn't have 'legacy' journal entries and if there is no lock period that would prevent this asset from rolling back. |
| accountingBookValue | The accounting value of the asset |

### Elements for Book Depreciation Settings

|  |  |
| --- | --- |
| effectiveFromDate | The depreciation start date (YYYY-MM-DD) |
| depreciationMethod | The method of depreciation applied to this asset. See Depreciation Methods |
| averagingMethod | The method of averaging applied to this asset. See Averaging Methods |
| depreciationRate | The rate of depreciation (e.g. 0.05) |
| effectiveLifeYears | Effective life of the asset in years (e.g. 5) |
| depreciationCalculationMethod | See Depreciation Calculation Methods |
| costLimit | The value of the asset you want to depreciate, if this is less than the cost of the asset. |
| residualValue | The value of the asset remaining when you've fully depreciated it. |

### Elements for Book Depreciation Detail

|  |  |
| --- | --- |
| currentCapitalGain | When an asset is disposed, this will be the sell price minus the purchase price if a profit was made. |
| currentGainLoss | When an asset is disposed, this will be the lowest one of sell price or purchase price, minus the current book value. |
| depreciationStartDate | YYYY-MM-DD |
| priorAccumDepreciationAmount | All depreciation prior to the current financial year. |
| currentAccumDepreciationAmount | All depreciation occurring since the asset depreciation start date. |
| businessUseCapitalGain | **New Zealand Orgs Only** The portion of capital gain realised from the disposal of a fixed asset that is attributable to its business use. |
| businessUseCurrentGainLoss | **New Zealand Orgs Only** Represents the gain or loss from the disposal of the business use portion of a fixed asset. This value records the financial result (profit or loss) related specifically to the asset’s business use. |
| privateUseCapitalGain | **New Zealand Orgs Only** The portion of capital gain realised from the disposal of a fixed asset that is attributable to its private (non-business) use. |
| privateUseCurrentGainLoss | **New Zealand Orgs Only** Represents the gain or loss from the disposal of the private use portion of a fixed asset. This value records the financial result (profit or loss) related specifically to the asset’s private use. |
| initialDeductionPercentage | **New Zealand Orgs Only** The Investment Boost deduction percentage. |

### Parameters for GET Assets

|  |  |
| --- | --- |
| assetId | You can specify an individual record by appending the identifier to the endpoint, i.e. **GET https://…/Assets/4f7bcdcb-5ec1-4258-9558-19f662fccdfe** |
| status | **Required** when retrieving a collection of assets. See Asset Status Codes |
| page | Results are paged. This specifies which page of the results to return. The default page is 1. |
| pageSize | The number of records returned per page. By default the number of records returned is 10. **Maximum pageSize limit is 200.** If pageSize is greater than 200, a bad request error with an error message of "Requested page size cannot exceed 200" will be returned. |
| orderBy | Requests can be ordered by AssetType, AssetName, AssetNumber, PurchaseDate and PurchasePrice. If the asset status is DISPOSED it also allows DisposalDate and DisposalPrice. |
| sortDirection | ASC or DESC |
| filterBy | A string that can be used to filter the list to only return assets containing the text. Checks it against the AssetName, AssetNumber, Description and AssetTypeName fields. |

Example response for a list of draft Assets

```
GET https://api.xero.com/assets.xro/1.0/Assets?status=DRAFT
```


```
{
  "pagination": {
    "page": 1,
    "pageSize": 10,
    "pageCount": 1,
    "itemCount": 2,
  },
  "items": [
    {
      "assetId": "3b5b3a38-5649-495f-87a1-14a4e5918634",
      "assetName": "Awesome Truck 3",
      "assetNumber": "FA-0013",
      "purchaseDate": "2015-07-01T00:00:00",
      "purchasePrice": 1000,
      "disposalPrice": 0,
      "assetStatus": "Draft",
      "canRollback": true,
      "accountingBookValue": 0
    },
    {
      "assetId": "1fd647b8-c449-42cb-9cc4-cd41fe8df262",
      "assetName": "Awesome Car",
      "assetNumber": "FA-0001",
      "purchaseDate": "2015-07-01T00:00:00",
      "purchasePrice": 100000,
      "disposalPrice": 0,
      "assetStatus": "Draft",
      "bookDepreciationSetting": {
        "depreciationMethod": "StraightLine",
        "averagingMethod": "ActualDays",
        "depreciationRate": 0.01,
        "depreciationCalculationMethod": "None",
        "effectiveFromDate": "2015-07-01T00:00:00",
        "costLimit": 100000,
        "residualValue": 10000
      },
      "bookDepreciationDetail": {
        "currentCapitalGain": 0,
        "currentGainLoss": 0,
        "priorAccumDepreciationAmount": 0,
        "currentAccumDepreciationAmount": 0,
        "businessUseCapitalGain": 0,
        "businessUseCurrentGainLoss": 0,
        "privateUseCapitalGain": 0,
        "privateUseCurrentGainLoss": 0,
        "initialDeductionPercentage": 0
      },
      "canRollback": true,
      "accountingBookValue": 100000
    }
  ]
}
```


Once exceeds the pageSize limits, the following response will be returned.

```
GET https://api.xero.com/assets.xro/1.0/Assets?status=DRAFT&pageSize=201
```


```
HTTP 400 Bad Requests
{
    "message": "Requested page size cannot exceed 200"
}
```


Example response for a single asset

```
GET https://api.xero.com/assets.xro/1.0/Assets/92d04e4407404c1facd6edbbceac7faa
```


```
{
  "assetId": "92d04e4407404c1facd6edbbceac7faa",
  "assetName": "Computer",
  "assetNumber": "FA-0021",
  "purchaseDate": "2016-04-11T00:00:00",
  "purchasePrice": 3000,
  "serialNumber": "123456789",
  "warrantyExpiryDate": "2018-04-11T00:00:00",
  "assetTypeId": "5da209c55e194a43b92571b776c49ced",
  "description": "A computer for computing",
  "disposalPrice": 0,
  "assetStatus": "Registered",
  "bookDepreciationSetting": {
    "depreciationMethod": "StraightLine",
    "averagingMethod": "ActualDays",
    "depreciationRate": 33,
    "depreciationCalculationMethod": "None",
    "currentGainLoss": 0
  },
  "bookDepreciationDetail": {
    "currentCapitalGain": 0,
    "depreciationStartDate": "2016-04-11T00:00:00",
    "priorAccumDepreciationAmount": 0,
    "currentAccumDepreciationAmount": 0,
    "businessUseCapitalGain": 0,
    "businessUseCurrentGainLoss": 0,
    "privateUseCapitalGain": 0,
    "privateUseCurrentGainLoss": 0,
    "initialDeductionPercentage": 0
  },
  "canRollback": true,
  "accountingBookValue": 3000
}
```


## POST Assets


Use this method to create draft fixed assets. You can also update assets by including the assetId in the request (not the url).

**POST Assets does not support batching**

The following elements are **required** when creating an asset

|  |  |
| --- | --- |
| assetName | The name of the asset |
| assetNumber | Must be unique. To retrieve the next available Xero-generated assetNumber perform a GET /settings (optional). |

The following elements are **optional** when creating/updating an asset

|  |  |
| --- | --- |
| purchaseDate | The date the asset was purchased YYYY-MM-DD |
| purchasePrice | The purchase price of the asset |
| warrantyExpiryDate | The date the asset’s warranty expires (if needed) YYYY-MM-DD |
| serialNumber | The asset's serial number |
| assetStatus | See Asset Status Codes. Assets can only be created with a status of Draft. |
| bookDepreciationSettings | See Elements for Book Depreciation Settings |
| bookDepreciationDetail | See Elements for Book Depreciation Detail |

Elements for Book Depreciation Settings

|  |  |
| --- | --- |
| effectiveFromDate | The date that this depreciation setting is effective from. Displayed as 'Depreciation start date' (YYYY-MM-DD) |
| depreciationMethod | The method of depreciation applied to this asset. See Depreciation Methods |
| averagingMethod | The method of averaging applied to this asset. See Averaging Methods |
| depreciationRate | The rate of depreciation (e.g. 0.05) |
| effectiveLifeYears | Effective life of the asset in years (e.g. 5) |
| depreciationCalculationMethod | See Depreciation Calculation Methods |
| costLimit | The value of the asset you want to depreciate, if this is less than the cost of the asset. |
| residualValue | The value of the asset remaining when you've fully depreciated it. |

Elements for Book Depreciation Detail

|  |  |
| --- | --- |
| currentCapitalGain | When an asset is disposed, this will be the sell price minus the purchase price if a profit was made. |
| currentGainLoss | When an asset is disposed, this will be the lowest one of sell price or purchase price, minus the current book value. |
| depreciationStartDate | Redundant. Depreciation start date is set via the effectiveFromDate vale on the bookDepreciationSettings object. |
| priorAccumDepreciationAmount | All depreciation prior to the current financial year. |
| currentAccumDepreciationAmount | All depreciation occurring since the asset depreciation start date. |
| businessUseCapitalGain | **New Zealand Orgs Only** The portion of capital gain realised from the disposal of a fixed asset that is attributable to its business use. |
| businessUseCurrentGainLoss | **New Zealand Orgs Only** Represents the gain or loss from the disposal of the business use portion of a fixed asset. This value records the financial result (profit or loss) related specifically to the asset’s business use. |
| privateUseCapitalGain | **New Zealand Orgs Only** The portion of capital gain realised from the disposal of a fixed asset that is attributable to its private (non-business) use. |
| privateUseCurrentGainLoss | **New Zealand Orgs Only** Represents the gain or loss from the disposal of the private use portion of a fixed asset. This value records the financial result (profit or loss) related specifically to the asset’s private use. |
| initialDeductionPercentage | **New Zealand Orgs Only** The Investment Boost deduction percentage. Allowed values 0, 20 or left undefined |

Example of the minimum request to create a new asset

```
POST https://api.xero.com/assets.xro/1.0/Assets
```


```
{
      "assetName": "Other Computer",
      "assetNumber": "FA-00210"
}
```


Example of the minimum request to update an asset

```
POST https://api.xero.com/assets.xro/1.0/Assets
```


```
{
      "assetId": "dacdcf3f-d6b1-425a-921a-777a4d79ad6b",
      "assetName": "Other Computer",
      "assetNumber": "FA-00210",
      "assetStatus": "Draft"
}
```


An example request to create a draft asset with full details

```
POST https://api.xero.com/assets.xro/1.0/Assets
```


```
{
      "assetName": "Keyboard",
      "assetNumber": "FA-00211",
      "purchaseDate": "2016-04-11T00:00:00",
      "purchasePrice": 3000,
      "serialNumber": "123456789",
      "warrantyExpiryDate": "2018-04-11T00:00:00",
      "assetTypeId": "5da209c5-5e19-4a43-b925-71b776c49ced",
      "description": "A computer for computing",
      "bookDepreciationSettings": {
        "effectiveFromDate": "2015-07-01T00:00:00",
        "depreciationMethod": "StraightLine",
        "averagingMethod": "ActualDays",
        "depreciationRate": 33,
        "depreciationCalculationMethod": "None"
      },
      "bookDepreciationDetail": {
        "currentCapitalGain": 10,
        "currentGainLoss": 10,
        "depreciationStartDate": "2016-04-12T00:00:00",
        "priorAccumDepreciationAmount": 0,
        "currentAccumDepreciationAmount": 0,
        "businessUseCapitalGain": 0,
        "businessUseCurrentGainLoss": 0,
        "privateUseCapitalGain": 0,
        "privateUseCurrentGainLoss": 0,
        "initialDeductionPercentage": 0
      }
}
```
