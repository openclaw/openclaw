# HTTP Response Codes & Errors

## Codes summary


A summary of HTTP Response Codes returned by the Projects API is shown below.

| HTTP Code | Summary | Description |
| --- | --- | --- |
| 200 | OK | Successful API call. |
| 201 | Created | Resource Created. |
| 204 | No Content | The server has successfully fulfilled the request and that there is no additional content to send in the response. |
| 400 | Bad Request | A bad request or a validation exception has occurred. |
| 401 | Unauthorized | Invalid authorization credentials or organisation hasn’t been provisioned in Xero Projects. |
| 404 | Not Found | The resource you have specified cannot be found |
| 500 | Internal Error | An unhandled error with the Xero API. Contact the Xero API team if problems persist |
| 503 | Rate Limit Exceeded | The API rate limit for your organisation/application pairing has been exceeded. |
| 503 | Not Available | API is currently unavailable – typically due to a scheduled outage – try again soon. |

## Common response codes


### HTTP 2xx OK

The Projects API will return with a:

- HTTP 200 for successful GETS
- HTTP 201 for successful modifications with content in the response, and
HTTP 204 for successful requests with no content

### HTTP 400 Bad Request

HTTP 400 responses includes a "message" describing the error and a modelState object describing which elements of the request caused the error.

```
{
  "message": "The request is invalid.",
  "modelState": {
    "model.Name": [
      "The Project Name cannot be empty"
    ],
    "model.ContactId": [
      "The ContactId cannot be null or empty"
    ]
  }
}
```


### HTTP 503 Not Available

From time to time we might require a short outage to carry out maintenance or upgrades. In most cases the Xero API will respond with a HTTP 503 when it is not available, and provide one of the following response bodies:

```
The Xero API is currently offline for maintenance
```


```
The Xero API is temporarily unavailable
```


### HTTP 503 Organisation Offline

A specific organisation may not be available though the Xero APIs themselves are online. In this instance, the below response will be returned. Typically this situation may occur for several minutes. A retry interval of 5mins or so is recommended.

```
The Organisation is offline
```
