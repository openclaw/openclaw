# Asset Types

## Overview


|  |  |
| --- | --- |
| URL | `https://api.xero.com/assets.xro/1.0/AssetTypes` |
| Methods Supported | GET, POST |
| Description | Allows you to retrieve asset types <br>Allows you to create and update asset types |

## GET AssetTypes


Use this method to retrieve a list of Asset Types.

|  |  |
| --- | --- |
| assetTypeId | Xero generated unique identifier for asset types |
| assetTypeName | The name of the asset type |
| fixedAssetAccountId | The asset account for fixed assets of this type |
| depreciationExpenseAccountId | The expense account for the depreciation of fixed assets of this type |
| accumulatedDepreciationAccountId | The account for accumulated depreciation of fixed assets of this type |
| bookDepreciationSetting | See [bookDepreciationSetting](https://developer.xero.com/#elements-for-bookdepreciationsetting) |
| Locks | All asset types that have accumulated depreciation for any assets that use them are deemed ‘locked’ and cannot be removed. |

Elements for bookDepreciationSetting

|  |  |
| --- | --- |
| depreciationMethod | The method of depreciation applied to this asset. See Depreciation Methods |
| averagingMethod | The method of averaging applied to this asset. See Averaging Methods |
| depreciationRate | The rate of depreciation (e.g. 0.05) |
| effectiveLifeYears | The effective life of the assets of this type in years. Not required if using depreciationRate. |
| depreciationCalculationMethod | See Depreciation Calculation Methods |

Example for retrieving a list of AssetTypes

```
GET https://api.xero.com/assets.xro/1.0/AssetTypes
```


```
[
  {
    "assetTypeId": "5da209c5-5e19-4a43-b925-71b776c49ced",
    "assetTypeName": "Computer Equipment",
    "fixedAssetAccountId": "24e260f1-bfc4-4766-ad7f-8a8ce01de879",
    "depreciationExpenseAccountId": "b23fc79b-d66b-44b0-a240-e138e086fcbc",
    "accumulatedDepreciationAccountId": "ca4c6b39-4f4f-43e8-98da-5e1f350a6694",
    "bookDepreciationSetting": {
      "depreciationMethod": "StraightLine",
      "averagingMethod": "ActualDays",
      "depreciationRate": 33,
      "depreciationCalculationMethod": "None"
    },
    "locks": 0
  },
  {
    "assetTypeId": "a865d898-4ee9-4366-bf37-bfc1b35cf788",
    "assetTypeName": "Office Equipment",
    "fixedAssetAccountId": "24e260f1-bfc4-4766-ad7f-8a8ce01de879",
    "depreciationExpenseAccountId": "b23fc79b-d66b-44b0-a240-e138e086fcbc",
    "accumulatedDepreciationAccountId": "ca4c6b39-4f4f-43e8-98da-5e1f350a6694",
    "bookDepreciationSetting": {
      "depreciationMethod": "StraightLine",
      "averagingMethod": "ActualDays",
      "depreciationRate": 33,
      "depreciationCalculationMethod": "None"
    },
    "locks": 0
  },
  {
    "assetTypeId": "26c17b4a-0093-402c-b9bb-281dedf5c604",
    "assetTypeName": "Vehicles",
    "fixedAssetAccountId": "24e260f1-bfc4-4766-ad7f-8a8ce01de879",
    "depreciationExpenseAccountId": "b23fc79b-d66b-44b0-a240-e138e086fcbc",
    "accumulatedDepreciationAccountId": "ca4c6b39-4f4f-43e8-98da-5e1f350a6694",
    "bookDepreciationSetting": {
      "depreciationMethod": "StraightLine",
      "averagingMethod": "ActualDays",
      "depreciationRate": 33,
      "depreciationCalculationMethod": "None"
    },
    "locks": 0
  }
]
```


## POST AssetTypes


Use this method to create asset types. You can also update asset types by including the assetTypeID in the request (not the url).

The following elements are **required** when creating an Asset Type

|  |  |
| --- | --- |
| assetTypeName | The name of the asset type |
| fixedAssetAccountId | The asset account for fixed assets of this type |
| depreciationExpenseAccountId | The expense account for the depreciation of fixed assets of this type |
| accumulatedDepreciationAccountId | The account for accumulated depreciation of fixed assets of this type |
| bookDepreciationSetting | See [bookDeprecaitionSetting](https://developer.xero.com/#elements-for-bookdepreciationsetting) |

Elements for Book Depreciation Setting

|  |  |
| --- | --- |
| depreciationMethod | The method of depreciation applied to this asset. See Depreciation Methods |
| averagingMethod | The method of averaging applied to this asset. See Averaging Methods |
| depreciationRate | The rate of depreciation (e.g. 0.05) |
| effectiveLifeYears | The effective life of the assets of this type in years. Not required if using depreciationRate. |
| depreciationCalculationMethod | See Depreciation Calculation Methods |

Example of creating an AssetType

```
POST https://api.xero.com/assets.xro/1.0/AssetTypes
```


```
{
 "assetTypeName": "Computer Equipment",
 "fixedAssetAccountId": "afe53f21-1221-451c-a8c4-08457e129d84",
 "depreciationExpenseAccountId": "9a30bb28-6d9d-428b-8a98-b0b591518d5b",
 "accumulatedDepreciationAccountId": "b7e1f170-d238-41d7-ab2b-d0a89b16838f",
 "bookDepreciationSetting": {
  "depreciationMethod": "DiminishingValue100",
  "averagingMethod": "ActualDays",
  "depreciationRate": 40,
  "depreciationCalculationMethod": "None"
 }
}
```
