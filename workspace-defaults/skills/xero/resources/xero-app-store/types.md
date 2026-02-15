# Types

## Subscriptions


### Subscription Status

|  |  |
| --- | --- |
| **ACTIVE** | The subscription is active and the user should have access to your app. |
| **CANCELED** | The subscription has been canceled and the user should not have access to your app. See subscription cancelations |
| **PAST\_DUE** | The latest payment for the subscription has failed, the user should still have access to your app. See failed payments |

### Plan Status

|  |  |
| --- | --- |
| **ACTIVE** | The plan is active and the user should have access to the entitlements of this plan |
| **CANCELED** | The plan is canceled and the user should no longer have access to this plan. If a user has upgraded their plan, the previous plan in the current billing period will have the ‘CANCELED’ status. See subscription upgrades |
| **PENDING\_ACTIVATION** | The plan is not yet active for this subscription but will change to it at the currentPeriodEnd. See subscription downgrades |

### Subscription Item Status

|  |  |
| --- | --- |
| **ACTIVE** | The subscription item is active and the user is currently subscribed to this item |
| **CANCELED** | The subscription item is canceled and the user should no longer have access to this item. If a user has upgraded their plan, the previous plan in the current billing period will have the ‘CANCELED’ status. See subscription upgrades |
| **PENDING\_ACTIVATION** | The subscription item is not yet active for this subscription but will change to it at the currentPeriodEnd. See subscription downgrades |

### Product Types

|  |  |
| --- | --- |
| **FIXED** | Customers are charged a fixed amount for each billing period |
| **PER\_SEAT** | Customers are charged based on the number of units they purchase. See Xero App Store subscriptions |
| **METERED** | Customers are charged based on their consumption of the service during the billing period. See metered billing |
| **SIMPLE** | Customers are charged if they opt in to choose this add-on. See Xero App Store subscriptions. |
