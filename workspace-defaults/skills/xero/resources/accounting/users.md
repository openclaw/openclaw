# Users


## Overview


|  |  |
| --- | --- |
| URL | [https://api.xero.com/api.xro/2.0/Users](https://api.xero.com/api.xro/2.0/Users) |
| Methods Supported | GET |
| Description | Returns the users for a Xero organisation |

## GET Users


Response elements returned for GET Users

|  |  |
| --- | --- |
| UserID | Xero identifier |
| EmailAddress | Email address of user |
| FirstName | First name of user |
| LastName | Last name of user |
| UpdatedDateUTC | Timestamp of last change to user |
| IsSubscriber | Boolean to indicate if user is the subscriber |
| OrganisationRole | User role ( _see Types_ ) |

### Optional parameters for GET Users

|  |  |
| --- | --- |
| UserID | The Xero identifier for an user – specified as a string following the endpoint name e.g. **/297c2dc5-cc47-4afd-8ec8-74990b8761e9** |
| Modified After | The ModifiedAfter filter is actually an HTTP header: ' **If-Modified-Since**'. <br>A UTC timestamp (yyyy-mm-ddThh:mm:ss). Only contacts created or modified since this timestamp will be returned e.g. 2009-11-12T00:00:00 |
| where | Filter by any element ( _see Filters_ ) |
| order | Order by any element returned ( _see Order By_ ) |

Example response retrieving Users

```
GET https://api.xero.com/api.xro/2.0/Users
```


```
{
  "Users": [
    {
      "UserID": "7cf47fe2-c3dd-4c6b-9895-7ba767ba529c",
      "EmailAddress": "john.smith@mail.com",
      "FirstName": "John",
      "LastName": "Smith",
      "UpdatedDateUTC": "\/Date(1516230549137+0000)\/",
      "IsSubscriber": false,
      "OrganisationRole": "ADMIN"
    }
    ...
  ]
}
```
