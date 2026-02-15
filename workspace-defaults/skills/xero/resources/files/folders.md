# Folders

## Overview


|  |  |
| --- | --- |
| URL | [https://api.xero.com/files.xro/1.0/Folders](https://api.xero.com/files.xro/1.0/Folders) |
| Methods Supported | GET folders, GET inbox, PUT, POST, DELETE |
| Description | Allows you to retrieve, add, update and delete folders. |

## GET Folders


The following elements are returned in a Folders response

|  |  |
| --- | --- |
| Name | The name of the folder |
| FileCount | The number of files in the folder |
| Email | The email address used to email files to the inbox. Only the inbox will have this element. |
| IsInbox | Boolean to indicate if the folder is the Inbox. The Inbox cannot be renamed or deleted. |
| Id | Xero unique identifier for a folder |
| Files | The Files that are contained in the Folder. Note: The Files element is only returned when using the /Folders/{FolderId}/Files endpoint. |

### Optional parameters for GET Folders

|  |  |
| --- | --- |
| FolderId | You can specify an individual record by appending the FolderId to the endpoint, i.e. `GET https://.../Folders/{FolderId}` |
| sort | Sort by Name or CreatedDateUTC e.g. `GET https://.../Folders?sort=name%20DESC` |

Example of retrieving the list of folders

```
GET https://api.xero.com/files.xro/1.0/Folders
```


```
{
 "Name":"Inbox",
 "FileCount":0,
 "Email":"xero.inbox.dxlsh.yth06v9y5u6ak3bz@xerofiles.com",
 "IsInbox":true,
 "Id":"7215cb90-15e1-4949-9fec-690126f1f88f"
},
{
 "Name":"Contracts",
 "FileCount":1,
 "IsInbox":false,
 "Id":"0f8ccf21-7267-4268-9167-a1e2c40c84c8"
}
```


Example of retrieving a list of files in a folder

```
GET https://api.xero.com/files.xro/1.0/Folders/414b3040-2829-4385-b458-3ead98fc69ca/Files
```


```
{
 "Name":"Inbox",
 "FileCount":2,
 "Files":
  {
   "TotalCount":3,
   "Page":1,"PerPage":50,
   "Items":[
    {
     "Name":"File1.jpg",
     "MimeType":"image/jpeg",
     "Size":3615,
     "CreatedDateUtc":"2015-01-09T02:51:15.1300000",
     "UpdatedDateUtc":"2015-01-09T02:51:15.1300000",
     "User":
      {
       "Name":"a.user@email.com",
       "FirstName":"A ",
       "LastName":"User",
       "FullName":"A User",
       "Id":"4ff1e5cc-9835-40d5-bb18-09fdb118db9c"
      },
     "FolderId":"414b3040-2829-4385-b458-3ead98fc69ca",
     "Id":"41e1e2b2-f26e-4957-b204-fbceaadbfb82"
    },
    {
     "Name":"File2.jpg",
     "MimeType":"image/jpeg",
     "Size":3615,
     "CreatedDateUtc":"2015-01-09T02:51:16.2230000",
     "UpdatedDateUtc":"2015-01-09T02:51:16.2230000",
     "User":
      {
       "Name":"a.user@email.com",
       "FirstName":"A ",
       "LastName":"User",
       "FullName":"A User",
       "Id":"4ff1e5cc-9835-40d5-bb18-09fdb118db9c"
      },
     "FolderId":"414b3040-2829-4385-b458-3ead98fc69ca",
     "Id":"cced05b7-2fbb-43ba-8603-d38f81310608"
    }
   ]
  },
 "IsInbox":false,
 "Id":"414b3040-2829-4385-b458-3ead98fc69ca"
}
```


## GET Inbox


Use this method to retrieve the inbox only.

Example request to retrieve the inbox

```
GET https://api.xero.com/files.xro/1.0/Inbox
```


```
{
 "Name":"Inbox",
 "FileCount":0,
 "Email":"xero.inbox.dxlsh.yth06v9y5u6ak3bz@xerofiles.com",
 "IsInbox":true,
 "Id":"7215cb90-15e1-4949-9fec-690126f1f88f"
}
```


## POST Folders


Use this method to create folders

_The following is **required** when creating a folder_

|  |  |
| --- | --- |
| Name | The name of the folder |

Example request to create a folder

```
POST https://api.xero.com/files.xro/1.0/Folders
```


```
{"name":"New Folder"}
```


## PUT Folders


Use this method to rename folders.

_The following is **required** when updating a folder_

|  |  |
| --- | --- |
| Name | The name of the folder |

Example request to rename a folder

```
PUT https://api.xero.com/files.xro/1.0/Folders/4d9a9fdb-9c8d-423d-88d3-43b7f131c470
```


```
{"name":"New Folder Name"}
```


## DELETE Folders


Use this method to delete a folder.

`DELETE /Folders/{FolderId}`

Example of deleting a file

```
DELETE https://api.xero.com/files.xro/1.0/Folders/4d9a9fdb-9c8d-423d-88d3-43b7f131c470
```
