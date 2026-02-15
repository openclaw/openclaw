# HTTP Response Codes & Errors

## Codes Summary


A summary of HTTP Response Codes returned by the Xero API is shown below.

| HTTP Code | Summary | Description |
| --- | --- | --- |
| 200 | OK | Successful API call. Learn more |
| 400 | Bad Request | Validation exceptions have occurred or the request is invalid. Learn more |
| 401 | Unauthorized | Xero user is a non-Admin user or Payroll has not been provisioned, or this API is not available for the specified organisation. |
| 404 | Not Found | The resource you have specified cannot be found. Learn more |
| 405 | Method Not Allowed | The HTTP method is not allowed for the resource. Learn more |
| 500 | Internal Server Error | An unhandled error with the Xero API. Contact the Xero API team if problems persist |
| 503 | Service Unavailable | API is currently unavailable – typically due to a scheduled outage – try again soon. Learn more |

## Common Response Codes


### HTTP 200 OK

- The Xero API will return with a HTTP 200 for successful requests

### HTTP 400 Bad Request

- Validation exceptions have occurred


HTTP 400 response includes a 'Problem' element which contains a useful summary of the reason for the error.



```
"problem": {
          "type": "about:blank",
          "title": "BadRequest",
          "status": 400,
          "detail": "BadRequest",
          "instance": null,
          "invalidFields": [
              {
                  "name": "EmployeeID",
                  "reason": "The employee is required"
              }
          ]
}
```


- Invalid request


Example:


The request contains a non-GUID identifier (`GET https://api.xero.com/payroll.xro/2.0/employees/e549662-00f4-4502-8fd7-249bd767486X`).


The response will look like below:



```
{
     "message": "The request is invalid."
}
```



### HTTP 404 Not Found

- Example:


The request contains an identifier which does not exist (`GET https://api.xero.com/payroll.xro/2.0/employees/2e549662-00f4-4502-8fd7-249bd7674861`).


HTTP 400 response includes a 'Problem' element which contains a useful summary of the reason for the error.



```
"problem": {
          "type": "about:blank",
          "title": "NotFound",
          "status": 404,
          "detail": "Resource was not found",
          "instance": null,
          "invalidFields": null
}
```



### HTTP 405 Method Not Allowed

- Example:

`POST https://api.xero.com/payroll.xro/2.0/employees/e549662-00f4-4502-8fd7-249bd7674861`.


The response will look like below:



```
{
     "message": "The requested resource does not support http method 'POST'."
}
```



### HTTP 503 Service Unavailable

From time to time we might require a short outage to carry out maintenance or upgrades. In most cases the Xero API will respond with a HTTP 503 when it is not available, and provide one of the following response bodies:

```
The Xero API is currently offline for maintenance
```


```
The Xero API is temporarily unavailable
```
