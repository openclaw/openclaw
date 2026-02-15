# Files

## Overview


|  |  |
| --- | --- |
| URL | [https://api.xero.com/files.xro/1.0/Files](https://api.xero.com/files.xro/1.0/Files) |
| Methods Supported | GET, POST, PUT, DELETE |
| Description | Allows you to retrieve, upload, update and delete files. |

## GET Files


The following elements are returned in the files response

|  |  |
| --- | --- |
| Name | The name of the file |
| MimeType | The Mime type of the file |
| Size | The file size in bytes |
| CreatedDateUTC | UTC timestamp of the file creation |
| UpdatedDateUTC | UTC timestamp of the last modified date |
| User | The Xero User that created the file. Note: For Files uploaded via the API this will always be "System Generated". |
| FolderId | The ID of the Folder that contains the File. |
| Id | Xero unique identifier for a file |

### Optional parameters for GET Files

|  |  |
| --- | --- |
| Record filter – FileId | You can specify an individual record by appending the FileId to the endpoint, i.e. `GET https://.../Files/{FileId}` |
| pagesize | Use this parameter to set the page size e.g. `GET https://…/Files?pagesize=100` . By default the page size is 50. The maximum is 100. |
| page | You can add `GET https://…/Files?page=2` to get the next set of records. |
| sort | Sort by Name, Size or CreatedDateUTC e.g. `GET https://…/Files?sort=CreatedDateUTC` |
| direction | Change the sort direction to ASC or DESC e.g. `GET https://…/Files?sort=CreatedDateUTC&direction=ASC` |

### GET File Content

GET Files/{FileId}/Content

Use this endpoint to download the content of a file. The response message will contain the raw file content that was originally uploaded. The response won’t contain any xml or json encoded information.

Example retrieving of a list of files

```
GET https://api.xero.com/files.xro/1.0/Files
```


```
{
 "TotalCount":2,
 "Page":1,
 "PerPage":50,
 "Items":[
  {
   "Name":"File2.jpg",
   "MimeType":"image/jpeg",
   "Size":3615,
   "CreatedDateUtc":"2014-12-04T23:08:14.0630000",
   "UpdatedDateUtc":"2014-12-04T23:08:14.0630000",
   "User":
    {
     "Name":"a.user@email.com",
     "FirstName":"A ",
     "LastName":"User",
     "FullName":"A User",
     "Id":"4ff1e5cc-9835-40d5-bb18-09fdb118db9c"
    },
   "FolderId":"0f8ccf21-7267-4268-9167-a1e2c40c84c8",
   "Id":"c8fc1b12-52ad-41e0-b76f-e01e934bea41"
  },
  {
   "Name":"File1.jpg",
   "MimeType":"image/jpeg",
   "Size":3615,
   "CreatedDateUtc":"2014-12-04T22:19:38.3200000",
   "UpdatedDateUtc":"2014-12-04T22:19:38.3200000",
   "User":
    {
     "Name":"a.user@email.com",
     "FirstName":"A ",
     "LastName":"User",
     "FullName":"A User",
     "Id":"4ff1e5cc-9835-40d5-bb18-09fdb118db9c"
    },
   "Id":"cfab685a-44e9-4439-b442-909f34c02147"
  }
 ]
}
```


## POST Files


Use this endpoint to upload files. Requests must be formatted as multipart MIME

_The following element is **required** when uploading a file and must match the name of the file itself, including extension._

|  |  |
| --- | --- |
| Name | The name of the file |

Upload a file to the inbox using the POST /Files/ endpoint or to a specific folder using POST /Files/{FolderId}. One file can be uploaded per request. The request must be multi-part MIME.

The maximum file size that can be uploaded through the API is 10 MB. See [here](https://help.xero.com/filesupload) for a list of allowed file types.

Example uploading a file using multipart MIME

```
POST https://api.xero.com/files.xro/1.0/Files
```


```
Header:
Content-Type: multipart/form-data;boundary=JLQPFBPUP0
Content-Length: 1068

Body:
--JLQPFBPUP0
Content-Disposition: form-data; name=Xero; filename=icon-small.png
Content-Type: image/png
```


## PUT Files


Use this method to rename files and move files into different folders.

_The following elements are **optional** when updating a file_

|  |  |
| --- | --- |
| Name | The name of the file |
| FolderId | The ID of the Folder that contains the File. |

Example of renaming a file

```
PUT https://api.xero.com/files.xro/1.0/Files/256b9665-690e-4b1f-adce-22fbcaf16cf4
```


```
{"Name":"New Name.jpg"}
```


Example of moving a file to a different folder

```
PUT https://api.xero.com/files.xro/1.0/Files/5984c0bf-449b-4728-840b-03e78f323b88
```


```
{"FolderId":"0f8ccf21-7267-4268-9167-a1e2c40c84c8"}
```


## DELETE Files


Use this method to delete a file.

Example of deleting a file

```
DELETE https://api.xero.com/files.xro/1.0/Files/488e6ba8-7e6c-4367-ba76-8ba43e42a2d3
```
