# Subscriptions

**Overview**

|  |  |
| --- | --- |
| **URL** | [https://api.xero.com/appstore/2.0/Subscriptions](https://api.xero.com/appstore/2.0/Subscriptions) |
| **Methods Supported** | GET |
| **Description** | Allows you to retrieve App Store subscription details |

## GET Subscription


The following elements are returned in the subscription response

|  |  |
| --- | --- |
| currentPeriodEnd | Date when the current subscription period ends |
| endDate | If the subscription has been canceled, this is the date when the subscription ends. If null, the subscription is active and has not been cancelled |
| id | The unique identifier for the subscription |
| testMode | Boolean used to indicate if the subscription is in test mode. See testing |
| organisationId | The Xero generated unique identifier for the organisation |
| plans | The plan which has been subscribed to. See plans below |
| startDate | Date when the subscription was first created |
| status | Status of the subscription. See subscription status types |

Elements for plans

|  |  |
| --- | --- |
| id | The unique identifier for the plan |
| name | The name of the plan, this will display as the plan name in the plan selection UI |
| status | Status of the plan the user is subscribed to. See plans |
| subscriptionItems | List of the subscription items belonging to the plan. This will return all relevant items for the current billing period. See subscription items below |

Elements for subscription items

|  |  |
| --- | --- |
| status | Status of the subscription items the user is subscribed to |
| endDate | Date when the subscription to this product will end |
| id | The unique identifier for the subscription item |
| price | The price of the product subscribed to. See prices below |
| product | The product that the customer has subscribed to. See product below |
| quantity | The quantity subscribed to. Fixed products will always return 1, Per-Seat products will return the quantity set by the customer. Metered will always return null |
| startDate | Start date for the subscription to this item. Note: this may be in the future for downgrades or reduced number of seats that haven't taken effect yet |
| testMode | Boolean used to indicate if the subscription is in test mode. See testing |

Elements for price

|  |  |
| --- | --- |
| amount | The net (before tax) amount of the price |
| currency | The currency of the price |
| id | The unique identifier for the price |

Elements for product

|  |  |
| --- | --- |
| id | The unique identifier for the product |
| name | The name of the product |
| seatUnit | The unit associated with per-seat product |
| type | The pricing model of the product. See product types |
| usageUnit | The unit associated with the metered product |

Required Parameter

|  |  |
| --- | --- |
| id | The unique identifier for the subscription |

Example response when retrieving a subscription

|  |  |
| --- | --- |
| GET ../appstore/2.0/subscriptions/01b5a6f4-8936-4bfa-b703-830702312b87 |  |

```
{
  "currentPeriodEnd": "2021-07-20T03:13:48",
  "endDate": "2021-07-20T03:13:48",
  "id": "01b5a6f4-8936-4bfa-b703-830702312b87",
  "testMode": true,
  "organisationId": "fdc5be44-9b3e-4ebb-a0e9-11b9737f9a28",
  "plans": [
    {
      "id": "f617dd59-462f-46a1-9519-1765fd38b160",
      "name": "Small",
      "status": "ACTIVE",
      "subscriptionItems": [
        {
          "endDate": "2021-07-20T03:13:48",
          "id": "c7336bf6-8a47-4f13-9fc0-82420e6922c8",
          "quantity": 1,
          "testMode": true,
          "price": {
            "amount": 50,
            "currency": "AUD",
            "id": "31acefbe-bdb7-4329-84d6-51e9afd95327"
          },
          "product": {
            "id": "56d66073-ff78-497b-a726-ca9d56fdafa3",
            "name": "Small",
            "type": "FIXED"
          },
          "startDate": "2021-07-20T03:13:48"
        }
      ]
    }
  ],
  "startDate": "2021-07-20T03:13:48",
  "status": "ACTIVE"
}
```


It is possible to combine more than one pricing model in a single plan. This allows for greater flexibility to represent more plan types.

The three types of pricing models supported are

- Fixed
- Per-Seat
- Metered
- Simple

See Pricing Models to find out which pricing model(s) are best suitable for representing your plans.

Example response when retrieving a subscription with combined billing models. This example contains a **Fixed, Per-Seat, Metered** and **Simple** product.

|  |  |
| --- | --- |
| GET ../appstore/2.0/subscriptions/005ae883-c282-4112-a284-3912d837ee2d |  |

```
{
    "id": "005ae883-c282-4112-a284-3912d837ee2d",
    "organisationId": "a351e688-413b-4f87-8ebc-585c287357a2",
    "status": "ACTIVE",
    "startDate": "2022-03-17T01:35:11",
    "endDate": null,
    "currentPeriodEnd": "2022-03-18T01:35:11",
    "testMode": true,
    "plans": [
        {
            "id": "4e293023-d12d-4cc6-89cb-bbd7d4bce33f",
            "name": "Medium",
            "status": "ACTIVE",
            "subscriptionItems": [
                {
                    "id": "7ff72db1-e631-4753-a284-4754f11f59a5",
                    "startDate": "2022-03-17T01:35:11",
                    "endDate": null,
                    "testMode": false,
                    "product": {
                        "id": "8b4bba4a-d7b8-4623-ab3c-7ad49168a834",
                        "name": "Fixed product",
                        "type": "FIXED",
                        "seatUnit": null,
                        "usageUnit": null
                    },
                    "price": {
                        "id": "a5c0adb7-ec4d-4cb9-b635-02cd6907e44c",
                        "amount": 2.0000,
                        "currency": "AUD"
                    },
                    "quantity": 1,
                    "status": "ACTIVE"
                },
                {
                    "id": "28d165c7-f6ea-43af-b4a2-5a17632b0439",
                    "startDate": "2022-03-17T01:35:11",
                    "endDate": null,
                    "testMode": false,
                    "product": {
                        "id": "fba307b3-058d-4d09-9a87-c916d1ccb423",
                        "name": "Seat product",
                        "type": "SEAT",
                        "seatUnit": "Organisations",
                        "usageUnit": null
                    },
                    "price": {
                        "id": "9e0dcbbe-a291-4107-b81a-3245a0bd0895",
                        "amount": 10.0000,
                        "currency": "AUD"
                    },
                    "quantity": 5,
                    "status": "ACTIVE"
                },
                {
                    "id": "81dd6c53-4667-4522-98d5-8fab24cc19f0",
                    "startDate": "2022-03-17T01:35:11",
                    "endDate": null,
                    "testMode": false,
                    "product": {
                        "id": "bd8407c7-1b7f-48b0-8cf8-a7e2113f22b6",
                        "name": "Metered product",
                        "type": "METERED",
                        "seatUnit": null,
                        "usageUnit": "Minutes"
                    },
                    "price": {
                        "id": "687ab858-0558-453b-9f5c-586c68772956",
                        "amount": 0.4000,
                        "currency": "AUD"
                    },
                    "quantity": null,
                    "status": "ACTIVE"
                },
                {
                    "id": "2b86d387-4e38-4777-ac26-ab1867227250",
                    "startDate": "2022-03-17T01:35:11",
                    "endDate": null,
                    "testMode": false,
                    "product": {
                        "id": "531eb4f7-5d70-4a55-9ce2-f25b7acaa763",
                        "name": "Simple product",
                        "type": "SIMPLE",
                        "seatUnit": null,
                        "usageUnit": null
                    },
                    "price": {
                        "id": "5f1234fc-40ce-4640-b2da-82ff10e83cc1",
                        "amount": 25.0000,
                        "currency": "AUD"
                    },
                    "quantity": 1,
                    "status": "ACTIVE"
                }

            ]
        }
    ]
}
```
