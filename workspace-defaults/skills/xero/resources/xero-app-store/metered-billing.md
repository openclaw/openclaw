# Metered billing

Metered billing is a product type that is used to charge users a variable amount at the end of the billing period, based on how much you report they use your product throughout the billing period with the Usage API. At the end of the billing period, the total usage submitted is multiplied by the pricePerUnit to calculate how much the customer owes.

This product type can be used when you want your customer to be billed at the end of the month (in arrears) based on how much of your service they have used.

**Overview**

|  |  |
| --- | --- |
| **URLs** | [https://api.xero.com/appstore/2.0/subscriptions/{subscription\_id}/items/{subscription\_item\_id}/usage-records](https://api.xero.com/appstore/2.0/subscriptions/%7Bsubscription_id%7D/items/%7Bsubscription_item_id%7D/usage-records) |
|  | [https://api.xero.com/appstore/2.0/subscriptions/{subscription\_id}/usage-records](https://api.xero.com/appstore/2.0/subscriptions/%7Bsubscription_id%7D/usage-records) |
|  | [https://api.xero.com/appstore/2.0/subscriptions/{subscription\_id}/items/{subscription\_item\_id}/usage-records/{usage\_record\_id}](https://api.xero.com/appstore/2.0/subscriptions/%7Bsubscription_id%7D/items/%7Bsubscription_item_id%7D/usage-records/%7Busage_record_id%7D) |
| **Methods Supported** | GET, PUT, POST |
| **Description** | This endpoint will allow listing, creating and amendment of usage records for a given user's subscription on App Store Billing. |

**Setup**

If you have a plan which incorporates metered billing please reach out to [api@xero.com](mailto:api@xero.com) so our team can help you get set up.

To set up a metered price you will need to provide the cost for a single unit. The Usage API will only accept integers passed in the quantity parameter so it is advised that you set up your pricePerUnit in the smallest increment of your service.

## Reporting usage


You can report on your customers’ usage by providing the subscriptionId and the subscriptionItemId as request parameters. This allows you to choose which plan to report usage for if a customer has upgraded their plan within a billing cycle.

Usage is calculated by taking the pricePerUnit that you specified when you set up the plan and multiplying this by the amount the customer has used.

For example if your metered product is 10c per text sent (so the unit\_amount you entered when you set up the plan was 0.10) and the customer has sent 50 texts at the time of reporting usage, you would pass 50 as the ‘quantity’ to the usage API. This would mean that the customer is charged $5 (0.10c x 50 texts)

| What | How it’s set | Value |
| --- | --- | --- |
| Price per unit | When creating the plan | 0.10 |
| Quantity | Through the usage API | 50 |
| Amount charged to customer | Price per unit \* quantity | $5.00 |

**Things to know**

You can either submit one usage record with the total quantity the customer has used, or multiple usage records within a billing period. When sending multiple usage records, they will be added together and totaled at the end of the billing period.

If you want to charge a customer for usage within a billing period, you must report the usage before the currentPeriodEnd. Any usage submitted after the currentPeriodEnd will be applied to the next billing period.

In a situation where a customer has upgraded their subscription and has usage in the period before and after the upgrade, usage will be reported in two separate requests using the subscriptionItemId before the upgrade and after the upgrade. These are unique to each customer and can be retrieved via the Subscriptions API.

At the end of the billing period, Xero automatically totals and invoices for all usage during the billing period. If no usage has been reported for the current billing period, the customer will not be charged.

## POST usage record


[https://api.xero.com/appstore/2.0/subscriptions/{subscription\_id}/items/{subscription\_item\_id}/usage-records](https://api.xero.com/appstore/2.0/subscriptions/%7Bsubscription_id%7D/items/%7Bsubscription_item_id%7D/usage-records)

_The following are **required** to create a usage record_

|  |  |
| --- | --- |
| quantity | The quantity of usage to submit to this subscription. Must be an integer. |
| timestamp | Datetime. Timestamps should be submitted in UTC time |

**Request Body example**

|  |  |
| --- | --- |
| POST [https://api.xero.com/appstore/2.0/subscriptions/91c2f546-78ed-4164-ab76-ee74b6377563/items/8da9ab6a-6aab-411f-aff7-3737d4895d17/usage-records](https://api.xero.com/appstore/2.0/subscriptions/91c2f546-78ed-4164-ab76-ee74b6377563/items/8da9ab6a-6aab-411f-aff7-3737d4895d17/usage-records) |  |

```
{
  "quantity": 5,
  "timestamp": "2022-03-17T01:35:11"
}
```


**Example response**

```
{
  "usageRecordId": "213ab71b-51cf-4069-9fb4-70c426293436",
  "subscriptionId": "91c2f546-78ed-4164-ab76-ee74b6377563",
  "subscriptionItemId": "8da9ab6a-6aab-411f-aff7-3737d4895d17",
  "productId": "d2b133d9-95d8-4446-807a-ae7ebc7353f6",
  "pricePerUnit": 0.1,
  "quantity": 5,
  "testMode": true,
  "recordedAt": "2022-03-17T01:35:11"
}
```


## GET all usage records


[https://api.xero.com/appstore/2.0/subscriptions/{subscription\_id}/usage-records](https://api.xero.com/appstore/2.0/subscriptions/%7Bsubscription_id%7D/usage-records)

You can return an array of all current usage records submitted against a given customer's subscription within the current billing period. Xero recommends that you maintain your own system for recording customer usage.

You can use this to verify the total quantity of usage submitted against a customer.

**Example response**

|  |  |
| --- | --- |
| GET [https://api.xero.com/appstore/2.0/subscriptions/91c2f546-78ed-4164-ab76-ee74b6377563/usage-record](https://api.xero.com/appstore/2.0/subscriptions/91c2f546-78ed-4164-ab76-ee74b6377563/usage-record) |  |

```
{
  "usageRecords": [
    {
      "usageRecordId": "213ab71b-51cf-4069-9fb4-70c426293436",
      "subscriptionId": "91c2f546-78ed-4164-ab76-ee74b6377563",
      "subscriptionItemId": "8da9ab6a-6aab-411f-aff7-3737d4895d17",
      "productId": "d2b133d9-95d8-4446-807a-ae7ebc7353f6",
      "pricePerUnit": 0.10,
      "quantity": 5,
      "testmode": true,
      "recordedAt": "2022-03-17T01:35:11"
    },
    {
      "usageRecordId": "d165c7c7-ac1e-41ff-901c-168be70e0a0e",
      "subscriptionId": "91c2f546-78ed-4164-ab76-ee74b6377563",
      "subscriptionItemId": "8da9ab6a-6aab-411f-aff7-3737d4895d17",
      "productId": "d2b133d9-95d8-4446-807a-ae7ebc7353f6",
      "pricePerUnit": 0.10,
      "quantity": 12,
      "testmode": true,
      "recordedAt": "2022-03-17T07:77:15"
    }, ...
  ]
}
```


## PUT update usage record


[https://api.xero.com/appstore/2.0/subscriptions/{subscription\_id}/items/{subscription\_item\_id}/usage-records/{usage\_record\_id}](https://api.xero.com/appstore/2.0/subscriptions/%7Bsubscription_id%7D/items/%7Bsubscription_item_id%7D/usage-records/%7Busage_record_id%7D)

You can amend an existing usage record within the customers current billing period to make any required changes before the customer is billed. You can’t amend a usage record that is outside of the current billing period.

If the exact usage record you wish to amend is not known, use the GET usage records endpoint.

_The following are **required** to amend a usage record_

|  |  |
| --- | --- |
| quantity | The new quantity of usage you want to change the specified usage record to. Must be an integer. |

**Request Body example**

|  |  |
| --- | --- |
| PUT [https://api.xero.com/appstore/2.0/subscriptions/91c2f546-78ed-4164-ab76-ee74b6377563/items/8da9ab6a-6aab-411f-aff7-3737d4895d17/usage-records/213ab71b-51cf-4069-9fb4-70c426293436](https://api.xero.com/appstore/2.0/subscriptions/91c2f546-78ed-4164-ab76-ee74b6377563/items/8da9ab6a-6aab-411f-aff7-3737d4895d17/usage-records/213ab71b-51cf-4069-9fb4-70c426293436) |  |

```
{
  "quantity": 3
}
```


**Example response**

```
{
  "usageRecordId": "213ab71b-51cf-4069-9fb4-70c426293436",
  "subscriptionId": "91c2f546-78ed-4164-ab76-ee74b6377563",
  "subscriptionItemId": "8da9ab6a-6aab-411f-aff7-3737d4895d17",
  "productId": "d2b133d9-95d8-4446-807a-ae7ebc7353f6",
  "pricePerUnit": 0.1,
  "quantity": 3,
  "testmode": true,
  "recordedAt": "2022-03-17T07:77:15"
}
```
