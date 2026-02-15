# Tracking Categories


## Overview


|  |  |
| --- | --- |
| URL | [https://api.xero.com/api.xro/2.0/TrackingCategories](https://api.xero.com/api.xro/2.0/TrackingCategories) |
| Methods Supported | GET, PUT, POST, DELETE |
| Description | Retrieve tracking categories and options for a Xero organisation <br>Add new tracking categories and options <br>Rename tracking categories and options <br>Update the status of tracking categories and options <br>Delete unused tracking categories and options |

## GET TrackingCategories


Elements for Tracking Categories

|  |  |
| --- | --- |
| TrackingCategoryID | The Xero identifier for a tracking category <br>e.g. 297c2dc5-cc47-4afd-8ec8-74990b8761e9 (unique within organisations) |
| Name | The name of the tracking category e.g. Department, Region (max length = 100) |
| Status | See Status Codes |
| Options | See Tracking Options |

Elements for Tracking Options

|  |  |
| --- | --- |
| TrackingOptionID | The Xero identifier for a tracking option <br>e.g. ae777a87-5ef3-4fa0-a4f0-d10e1f13073a (unique within organisations) |
| Name | The name of the tracking option e.g. Marketing, East (max length = 100) |
| Status | See Status Codes |
| HasValidationErrors | Boolean to show if the tracking option has any validation errors |
| IsDeleted | Boolean to show if the tracking option has been deleted |
| IsArchived | Boolean to show if the tracking option has been archived |
| IsActive | Boolean to show if the tracking option is active |

### Optional parameters for GET TrackingCategories

|  |  |
| --- | --- |
| TrackingCategoryID | Filter by a tracking category <br>e.g. 297c2dc5-cc47-4afd-8ec8-74990b8761e9 |
| Where | Filter by any element ( _see Filters_ ) |
| order | Order by any element returned ( _see Order By_ ) |
| includeArchived | e.g. includeArchived=true – Categories and options with a status of ARCHIVED will be included in the response |

Example response for retrieving TrackingCategories

```
GET https://api.xero.com/api.xro/2.0/TrackingCategories
```


```
{
  "TrackingCategories": [
    {
      "Name": "Region",
      "Status": "ACTIVE",
      "TrackingCategoryID": "351953c4-8127-4009-88c3-f9cd8c9cbe9f",
      "Options": [
        {
          "TrackingOptionID": "ce205173-7387-4651-9726-2cf4c5405ba2",
          "Name": "Eastside",
          "Status": "ACTIVE",
          "HasValidationErrors": false,
          "IsDeleted": false,
          "IsArchived": false,
          "IsActive": true
        },
        {
          "TrackingOptionID": "6eb12fdf-63de-4033-98df-be679d84e3c2",
          "Name": "North",
          "Status": "ACTIVE",
          "HasValidationErrors": false,
          "IsDeleted": false,
          "IsArchived": false,
          "IsActive": true
        },
        {
          "TrackingOptionID": "6159bdd4-b634-4338-a664-e929aa73f70f",
          "Name": "South",
          "Status": "ACTIVE",
          "HasValidationErrors": false,
          "IsDeleted": false,
          "IsArchived": false,
          "IsActive": true
        },
        {
          "TrackingOptionID": "161ad543-97ab-4436-8213-e0d794b1ea90",
          "Name": "West Coast",
          "Status": "ACTIVE",
          "HasValidationErrors": false,
          "IsDeleted": false,
          "IsArchived": false,
          "IsActive": true
        }
      ]
    }
  ]
}
```


## PUT TrackingCategories


Use this method to create tracking categories and options

**Note:** We recommend a soft limit of 100 options to a tracking category. Having more than 100 options can slow down loading reports.

Elements for Tracking Categories

|  |  |
| --- | --- |
| Name | The name of the tracking category e.g. Department, Region (max length = 100) |
| Status | The status of a tracking category |
| Options | See Tracking Options |

Elements for Tracking Options

|  |  |
| --- | --- |
| TrackingOptionID | The Xero identifier for a tracking option <br>e.g. ae777a87-5ef3-4fa0-a4f0-d10e1f13073a |
| Name | The name of the tracking option e.g. Marketing, East (max length = 100) |
| Status | The status of a tracking option |

Note: A Xero organisation can have a maximum of two ACTIVE tracking categories and four tracking categories total (ACTIVE and ARCHIVED)

Example request to create a Tracking Category

```
PUT https://api.xero.com/api.xro/2.0/TrackingCategories
```


```
{
  "Name": "New Category"
}
```


Example request to create Tracking Options

```
PUT https://api.xero.com/api.xro/2.0/TrackingCategories/{TrackingCategoryID}/Options
```


```
{
  "Name": "New Option"
}
```


## POST TrackingCategories


Use this method to update tracking categories and options.

Example request to update a Tracking Category Name

```
POST https://api.xero.com/api.xro/2.0/TrackingCategories/{TrackingCategoryID}
```


```
{
  "Name": "New Name"
}
```


Example request to update a Tracking Category Status

```
POST https://api.xero.com/api.xro/2.0/TrackingCategories/{TrackingCategoryID}
```


```
{
  "Status": "ARCHIVED"
}
```


Example request to update a tracking option name

```
POST https://api.xero.com/api.xro/2.0/TrackingCategories/{TrackingCategoryID}/Options/{TrackingOptionID}
```


```
{
  "Name": "New Name"
}
```


Example request to update a tracking option status

```
POST https://api.xero.com/api.xro/2.0/TrackingCategories/{TrackingCategoryID}/Options/{TrackingOptionID}
```


```
{
  "Status": "ARCHIVED"
}
```


## DELETE TrackingCategories


Example request to delete a Tracking Category

```
DELETE https://api.xero.com/api.xro/2.0/TrackingCategories/{TrackingCategoryID}
```


Example request to delete a Tracking Option

```
DELETE https://api.xero.com/api.xro/2.0/TrackingCategories/{TrackingCategoryID}/Options/{TrackingOptionID}
```
