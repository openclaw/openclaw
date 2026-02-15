# Associations

## Overview


|  |  |
| --- | --- |
| URL | [https://api.xero.com/files.xro/1.0/Files/{FileId}/Associations](https://api.xero.com/files.xro/1.0/Files/%7BFileId%7D/Associations) |
| Methods Supported | POST, GET, DELETE |
| Description | Allows you to associate and disassociate files with invoices, contacts, accounts etc. |

## GET Associations


The following elements are returned in the associations response

|  |  |
| --- | --- |
| FileId | The unique identifier of the file |
| ObjectId | The identifier of the object that the file is being associated with (e.g. InvoiceID, BankTransactionID, ContactID) |
| ObjectGroup | The Object Group that the object is in. These roughly correlate to the endpoints that can be used to retrieve the object via the core accounting API. |
| ObjectType | The Object Type. |
| SendWithObject | Boolean flag to determines whether the file is sent with the document it is attached to on client facing communications. Note: The SendWithObject element is only returned when using `/Associations/{ObjectId}` endpoint. |
| Name | The name of the associated file. Note: The Name element is only returned when using `/Associations/{ObjectId}` endpoint. |
| Size | The size of the associated file. Note: The Size element is only returned when using `/Associations/{ObjectId}` endpoint. |

### GET the associations for a file

`GET /Files/{FileId}/Associations`

Retrieves a list of associations for a particular file.

Example retrieving the list of associations for a file

```
GET https://api.xero.com/files.xro/1.0/Files/5364961b-6926-4847-a93e-84119545b359/Associations
```


```
{
 "FileId":"5364961b-6926-4847-a93e-84119545b359",
 "ObjectId":"47c9e6be-c07e-4230-a05b-704059cb5c86",
 "ObjectType":"AccRecCredit",
 "ObjectGroup":"CreditNote"
},
{
 "FileId":"5364961b-6926-4847-a93e-84119545b359",
 "ObjectId":"b3cba37f-8d8c-45ee-9062-9723a8681c72",
 "ObjectType":"AccRec",
 "ObjectGroup":"Invoice"
}
```


### GET the associations for an object

`GET /Associations/{ObjectId}`

Retrieves a list of associations for a particular object (e.g. invoice, contact etc)

GET Example retrieving the list of associations for a object

```
GET https://api.xero.com/files.xro/1.0/Associations/5364961b-6926-4847-a93e-84119545b359
```


```
{
 "SendWithObject":"false",
 "Name":"Test.pdf",
 "Size":"12357",
 "FileId":"a943021b-6926-4847-a93e-84119545b359",
 "ObjectId":"5364961b-6926-4847-a93e-84119545b359",
 "ObjectType":"AccRecCredit",
 "ObjectGroup":"CreditNote"
},
{
 "SendWithObject":"false",
 "Name":"Test.pdf",
 "Size":"12357",
 "FileId":"3208b31b-6926-4847-a93e-84119545b359",
 "ObjectId":"5364961b-6926-4847-a93e-84119545b359",
 "ObjectType":"AccRec",
 "ObjectGroup":"Invoice"
}
```


#### Optional parameters for GET associations for an object

|  |  |
| --- | --- |
| pagesize | Use this parameter to set the page size e.g. `GET https://…/Files?pagesize=100` . By default the page size is 50. The maximum is 100. |
| page | You can add `GET https://…/Associations/{ObjectId}?page=2` to get the next set of records. |
| sort | Sort by Name (Default) or CreatedDateUTC e.g. `GET https://…//Associations/{ObjectId}?sort=CreatedDateUtc&direction=DESC` |

GET Example retrieving the second page of a custom page size in a collection of associations which is ordered by CreatedDateUtc DESC

`GET https://…/Files?pagesize=40&page=2&sort=CreatedDateUtc&direction=DESC`

### Get the associations count for a list of objects

`GET /Associations/Count`

Retrieves a count of associations for a list of objects.

_The following element is **required** when fetching associations count_

| Parameter | Description |
| --- | --- |
| ObjectIds | A comma-separated list of object ids |

Example retrieving the list of associations for a file

```
GET https://api.xero.com/files.xro/1.0/Associations/Count?ObjectIds=a8547af2-2900-4879-98b8-f1a780c78feb,19d4fc59-e799-410f-912b-03d4ab294d73,82195976-5175-45d4-926e-807ff10892e7
```


```
{
    "19d4fc59-e799-410f-912b-03d4ab294d73": 2,
    "82195976-5175-45d4-926e-807ff10892e7": 1,
    "a8547af2-2900-4879-98b8-f1a780c78feb": 0
}
```


## POST Associations


Use this method to create associations between files and objects.

The following are **required** when creating an Association

|  |  |
| --- | --- |
| ObjectId | The identifier of the object that the file is being associated with (e.g. InvoiceID, BankTransactionID, ContactID) |
| ObjectGroup | The Object Group that the object is in. These roughly correlate to the endpoints that can be used to retrieve the object via the core accounting API. |

### Associate a file with an object

`POST /Files/{FileId}/Associations`

Associate a file with an object (e.g. an invoice)

Example of associating a file with a bank transaction

```
POST https://api.xero.com/files.xro/1.0/Files/97cdd9b2-d312-46ff-be38-2093d80ffe2e/Associations
```


```
{
 "ObjectId":"47c9e6be-c07e-4230-a05b-704059cb5c86",
 "ObjectGroup":"BankTransaction"
}
```


## DELETE Associations


Use this method to delete an Association.

Example of deleting a file

```
DELETE https://api.xero.com/files.xro/1.0/Files/488e6ba8-7e6c-4367-ba76-8ba43e42a2d3/Associations/d5c1f37c-1843-45c1-8767-e8065bc48c19
```
