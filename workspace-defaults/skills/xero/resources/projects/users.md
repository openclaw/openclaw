# Projects Users

## Overview


|  |  |
| --- | --- |
| URL | `https://api.xero.com/projects.xro/2.0/projectsusers` |
| Methods Supported | GET |
| Description | Allows you to retrieve all active projects users. |

## GET projectsusers


The following elements are returned in the projectusers response

|  |  |
| --- | --- |
| userId | Identifier of the user. |
| name | Full name of the user. |
| email | Email address of the user. |

Elements for pagination

|  |  |
| --- | --- |
| page | TThe page number within the collection. |
| pageSize | The number of items in this page. |
| pageCount | The total number of pages in the collection. |
| itemCount | The total number of items in all the pages of the collection. |

### Optional parameters for GET projectsusers

|  |  |
| --- | --- |
| page | Optional, it is set to 1 by default. The requested number of the page in paged response – Must be a number greater than 0. |
| pageSize | Optional, it is set to 50 by default. The number of items to return per page in a paged response – Must be a number between 1 and 500. |

Example retrieving of a list of projectsusers

```
GET https://api.xero.com/projects.xro/2.0/projectsusers?page=1&pageSize=50
```


```
{
  "pagination": {
    "page": 1,
    "pageSize": 50,
    "pageCount": 1,
    "itemCount": 1
  },
  "items": [
    {
      "userId": "254484db-fa53-4ac2-b537-1d516fca67e9",
      "name": "Andrea Dutchess",
      "email": "a.dutchess@abclimited.com"
    }
  ]
}
```
