# Currencies


## Overview


|  |  |
| --- | --- |
| URL | [https://api.xero.com/api.xro/2.0/Currencies](https://api.xero.com/api.xro/2.0/Currencies) |
| Methods Supported | GET, PUT |
| Description | Retrieve currencies for your organisation <br>Add currencies to your organisation |

## GET Currencies


The following elements are returned in a response for Currencies

|  |  |
| --- | --- |
| Code | 3 letter alpha code for the currency – see list of [currency codes](http://www.xe.com/iso4217.php) |
| Description | Name of Currency |

### Optional parameters for GET Currencies

|  |  |
| --- | --- |
| Where | Filter by an any element ( _see Filters_ ) |
| order | Order by any element returned ( _see Order By_ ) |

Example response for GET Currencies

```
GET https://api.xero.com/api.xro/2.0/Currencies
```


```
{
  "Currencies": [
    {
      "Code": "NZD",
      "Description": "New Zealand Dollar"
    }
  ...
  ]
}
```


## PUT Currencies


The following elements can be used when adding Currencies. It is not possible to remove currencies from an organisation once they've been added.

|  |  |
| --- | --- |
| Code | 3 letter alpha code for the currency – see list of [currency codes](http://www.xe.com/iso4217.php) |

Example response for PUT Currencies

```
PUT https://api.xero.com/api.xro/2.0/Currencies
```


```
{
  "Currencies": [
    {
      "Code": "SGD",
      "Description": "Singapore Dollar"
    }
  ...
  ]
}
```
