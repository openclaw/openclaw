# Attachments

## Overview


|  |  |
| --- | --- |
| URL | [https://api.xero.com/api.xro/2.0/{Endpoint}/{Guid}/Attachments](https://api.xero.com/api.xro/2.0/%7BEndpoint%7D/%7BGuid%7D/Attachments) |
| Methods Supported | GET, PUT, POST |
| Description | Allows you to upload an attachment against an existing document Allows you to retrieve a list of attachments against a single existing document Allows you to download the content of a specific attachments. |

## GET Attachments


The GET method supports retrieving a list of attachments or receiving the content of a single attachments.

To retrieve a list of attachments that have been uploaded against a document, you will need to construct a url that contains the Guid of the parent object e.g. Invoice. This url is in the format:

```
https://api.xero.com/api.xro/2.0/{Endpoint}/{Guid}/Attachments/
```


e.g.

```
GET /api.xro/2.0/Receipts/e59a2c7f-4078-a0f3-73537afcbba9/Attachments/
Authorization: Bearer...
Accept: text/xml
```


The response message will contain an xml or json summary of the attachments against the specified document:

```
{
  "Attachments": [
    {
      "AttachmentID": "e59a2c7f-1306-4078-a0f3-73537afcbba9",
      "FileName": "Image00394.png",
      "Url": "https://api.xero.com/api.xro/2.0/Receipts/220ddca8-3144-4085-9a88-2d72c5133734/Attachments/Image00394.png",
      "MimeType": "image/png",
      "ContentLength": "10294"
    }
  ]
}
```


### GET Attachment Content

To retrieve the content of an attachment, the URL element shown in the response of a 'GET Attachments' will retrieve the file.

The url will typically be in the following format:

```
https://api.xero.com/api.xro/2.0/{Endpoint}/{Guid}/Attachments/{Filename}
```


e.g.

```
 GET /api.xro/2.0/Receipts/e59a2c7f-4078-a0f3-73537afcbba9/Attachments/Image00394.png
Authorization: Bearer...
```


The response message will contain the raw file content that was originally uploaded. The response won't contain any xml or json encoded information:

```
HTTP/1.1 200 OK
Content-Type: image/png
Content-Disposition: attachment; Image00394.png

{RAW-IMAGE-CONTENT}
```


## POST Attachments


Attachments can be uploaded to Xero using the PUT or POST method. To upload an attachment, a PUT or POST http request is made to a specific url created for the each attachment. The body of the http request contains the raw attachment content, not xml or json data that is normally used to upload data to Xero. Attachments can be uploaded to the following:

- Invoices
- Receipts
- Credit Notes
- Repeating Invoices
- Bank Transactions
- Bank Transfers
- Contacts
- Accounts
- Manual Journals
- Purchase Orders
- Quotes

When uploading an attachment to Xero, the url that you're posting to will typically be in the following format:

```
https://api.xero.com/api.xro/2.0/{Endpoint}/{Guid}/Attachments/{Filename}
```


|  |  |
| --- | --- |
| {Endpoint} | The name of the parent endpoint (e.g. Receipts, Invoices) |
| {Guid} | The guid of the document that that attachment belongs to (e.g. ReceiptID or InvoiceID) |
| {Filename} | The filename of the attachment that you are uploading. Filenames including any of the characters `<`, `>`, `:`, `"`, `/`, `\`, `|`, `?`, `*`, `\0` will be rejected as a `Bad Request`. |

**Note:** 10 attachments can be uploaded per document (each up to 10mb in size). You can replace any attachment already uploaded by specifying the URL of the existing attachment e.g. [https://api.xero.com/api.xro/2.0/{Endpoint}/{Guid}/Attachments/{Filename}](https://api.xero.com/api.xro/2.0/%7BEndpoint%7D/%7BGuid%7D/Attachments/%7BFilename%7D)

e.g.

```
POST /api.xro/2.0/Receipts/e59a2c7f-4078-a0f3-73537afcbba9/Attachments/Image00394.png
Authorization: Bearer...
Content Type: image/png
Content-Length: 10495
Accept: text/xml

{RAW-IMAGE-CONTENT}
```


The response message will contain a summary of the attachment that has been accepted into the API:

```
{
  "Attachments": [
    {
      "AttachmentID": "e59a2c7f-1306-4078-a0f3-73537afcbba9",
      "FileName": "Image00394.png",
      "Url": "https://api.xero.com/api.xro/2.0/Receipts/e59a2c7f-4078-a0f3-73537afcbba9/Attachments/Image00394.png",
      "MimeType": "image/png",
      "ContentLength": "10294"
    }
  ]
}
```


### Include with Online Invoice

You can set an attachment to be included with the invoice when viewed online (through Xero). This functionality is available for accounts receivable invoices and accounts receivable credit notes. To enable an attachment to be viewed with the online invoice add the parameter IncludeOnline=true to the end of your request.

e.g.

```
POST /api.xro/2.0/Invoices/e59a2c7f-4078-a0f3-73537afcbba9/Attachments/Image00394.png?IncludeOnline=true
Authorization: Bearer...
Content Type: image/png
Content-Length: 10495
Accept: text/xml

{RAW-IMAGE-CONTENT}
```


If you have set IncludeOnline to true, the element will be returned in the response message:

```
{
  "Attachments": [
    {
      "AttachmentID": "e59a2c7f-1306-4078-a0f3-73537afcbba9",
      "FileName": "Image00394.png",
      "Url": "https://api.xero.com/api.xro/2.0/Receipts/e59a2c7f-4078-a0f3-73537afcbba9/Attachments/Image00394.png",
      "MimeType": "image/png",
      "ContentLength": "10294",
      "IncludeOnline" : true
    }
  ]
}
```


## PUT Attachments


The PUT method is identical to the POST method. If an attachment already exists on the specified document, then the attachment being uploaded will overwrite it.

**Note:** When the file name includes special characters, the characters should not be encoded unless they're brackets. Brackets must be encoded in order for the call to go through, and all other characters must be unencoded.
