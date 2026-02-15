# Xero Practice Manager API

## Overview


[Xero Practice Manager](https://www.xero.com/features-and-tools/practice-tools/practicemanager/) is a total practice solution that helps accountants manage their practice's workflow, time tracking and job costing.

## Authentication


All new connections to the Practice Manager API must use OAuth 2.0. Create a connection to a Practice Manager account by selecting a Practice Manager scope.

## Security Requirements


To meet compliance rules that are being set out by tax offices around the world and to continue leading in best practice, we’re implementing new global security standards for digital services providers with add-on marketplaces. You can read more about what will be required [here](https://devblog.xero.com/were-raising-our-platform-s-global-security-standards-9a058311943d).

To access the Practice Manager API you will need to first register as an app partner and complete a security self-assessment questionnaire. Your app won't be able to request Practice Manager scopes until you've started this process.

## URLs


The base url for all Practice Manager endpoints is [https://api.xero.com/practicemanager/3.1/](https://api.xero.com/practicemanager/3.1/)

e.g. The URL to retrieve a list of clients is GET [https://api.xero.com/practicemanager/3.1/client.api/list](https://api.xero.com/practicemanager/3.1/client.api/list)

## Versions


This documentation is for latest version of the API – version 3.1

Version 3.1 replaces Integer Identifiers (eg "get/123") with UUID Identifiers (eg get/1cd06260-aacc-4634-b605-4d916d72053d)

## Verbs


- \[GET\] Used for retrieving resources.
- \[POST\] Used for creating resources.
- \[PUT\] Used for updating resources.
- \[DELETE\] Used for deleting resources.

## API Responses


Every request irrespective of the input content type will return an XML response (content type text/xml). If an application exception occurs during the execution of the request then the server will respond with an HTTP status code 500, however some requests will respond with an HTTP status code of 200 even if errors have occurred during the processing of the document. 200 OK is the default status code for any successful request.

The response for a successful request will look similar to the following:

```
<Response>
    <Status>OK</Status>
    <!-- if GET request then information requested will follow -->
</Response>
```


If an error occurs during the request, the following response will be returned:

```
<Response>
    <Status>ERROR</Status>
    <ErrorDescription>A detailed explanation of the error</ErrorDescription>
</Response>
```
