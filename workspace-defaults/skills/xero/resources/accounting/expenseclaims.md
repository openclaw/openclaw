# Expense Claims (Deprecated)


**Important Update – October 2018:** Last year, we announced the arrival of our new [Xero Expenses](https://www.xero.com/blog/2017/09/say-hello-new-xero-expense-claims/) product. Access to classic expense claims functionality is only available to customers who used it in the 6 months prior to 10 July 2018.

If you're planning on building a new expenses integration we suggest you create ACCPAY Invoices (bills) in Xero instead of using ExpenseClaims and Receipts.

## Overview


|  |  |
| --- | --- |
| URL | [https://api.xero.com/api.xro/2.0/ExpenseClaims](https://api.xero.com/api.xro/2.0/ExpenseClaims) |
| Methods Supported | GET, PUT, POST |
| Description | Allows you to submit expense claims for approval <br>Allows you to retrieve expense claims to see their status <br>Allows you to retrieve history <br>Allows you to add notes |

## GET ExpenseClaims


Use this method to retrieve either one or many expense claims.

### Elements for an expense claim

|  |  |
| --- | --- |
| User | See Users |
| Receipts | See Receipts |
| ExpenseClaimID | Xero generated identifier for an expense claim (unique within organisations) |
| Payments | See Payments |
| Status | Current status of an expense claim – see status types |
| UpdatedDateUTC | Last modified date UTC format |
| Total | The total of an expense claim being paid |
| AmountDue | The amount due to be paid for an expense claim |
| AmountPaid | The amount still to pay for an expense claim |
| PaymentDueDate | The date when the expense claim is due to be paid YYYY-MM-DD |
| ReportingDate | The date the expense claim will be reported in Xero YYYY-MM-DD |

### Optional parameters

|  |  |
| --- | --- |
| ExpenseClaimID | You can specify an individual record by appending the ExpenseClaimID to the endpoint, i.e. `GET https://.../ExpenseClaims/{identifier}` |
| Modified After | The ModifiedAfter filter is actually an HTTP header: ' **If-Modified-Since**'. A UTC timestamp (yyyy-mm-ddThh:mm:ss) . Only receipts created or modified since this timestamp will be returned e.g. 2009-11-12T00:00:00 |
| Where | Filter by an any element ( _see Filters_ ) |
| order | Order by any element returned ( _see Order By_ ) |

Example response for retrieving an individual ExpenseClaim

```
GET https://api.xero.com/api.xro/2.0/ExpenseClaims/0b44a210-b9eb-447a-8c7b-fe5e7e40f25c
```


```
{
  "ExpenseClaims": [
    {
      "ExpenseClaimID": "0b44a210-b9eb-447a-8c7b-fe5e7e40f25c",
      "Status": "PAID",
      "UpdatedDateUTC": "\/Date(1222340661707+0000)\/",
      "User": {
        "UserID": "d6362594-ffec-4435-abe8-469941ff1501",
        "FirstName": "Joe",
        "LastName": "Bloggs",
        "UpdatedDateUTC": "\/Date(1222340661707+0000)\/",
        "IsSubscriber": "false",
        "OrganisationRole": "FINANCIALADVISER"
      },
      "Receipts": [
        {
          "ReceiptID": "4dfefee8-15c3-4c30-ba0a-cb78d96d709a",
          "ReceiptNumber": "2",
          "Status": "AUTHORISED",
          "User": {
            "UserID": "d6362594-ffec-4435-abe8-469941ff1501",
            "FirstName": "Joe",
            "LastName": "Bloggs",
            "UpdatedDateUTC": "\/Date(1222340661707+0000)\/",
            "IsSubscriber": "false",
            "OrganisationRole": "FINANCIALADVISER"
          },
          "Contact": {
            "ContactID": "827deebb-d4dd-4b52-933f-851631ab93c4",
            "Name": "Coco Cafe"
          },
          "Date": "2013-10-11T00:00:00",
          "UpdatedDateUTC": "\/Date(1222340661707+0000)\/",
          "Reference": "MRE 08",
          "LineAmountTypes": "Inclusive",
          "LineItems": [
            {
              "Description": "Breakfast before MRE conference",
              "UnitAmount": "16.90",
              "TaxType": "NONE",
              "TaxAmount": "0.00",
              "LineAmount": "16.90",
              "AccountCode": "684",
              "Quantity": "1.0000"
            }
          ],
          "SubTotal": "16.90",
          "TotalTax": "0.00",
          "Total": "16.90",
          "HasAttachments": "false"
        },
        {
          "ReceiptID": "5c578500-d093-4a29-9dc4-ff6c9c74b72d",
          "ReceiptNumber": "1",
          "Status": "AUTHORISED",
          "User": {
            "UserID": "d6362594-ffec-4435-abe8-469941ff1501",
            "FirstName": "Joe",
            "LastName": "Bloggs",
            "UpdatedDateUTC": "\/Date(1222340661707+0000)\/",
            "IsSubscriber": "false",
            "OrganisationRole": "FINANCIALADVISER"
          },
          "Contact": {
            "ContactID": "b89da77c-1a13-4893-8d65-71cd38fc623a",
            "Name": "Fulton Airport Parking"
          },
          "Date": "\/Date(1222340661707+0000)\/",
          "UpdatedDateUTC": "\/Date(1222340661707+0000)\/",
          "Reference": "MRE 08",
          "LineAmountTypes": "Inclusive",
          "LineItems": [
            {
              "Description": "Parking for MRE conference",
              "UnitAmount": "18.00",
              "TaxType": "NONE",
              "TaxAmount": "0.00",
              "LineAmount": "18.00",
              "AccountCode": "684",
              "Quantity": "1.0000"
            }
          ],
          "SubTotal": "18.00",
          "TotalTax": "0.00",
          "Total": "18.00",
          "HasAttachments": "false"
        }
      ],
      "Payments": [
        {
          "Date": "\/Date(1222340661707+0000)\/",
          "Amount": "34.90",
          "Reference": "FP101897",
          "Account": {
            "AccountID": "ceef66a5-a545-413b-9312-78a53caadbc4",
            "Code": "090",
            "Name": "Checking Account"
          }
        }
      ],
      "Total": "34.90",
      "AmountDue": "0.00",
      "AmountPaid": "34.90",
      "PaymentDueDate": "\/Date(1222340661707+0000)\/",
      "ReportingDate": "\/Date(1222340661707+0000)\/"
    }
  ]
}
```


Example response when retrieving a collection of expense claims

```
GET https://api.xero.com/api.xro/2.0/ExpenseClaims
```


```
{
  "ExpenseClaims": [
    {
      "ExpenseClaimID": "0b44a210-b9eb-447a-8c7b-fe5e7e40f25c",
      "Status": "PAID",
      "UpdatedDateUTC": "\/Date(1222340661707+0000)\/",
      "User": {
        "UserID": "d6362594-ffec-4435-abe8-469941ff1501",
        "FirstName": "Joe",
        "LastName": "Bloggs",
        "UpdatedDateUTC": "\/Date(1222340661707+0000)\/",
        "IsSubscriber": "false",
        "OrganisationRole": "FINANCIALADVISER"
      },
      "Total": "34.90",
      "AmountDue": "0.00",
      "AmountPaid": "34.90",
      "PaymentDueDate": "\/Date(1222340661707+0000)\/",
      "ReportingDate": "\/Date(1222340661707+0000)\/"
    },{
      "ExpenseClaimID": "fb0372d7-4d35-4b99-89e1-8dc0fff13cae",
      "Status": "PAID",
      "UpdatedDateUTC": "\/Date(1222340661707+0000)\/",
      "User": {
        "UserID": "d6362594-ffec-4435-abe8-469941ff1501",
        "FirstName": "Joe",
        "LastName": "Bloggs",
        "UpdatedDateUTC": "\/Date(1222340661707+0000)\/",
        "IsSubscriber": "false",
        "OrganisationRole": "FINANCIALADVISER"
      },
      "Total": "29.50",
      "AmountDue": "0.00",
      "AmountPaid": "29.50",
      "PaymentDueDate": "\/Date(1222340661707+0000)\/",
      "ReportingDate": "\/Date(1222340661707+0000)\/"
    }
  ]
}
```


## POST ExpenseClaims


Use this method to submit one or many expense claims.

Note that you cannot pay an expense claim via the Xero API. Payment needs to be done in the Xero app.

### Elements for creating/updating expense claims

_The following are **mandatory** for a PUT / POST request_

|  |  |
| --- | --- |
| User | See Users |
| Receipts | See Receipts |

_The following are **optional** for a POST request_

|  |  |
| --- | --- |
| Status | Current status of an expense claim – see status types |

The Receipts element can contain one or more Receipt sub-elements. At least _**one**_ valid receipt element is required to create an expense claim.

_The following elements are **required** to submit a complete receipt_

|  |  |
| --- | --- |
| ReceiptID | The Xero identifier for the Receipt e.g. e59a2c7f-1306-4078-a0f3-73537afcbba9 |

Example of minimum elements required to submit an expense claim for a user with two receipts.

```
POST https://api.xero.com/api.xro/2.0/ExpenseClaims
```


```
{
  "ExpenseClaims": [
    {
      "User": {
        "UserID": "7cf47fe2-c3dd-4c6b-9895-7ba767ba529c"
      },
      "Receipts": [
        {
          "ReceiptID": "06f6fd50-97e6-40ac-94b0-d5215d836905"
        },
        {
          "ReceiptID": "5b7ddbb1-a0cf-4c3b-860d-a4521f3f4599"
        }
      ]
    }
  ]
}
```


Example of updating the status of an expense claim

```
POST https://api.xero.com/api.xro/2.0/ExpenseClaims/e59a2c7f-1306-4078-a0f3-73537afcbba9
```


```
{
  "ExpenseClaimID": "e59a2c7f-1306-4078-a0f3-73537afcbba9",
  "Status": "AUTHORISED"
}
```


Example of voiding an expense claim

```
POST https://api.xero.com/api.xro/2.0/ExpenseClaims/e59a2c7f-1306-4078-a0f3-73537afcbba9
```


```
{
  "ExpenseClaimID": "e59a2c7f-1306-4078-a0f3-73537afcbba9",
  "Status": "VOIDED"
}
```


## PUT ExpenseClaims


The PUT method is similar to the POST ExpenseClaims method however you can only create expense claims with this method.

### SummarizeErrors

If you are entering many expense claims in a single API call then we recommend you utilise our new response format that shows validation errors for each receipt. The new response messages for validating bulk API calls would mean a breaking change so to utilise this functionality you'll need to append `?SummarizeErrors=false` to the end of your API calls.

Note that each ExpenseClaim is now returned with a status element which will either contain the value `OK` or `ERROR`. If a receipt has a error then one or more validation errors will be returned.

Example of the SummarizeErrors response format

```
POST https://api.xero.com/api.xro/2.0/ExpenseClaims?SummarizeErrors=false
```


```
{
  "ExpenseClaims": [
    {
      "ExpenseClaimID": "5ceffde5-6786-4987-b03a-bf88d262c286",
      ...
      "StatusAttributeString": "OK"
    },
    {
      "ExpenseClaimID": "5ceffde5-6786-4987-b03a-bf88d262c286",
      ...
      "StatusAttributeString": "OK"
    },
    {
      "ExpenseClaimID": "5ceffde5-6786-4987-b03a-bf88d262c286",
      ...
      "StatusAttributeString": "WARNING",
      "Warnings": [
        {
          "Message": "Error message"
        }
      ]
    },
    {
      "ExpenseClaimID": "5ceffde5-6786-4987-b03a-bf88d262c286",
      ...
      "StatusAttributeString": "ERROR",
      "ValidationErrors": [
        {
          "Description": "Error message"
        }
      ]
    }
  ]
}
```


### Retrieving History

View a summary of the actions made by all users to the expense claim. See the History and Notes page for more details.

Example of retrieving a expense claim's history

```
GET https://api.xero.com/api.xro/2.0/ExpenseClaims/{Guid}/History
```


```
{
  "HistoryRecords": [
     {
      "Changes": "Updated",
      "DateUTCString": "2018-02-28T21:02:11",
      "DateUTC": "\/Date(1519851731990+0000)\/",
      "User": "System Generated",
      "Details": "Received through the Xero API from ABC Org"
    },
    {
      "Changes": "Created",
      "DateUTCString": "2018-02-28T21:01:29",
      "DateUTC": "\/Date(1519851689297+0000)\/",
      "User": "Mac Haag",
      "Details": "INV-0041 to ABC Furniture for 100.00."
    }
    ...
  ]
}
```


### Add Notes to an Expense Claim

Add a note which will appear in the history against an expense claim. See the History and Notes page for more details.

Example of creating a note against a expense claim

```
PUT https://api.xero.com/api.xro/2.0/ExpenseClaims/{Guid}/History
```


```
{
  "HistoryRecords": [
    {
      "Details": "Note added by your favourite app!"
    }
    ...
  ]
}
```
