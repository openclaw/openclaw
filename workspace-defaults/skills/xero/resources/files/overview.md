# Overview

_Current Version : v1.03 Last Updated : April 19, 2016 ( release notes)_

The Files API provides access to the files, folders, and the association of files within a Xero organisation. It can be used to upload/download files, manage folders and associate files to invoices, contacts, payments etc.

## Permissions


All API applications have access to the Files API.

## Requests and Responses


The files API will accept requests in either JSON or XML. Responses will be in JSON by default but XML can be requested by setting the “Accept” value in the http header to “application/xml” when making a request.

## URLs


The base url for all files endpoints is [https://api.xero.com/files.xro/1.0/](https://api.xero.com/files.xro/1.0/)

e.g. The URL for the Folders endpoint is [https://api.xero.com/files.xro/1.0/Folders](https://api.xero.com/files.xro/1.0/Folders)

### Versions

The Files API is currently version 1.0 and may be updated separately to the Core API. Please see the Files API release notes for the latest improvements.
