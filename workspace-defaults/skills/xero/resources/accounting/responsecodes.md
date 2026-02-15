# HTTP Response Codes & Errors

## Codes summary


A summary of HTTP Response Codes returned by the Xero API is shown below.

| HTTP Code | Summary | Description |
| --- | --- | --- |
| 200 | OK | Successful API call. |
| 400 | Bad Request | A validation exception has occurred. |
| 401 | Unauthorized | Invalid authorization credentials. |
| 403 | Not Permitted | User doesn't have permission to access the resource. |
| 404 | Not Found | The resource you have specified cannot be found |
| 412 | Precondition Failed | One or more conditions given in the request header fields were invalid. This code will also be returned if you're using TLS1.0 |
| 429 | Rate Limit Exceeded | The API rate limit for your organisation/application pairing has been exceeded. Learn more |
| 500 | Internal Error | An unhandled error with the Xero API. Contact the Xero API team if problems persist |
| 501 | Not Implemented | The method you have called has not been implemented (e.g. POST Organisation |
| 503 | Not Available | API is currently unavailable – typically due to a scheduled outage – try again soon. |
| 503 | Organisation offline | The organisation temporarily cannot be connected to. |

## Common response codes


### HTTP 200 OK

- The Xero API will return with a HTTP 200 for successful requests
- If you are utlilising the summarizeErrors=false querystring parameter you’ll always receive a HTTP 200 response even though some of the elements may have failed. Learn more

### HTTP 400 Bad Request

HTTP 400 responses include an “ApiException" element in the response that contains a useful summary of the reason for the error.

```
{
  "ErrorNumber": 10,
  "Type": "ValidationException",
  "Message": "A validation exception occurred",
  "Elements": [{
    "ValidationErrors": [{
      "Message": "Email address must be valid"
    }]
  }]
}
```


### HTTP 401 Unauthorized

A customer may disconnect your application from within Xero at anytime so at the very least you should implement functionality to handle a 401 error and allow a customer to easily reauthorize your application.

Learn more about limits

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
