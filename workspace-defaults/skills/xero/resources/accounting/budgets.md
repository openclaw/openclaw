# Budgets

All apps created from 12 April 2021 will have access to the budgets scope by default. If you have an app that was created before 12 April 2021 then you'll need to get in touch with us.

- If you're an app partner, or in the process of getting certified, please reach out to your developer evangelist or app partner manager to discuss.
- If your integration is uncertified, please contact [our developer platform support team](https://developer.xero.com/contact-xero-developer-platform-support/).

## Overview


| Property | Description |
| --- | --- |
| URL | [https://api.xero.com/api.xro/2.0/Budgets](https://api.xero.com/api.xro/2.0/Budgets) |
| Methods Supported | GET |
| Description | Retrieve a list of budgets <br>Retrieve the detail of an individual budget |

## GET Budgets


Use this method to retrieve one or many Budgets.

- By default responses are formatted as XML. You can also retrieve responses in JSON format.
- When no period is requested, responses will default to 3 months. Previous, Current & Next month
- You can retrieve a maximum of 24 months of data in a single request.

The following elements are returned in the Budgets response:

| Field | Description |
| --- | --- |
| BudgetID | Xero generated identifier for a Budget (unique within organisations) |
| Type | Type of Budget. OVERALL or TRACKING |
| Description | The Budget description |
| UpdatedDateUTC | The last modified date UTC format |
| Tracking | See Tracking Category |
| BudgetLines | See BudgetLines – Budget lines will not be returned unless requesting a single budget |

Elements for Tracking Category

| Field | Description |
| --- | --- |
| Name | Name of the tracking category |
| Option | Name of the option _(Required)_ |
| TrackingCategoryID | Xero generated unique identifier for the category |
| Options | See Tracking Options section in Tracking Category |

Elements for Budget Lines

| Field | Description |
| --- | --- |
| AccountID | Xero generated unique identifier |
| AccountCode | Customer defined alpha numeric account code e.g 200 or SALES |
| Balances | See Balances |

Elements for Balances

| Field | Description |
| --- | --- |
| Period | Period the amount applies to (e.g. “2019-08”) |
| Amount | LineItem Quantity |
| UnitAmount | Budgeted amount |

### Optional parameters for GET Budgets

| Field | Description |
| --- | --- |
| **Record filter** | You can specify an individual budget by appending the BudgetID to the endpoint, i.e. <br>**GET [https://.../Budgets/297c2dc5-cc47-4afd-8ec8-74990b8761e9](https://.../Budgets/297c2dc5-cc47-4afd-8ec8-74990b8761e9)** |
| DateTo | Include periods to this date YYYY-MM-DD |
| DateFrom | Include periods from this date YYYY-MM-DD |

Example response when retrieving a single budget

```
GET https://api.xero.com/api.xro/2.0/Budgets/c1d195d4-92aa-4abd-867a-7ac2f9d60500
```


```
{
 "Budgets": {
    "BudgetID": "c1d195d4-92aa-4abd-867a-7ac2f9d60500",
    "Type": "TRACKING",
    "Description": "Daniel's Northern Budget",
    "UpdatedDateUTC": "2017-08-14T01:18:26.74",
    "Tracking": [
       {
          "Name": "Region",
          "Option": "North",
          "TrackingCategoryID": "e94ba240-3edf-4ef3-8317-10147b968f94",
          "Options": []
       },
       {
          "Name": "Salesperson",
          "Option": "Daniel",
          "TrackingCategoryID": "d8580491-4167-4a81-9624-ad3bdd8e46ce",
          "Options": []
       }
    ],
    "BudgetLines": [
       {
          "AccountID": "9c24de87-a2b7-439d-a216-35d1af7bdec3",
          "AccountCode": "200",
          "BudgetBalances": [
             {
                "Period": "2019-08",
                "Amount": "1000"
             },
             {
                "Period": "2019-09",
                "Amount": "1050"
             },
             {
                "Period": "2019-10",
                "Amount": "1102"
             }
          ]
       },
       {
          "AccountID": "385f90ae-e798-4990-9b1c-db8eb8b735c2",
          "AccountCode": "420",
          "BudgetBalances": [
             {
                "Period": "2019-08",
                "Amount": "500"
             },
             {
                "Period": "2019-09",
                "Amount": "505"
             },
             {
                "Period": "2019-10",
                "Amount": "510"
             }
          ]
       }
    ]
    }
 }
```


Example response when retrieving multiple budgets

```
GET https://api.xero.com/api.xro/2.0/budgets
```


```
{
  "Budgets":[
  {
      "BudgetID": "c1d195d4-92aa-4abd-867a-7ac2f9d60500",
      "Type": "TRACKING",
      "Description": "Daniel's Northern Budget",
      "UpdatedDateUTC": "2017-08-14T01:18:26.74",
      "Tracking": [
        {
            "Name": "Region",
            "Option": "North",
            "TrackingCategoryID": "e94ba240-3edf-4ef3-8317-10147b968f94",
            "Options": []
        },
        {
            "Name": "Salesperson",
            "Option": "Daniel",
            "TrackingCategoryID": "d8580491-4167-4a81-9624-ad3bdd8e46ce",
            "Options": []
        }
      ],
      "BudgetLines": []
  },
  {
      "BudgetID": "ce205173-7387-4651-9726-2cf4c5405ba2",
      "Type": "TRACKING",
      "Description": "Adam's Southern budget",
      "UpdatedDateUTC": "2019-01-19T01:09:20.87",
      "Tracking": [
        {
            "Name": "Region",
            "Option": "South",
            "TrackingCategoryID": "351953c4-8127-4009-88c3-f9cd8c9cbe9f",
            "Options": []
        },
        {
            "Name": "Salesperson",
            "Option": "Adam",
            "TrackingCategoryID": "6eb12fdf-63de-4033-98df-be679d84e3c2",
            "Options": []
        }
      ],
      "BudgetLines": []
  },
  {
      "BudgetID": "821731a3-b1e0-436d-929f-a3423bbd813b",
      "Type": "OVERALL",
      "Description": "Demo Company Full Budget",
      "UpdatedDateUTC": "2020-01-19T11:00:55.12",
      "Tracking": [],
      "BudgetLines": []
  }
  ]
}
```
